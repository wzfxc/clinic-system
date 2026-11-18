/**
 * Idempotent confirmation (docs/analysis/03, "Ідемпотентність підтвердження").
 * The idempotency row is written in the same transaction as the status change, so a key
 * never exists without its effect. A deterministic refusal (hold expired, not found) is
 * stored too and committed, which is why failures are returned as values and thrown by
 * the caller only after COMMIT.
 */
import { createHash } from 'node:crypto';
import type { Clock } from '../clock.js';
import type { ErrorCode } from '../errors.js';
import { IDEMPOTENCY_TTL_HOURS } from '../rules.js';
import {
  APPOINTMENT_COLUMNS,
  applyActor,
  lockPatient,
  toAppointment,
  type Actor,
  type Appointment,
  type AppointmentRow,
} from './appointment.js';
import { HOUR_MS } from './time.js';
import { BookingError, type Tx } from './tx.js';

export const CONFIRM_SCOPE = 'confirm_appointment';

export interface ConfirmInput {
  appointmentId: number;
  patientId: number;
  /** Client-generated, one per confirmation attempt. */
  idempotencyKey: string;
  actor?: Actor;
}

export type ConfirmOutcome = { ok: true; appointment: Appointment } | { ok: false; error: BookingError };

type StoredResponse = { ok: true; appointmentId: number } | { ok: false; code: ErrorCode };

const requestHash = (input: ConfirmInput): string =>
  createHash('sha256')
    .update(JSON.stringify({ appointmentId: input.appointmentId, patientId: input.patientId }))
    .digest('hex');

async function loadAppointment(tx: Tx, id: number): Promise<Appointment | null> {
  const { rows } = await tx.query<AppointmentRow>(`SELECT ${APPOINTMENT_COLUMNS} FROM appointments WHERE id = $1`, [id]);
  const row = rows[0];
  return row ? toAppointment(row) : null;
}

async function replay(tx: Tx, stored: StoredResponse): Promise<ConfirmOutcome> {
  if (!stored.ok) return { ok: false, error: new BookingError(stored.code) };
  const appointment = await loadAppointment(tx, stored.appointmentId);
  if (!appointment) return { ok: false, error: new BookingError('HOLD_NOT_FOUND') };
  // The record is returned as it is now, but a replay must not report success for a booking that
  // has since been cancelled.
  if (appointment.status === 'cancelled' || appointment.status === 'held') {
    return { ok: false, error: new BookingError('INVALID_STATUS_TRANSITION') };
  }
  return { ok: true, appointment };
}

/** A cancelled row counts as an expired hold only if the hold itself was dropped (expiry or replacement). */
async function wasHoldReleased(tx: Tx, id: number): Promise<boolean> {
  const { rows } = await tx.query<{ cancel_reason: string | null }>(
    `SELECT cancel_reason FROM appointments WHERE id = $1`,
    [id],
  );
  const reason = rows[0]?.cancel_reason;
  return reason === 'hold_expired' || reason === 'checkout_replaced';
}

/** The state change itself; `held` to `booked` only while the hold is still alive. */
async function confirmHold(tx: Tx, clock: Clock, input: ConfirmInput): Promise<ConfirmOutcome> {
  const now = clock.now();
  const updated = await tx.query<AppointmentRow>(
    `UPDATE appointments
        SET status = 'booked', hold_kind = NULL, hold_expires_at = NULL, updated_at = $3
      WHERE id = $1 AND patient_id = $2 AND status = 'held' AND hold_expires_at > $3
      RETURNING ${APPOINTMENT_COLUMNS}`,
    [input.appointmentId, input.patientId, now],
  );
  const row = updated.rows[0];
  if (row) return { ok: true, appointment: toAppointment(row) };

  const current = await loadAppointment(tx, input.appointmentId);
  if (current === null || current.patientId !== input.patientId) {
    return { ok: false, error: new BookingError('HOLD_NOT_FOUND') };
  }
  if (current.status === 'booked') return { ok: true, appointment: current }; // already confirmed (Q7)
  if (current.status === 'held' || (current.status === 'cancelled' && (await wasHoldReleased(tx, current.id)))) {
    return { ok: false, error: new BookingError('HOLD_EXPIRED') };
  }
  return { ok: false, error: new BookingError('INVALID_STATUS_TRANSITION') };
}

export async function confirmAppointment(tx: Tx, clock: Clock, input: ConfirmInput): Promise<ConfirmOutcome> {
  const now = clock.now();
  await applyActor(tx, input.actor);
  await lockPatient(tx, input.patientId);

  const hash = requestHash(input);
  const keyParams = [CONFIRM_SCOPE, input.patientId, input.idempotencyKey];
  await tx.query(
    `DELETE FROM idempotency_keys WHERE scope = $1 AND actor_id = $2 AND key = $3 AND expires_at <= $4`,
    [...keyParams, now],
  );
  const claimed = await tx.query(
    `INSERT INTO idempotency_keys (scope, actor_id, key, request_hash, response, created_at, expires_at)
     VALUES ($1, $2, $3, $4, '{"pending":true}'::jsonb, $5, $6)
     ON CONFLICT (scope, actor_id, key) DO NOTHING`,
    [...keyParams, hash, now, new Date(now.getTime() + IDEMPOTENCY_TTL_HOURS * HOUR_MS)],
  );

  if (claimed.rowCount === 0) {
    const { rows } = await tx.query<{ request_hash: string; response: StoredResponse }>(
      `SELECT request_hash, response FROM idempotency_keys WHERE scope = $1 AND actor_id = $2 AND key = $3 FOR UPDATE`,
      keyParams,
    );
    const existing = rows[0];
    if (!existing) throw new Error('idempotency key vanished between INSERT and SELECT');
    if (existing.request_hash !== hash) throw new BookingError('IDEMPOTENCY_KEY_REUSED');
    return replay(tx, existing.response);
  }

  const outcome = await confirmHold(tx, clock, input);
  const response: StoredResponse = outcome.ok
    ? { ok: true, appointmentId: outcome.appointment.id }
    : { ok: false, code: outcome.error.code };
  await tx.query(
    `UPDATE idempotency_keys SET response = $4::jsonb WHERE scope = $1 AND actor_id = $2 AND key = $3`,
    [...keyParams, JSON.stringify(response)],
  );
  return outcome;
}
