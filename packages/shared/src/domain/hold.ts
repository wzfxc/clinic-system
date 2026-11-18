/**
 * Checkout hold (docs/analysis/03, 00-decisions D2). Lock order, always:
 * patient row, doctor advisory lock, ultrasound-room advisory lock. Expired
 * checkout holds are reaped on write, so correctness never depends on Redis.
 */
import type { Clock } from '../clock.js';
import { HOLD_TTL_MINUTES, PREP_BUFFER_MINUTES } from '../rules.js';
import {
  APPOINTMENT_COLUMNS,
  applyActor,
  lockPatient,
  toAppointment,
  type Actor,
  type Appointment,
  type AppointmentRow,
  type BookingChannel,
} from './appointment.js';
import { isGridStart, isWithinBookingWindow } from './slots.js';
import { loadClinicService, loadSchedules, type ClinicService } from './slots-repo.js';
import { localDateOf, MINUTE_MS } from './time.js';
import { BookingError, type Tx } from './tx.js';

export interface HoldInput {
  patientId: number;
  doctorId: number;
  clinicId: number;
  serviceId: number;
  startsAt: Date;
  channel: BookingChannel;
  actor?: Actor;
}

/** Frees the patient's own checkout holds, live or expired, without regard to overlap (D2). */
export async function releaseOwnCheckoutHolds(tx: Tx, clock: Clock, patientId: number): Promise<number> {
  const now = clock.now();
  const { rowCount } = await tx.query(
    `UPDATE appointments
        SET status = 'cancelled',
            cancel_reason = CASE WHEN hold_expires_at <= $2 THEN 'hold_expired' ELSE 'checkout_replaced' END,
            hold_kind = NULL, hold_expires_at = NULL, updated_at = $2
      WHERE patient_id = $1 AND status = 'held' AND hold_kind = 'checkout'`,
    [patientId, now],
  );
  return rowCount ?? 0;
}

export interface ReapScope {
  doctorId: number;
  clinicId: number;
  usesUltrasoundRoom: boolean;
  range: { start: Date; end: Date };
}

/**
 * Cancels other people's expired checkout holds that overlap `range` for the doctor and,
 * for ultrasound services, for the clinic room. Waitlist offers are never touched here (R2).
 * Callers hold the doctor (and room) advisory locks.
 */
export async function reapExpiredCheckoutHolds(tx: Tx, clock: Clock, scope: ReapScope): Promise<number> {
  const now = clock.now();
  const { start, end } = scope.range;
  // One statement per resource so each can use its partial gist index; candidates are locked
  // in id order so two concurrent reapers cannot deadlock on each other's rows.
  const reap = async (resourcePredicate: string, resourceParams: unknown[]): Promise<number> => {
    const { rowCount } = await tx.query(
      `WITH candidates AS (
         SELECT id FROM appointments
          WHERE status = 'held' AND hold_kind = 'checkout' AND hold_expires_at <= $1
            AND ${resourcePredicate}
            AND tstzrange(starts_at, blocked_until, '[)') && tstzrange($2, $3, '[)')
          ORDER BY id FOR UPDATE)
       UPDATE appointments a
          SET status = 'cancelled', cancel_reason = 'hold_expired',
              hold_kind = NULL, hold_expires_at = NULL, updated_at = $1
         FROM candidates c WHERE a.id = c.id`,
      [now, start, end, ...resourceParams],
    );
    return rowCount ?? 0;
  };
  const byDoctor = await reap('doctor_id = $4', [scope.doctorId]);
  if (!scope.usesUltrasoundRoom) return byDoctor;
  return byDoctor + (await reap('uses_ultrasound_room AND clinic_id = $4', [scope.clinicId]));
}

/** Transaction-scoped advisory lock; the key is hashed so ids of different kinds never collide. */
async function advisoryLock(tx: Tx, key: string): Promise<void> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);
}

async function assertDoctorOffers(tx: Tx, input: HoldInput): Promise<void> {
  const { rowCount } = await tx.query(
    `SELECT 1 FROM doctor_clinics dc
       JOIN doctor_services ds ON ds.doctor_id = dc.doctor_id
      WHERE dc.doctor_id = $1 AND dc.clinic_id = $2 AND ds.service_id = $3`,
    [input.doctorId, input.clinicId, input.serviceId],
  );
  if (rowCount === 0) throw new BookingError('SERVICE_NOT_PROVIDED');
}

async function assertSlotAllowed(tx: Tx, now: Date, input: HoldInput, service: ClinicService): Promise<void> {
  if (!isWithinBookingWindow(now, service.timezone, input.startsAt)) throw new BookingError('SLOT_OUT_OF_WINDOW');
  const date = localDateOf(input.startsAt, service.timezone);
  const [schedule] = await loadSchedules(tx, input.clinicId, [input.doctorId], date, date);
  if (!schedule || !isGridStart(schedule, service.timezone, input.startsAt, service.durationMinutes)) {
    throw new BookingError('OUTSIDE_WORKING_HOURS');
  }
}

/** Creates a `held` appointment; throws BookingError and leaves nothing behind on any refusal. */
export async function holdAppointment(tx: Tx, clock: Clock, input: HoldInput): Promise<Appointment> {
  const now = clock.now();
  await applyActor(tx, input.actor);

  const patient = await lockPatient(tx, input.patientId);
  await releaseOwnCheckoutHolds(tx, clock, input.patientId);

  if (input.channel === 'online' && patient.onlineBookingBlockedUntil !== null && patient.onlineBookingBlockedUntil > now) {
    throw new BookingError('ONLINE_BOOKING_BLOCKED', 'online booking is blocked', {
      blockedUntil: patient.onlineBookingBlockedUntil.toISOString(),
    });
  }
  const service = await loadClinicService(tx, input.clinicId, input.serviceId);
  if (service === null) throw new BookingError('SERVICE_NOT_PROVIDED');
  await assertDoctorOffers(tx, input);
  await assertSlotAllowed(tx, now, input, service);

  const endsAt = new Date(input.startsAt.getTime() + service.durationMinutes * MINUTE_MS);
  const blockedUntil = new Date(endsAt.getTime() + PREP_BUFFER_MINUTES * MINUTE_MS);

  await advisoryLock(tx, `doctor:${input.doctorId}`);
  if (service.usesUltrasoundRoom) await advisoryLock(tx, `room:${input.clinicId}`);
  await reapExpiredCheckoutHolds(tx, clock, {
    doctorId: input.doctorId,
    clinicId: input.clinicId,
    usesUltrasoundRoom: service.usesUltrasoundRoom,
    range: { start: input.startsAt, end: blockedUntil },
  });

  const { rows } = await tx.query<AppointmentRow>(
    `INSERT INTO appointments
       (clinic_id, doctor_id, patient_id, service_id, status, starts_at, ends_at, blocked_until,
        uses_ultrasound_room, price_minor, currency, hold_kind, hold_expires_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'held',$5,$6,$7,$8,$9,$10,'checkout',$11,$12,$12)
     RETURNING ${APPOINTMENT_COLUMNS}`,
    [
      input.clinicId,
      input.doctorId,
      input.patientId,
      input.serviceId,
      input.startsAt,
      endsAt,
      blockedUntil,
      service.usesUltrasoundRoom,
      service.priceMinor,
      service.currency,
      new Date(now.getTime() + HOLD_TTL_MINUTES * MINUTE_MS),
      now,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('INSERT ... RETURNING produced no row');
  return toAppointment(row);
}
