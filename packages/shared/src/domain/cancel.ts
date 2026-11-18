/**
 * Cancellation (docs/analysis/03, "Ліміти й блокування"; 00-decisions R1). A cancel is a status
 * change, never a DELETE. At most 24 hours before the start it is late (exactly 24:00:00 included)
 * and counts as a strike through the history trigger; the same instant rule is `isLateCancellation`.
 */
import type { Clock } from '../clock.js';
import { FREE_CANCEL_HOURS } from '../rules.js';
import { assertCanManageBooking, type AuthActor } from './actor.js';
import {
  APPOINTMENT_COLUMNS,
  applyActor,
  lockAppointment,
  toAppointment,
  type Appointment,
  type AppointmentRow,
} from './appointment.js';
import { DEFAULT_HOOKS, type DomainHooks, type FreedInterval, type FreedReason } from './hooks.js';
import { HOUR_MS } from './time.js';
import { BookingError, type Tx } from './tx.js';

/** Reasons the system writes itself; a caller must not use them, or a late cancel would dodge the strike. */
const RESERVED_REASONS: ReadonlySet<string> = new Set(['sick_leave', 'checkout_replaced', 'hold_expired']);
const MAX_REASON_LENGTH = 500;

/** Late means at most 24 hours before the start; the free window is strictly longer. */
export function isLateCancellation(startsAt: Date, now: Date): boolean {
  return startsAt.getTime() - now.getTime() <= FREE_CANCEL_HOURS * HOUR_MS;
}

export interface CancelInput {
  appointmentId: number;
  actor: AuthActor;
  reason: string;
}

export interface CancelResult {
  appointment: Appointment;
  /** True when a booked visit was cancelled at most 24 hours before it (a strike). */
  late: boolean;
}

export function validateCancelReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed === '' || trimmed.length > MAX_REASON_LENGTH || RESERVED_REASONS.has(trimmed)) {
    throw new BookingError('VALIDATION_FAILED', 'invalid cancellation reason');
  }
  return trimmed;
}

export function freedIntervalOf(a: Appointment, reason: FreedReason): FreedInterval {
  return {
    doctorId: a.doctorId,
    clinicId: a.clinicId,
    serviceId: a.serviceId,
    patientId: a.patientId,
    usesUltrasoundRoom: a.usesUltrasoundRoom,
    start: a.startsAt,
    end: a.blockedUntil,
    reason,
  };
}

export async function cancelAppointment(
  tx: Tx,
  clock: Clock,
  input: CancelInput,
  hooks: DomainHooks = DEFAULT_HOOKS,
): Promise<CancelResult> {
  const now = clock.now();
  const reason = validateCancelReason(input.reason);
  await applyActor(tx, input.actor);
  const current = await lockAppointment(tx, input.appointmentId, (a) => assertCanManageBooking(input.actor, a));

  if ((current.status !== 'held' && current.status !== 'booked') || current.startsAt <= now) {
    throw new BookingError('INVALID_STATUS_TRANSITION', `cannot cancel a ${current.status} appointment`);
  }
  const late = current.status === 'booked' && isLateCancellation(current.startsAt, now);

  const { rows } = await tx.query<AppointmentRow>(
    `UPDATE appointments
        SET status = 'cancelled', cancel_reason = $2, hold_kind = NULL, hold_expires_at = NULL, updated_at = $3
      WHERE id = $1 AND status = $4
      RETURNING ${APPOINTMENT_COLUMNS}`,
    [current.id, reason, now, current.status],
  );
  const row = rows[0];
  if (!row) throw new BookingError('INVALID_STATUS_TRANSITION'); // unreachable under the row lock
  await hooks.onSlotsFreed(tx, [freedIntervalOf(current, 'cancelled')], clock);
  return { appointment: toAppointment(row), late };
}
