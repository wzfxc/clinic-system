/**
 * Sick leave of a doctor for one clinic day (docs/analysis/01 "Лікарняний", 00-decisions R3, D5).
 * One transaction: doctor advisory lock (the same one hold and reschedule take, so none of them can
 * slip a booking onto the closed day), day_off exception, cancellation of the day's visits without
 * a strike, one outbox mail per cancelled confirmed visit. Visits that already started are left alone. A repeat call finds the day already closed and
 * does nothing, so nothing is cancelled or mailed twice.
 */
import type { Clock } from '../clock.js';
import type { AuthActor } from './actor.js';
import { applyActor } from './appointment.js';
import { advisoryLock } from './hold.js';
import { DEFAULT_HOOKS, type DomainHooks, type FreedInterval } from './hooks.js';
import { localDateOf } from './time.js';
import { BookingError, numberOf, type Tx } from './tx.js';

export const SICK_LEAVE_REASON = 'sick_leave';
export const SICK_LEAVE_TEMPLATE = 'appointment_cancelled_sick_leave';

export interface SickLeaveInput {
  doctorId: number;
  clinicId: number;
  /** Local calendar date of the clinic, YYYY-MM-DD. */
  date: string;
  actor: AuthActor;
}

export interface SickLeaveResult {
  /** False when the day was already closed: nothing was cancelled or queued. */
  applied: boolean;
  cancelledAppointmentIds: number[];
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface CancelledRow {
  id: string;
  /** Status before the cancellation. */
  prev_status: string;
  service_id: string;
  starts_at: Date;
  blocked_until: Date;
  uses_ultrasound_room: boolean;
}

async function doctorWorksOn(tx: Tx, input: SickLeaveInput): Promise<boolean> {
  const { rowCount } = await tx.query(
    `SELECT 1 FROM schedule_templates
      WHERE doctor_id = $1 AND clinic_id = $2 AND weekday = extract(isodow FROM $3::date)::int
        AND valid_during @> $3::date
     UNION ALL
     SELECT 1 FROM schedule_exceptions WHERE doctor_id = $1 AND clinic_id = $2 AND on_date = $3::date`,
    [input.doctorId, input.clinicId, input.date],
  );
  return (rowCount ?? 0) > 0;
}

/** Closes the day; returns whether this call did it (a day_off row already there means no). */
async function closeDay(tx: Tx, now: Date, input: SickLeaveInput): Promise<boolean> {
  const { rowCount } = await tx.query(
    `INSERT INTO schedule_exceptions (doctor_id, clinic_id, on_date, kind, reason, created_by, created_at)
     VALUES ($1, $2, $3::date, 'day_off', 'sick', $4, $5)
     ON CONFLICT (doctor_id, clinic_id, on_date) DO UPDATE
       SET kind = 'day_off', reason = 'sick',
           work_start = NULL, work_end = NULL, break_start = NULL, break_end = NULL
       WHERE schedule_exceptions.kind = 'extra_day'
     RETURNING id`,
    [input.doctorId, input.clinicId, input.date, input.actor.userId, now],
  );
  return (rowCount ?? 0) > 0;
}

async function cancelDay(tx: Tx, now: Date, input: SickLeaveInput): Promise<CancelledRow[]> {
  // Rows are locked in id order first so concurrent writers on them cannot deadlock with this update.
  const { rows } = await tx.query<CancelledRow>(
    `WITH day AS (
       SELECT id, status FROM appointments
        WHERE doctor_id = $1 AND clinic_id = $2 AND local_date = $3::date
          AND status IN ('held', 'booked', 'checked_in') AND starts_at > $4
        ORDER BY id FOR UPDATE)
     UPDATE appointments a
        SET status = 'cancelled', cancel_reason = '${SICK_LEAVE_REASON}',
            hold_kind = NULL, hold_expires_at = NULL, updated_at = $4
       FROM day WHERE a.id = day.id
     RETURNING a.id, day.status::text AS prev_status, a.service_id, a.starts_at, a.blocked_until, a.uses_ultrasound_room`,
    [input.doctorId, input.clinicId, input.date, now],
  );
  return rows;
}

async function queueMails(tx: Tx, now: Date, ids: readonly number[]): Promise<void> {
  await tx.query(
    `INSERT INTO email_outbox
       (dedupe_key, to_address, patient_id, template, payload, status, last_error, next_attempt_at, created_at)
     SELECT 'sick:' || a.id, p.email, p.id, $2,
            jsonb_build_object('appointmentId', a.id, 'doctorId', a.doctor_id, 'clinicId', a.clinic_id,
                               'startsAt', a.starts_at, 'date', a.local_date),
            CASE WHEN p.email IS NULL THEN 'dead'::email_status ELSE 'pending'::email_status END,
            CASE WHEN p.email IS NULL THEN 'no_email' END,
            $3, $3
       FROM appointments a JOIN patients p ON p.id = a.patient_id
      WHERE a.id = ANY($1::bigint[])
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [ids, SICK_LEAVE_TEMPLATE, now],
  );
}

export async function markSickLeave(
  tx: Tx,
  clock: Clock,
  input: SickLeaveInput,
  hooks: DomainHooks = DEFAULT_HOOKS,
): Promise<SickLeaveResult> {
  const now = clock.now();
  if (input.actor.role !== 'receptionist' || input.actor.clinicId !== input.clinicId) {
    throw new BookingError('FORBIDDEN', 'only the clinic registrar may record sick leave');
  }
  if (!DATE_PATTERN.test(input.date)) throw new BookingError('VALIDATION_FAILED', 'invalid date');
  await applyActor(tx, input.actor);

  await advisoryLock(tx, `doctor:${input.doctorId}`);
  const { rowCount: knownPair } = await tx.query(
    `SELECT 1 FROM doctor_clinics WHERE doctor_id = $1 AND clinic_id = $2`,
    [input.doctorId, input.clinicId],
  );
  if (knownPair === 0) throw new BookingError('NOT_FOUND', 'the doctor does not work in this clinic');
  const clinic = await tx.query<{ timezone: string }>(`SELECT timezone FROM clinics WHERE id = $1`, [input.clinicId]);
  const timezone = clinic.rows[0]?.timezone;
  if (timezone === undefined) throw new BookingError('NOT_FOUND', 'clinic not found');
  if (input.date < localDateOf(now, timezone)) throw new BookingError('VALIDATION_FAILED', 'the date is in the past');
  if (!(await doctorWorksOn(tx, input))) {
    throw new BookingError('VALIDATION_FAILED', 'the doctor has no schedule on this date');
  }

  if (!(await closeDay(tx, now, input))) return { applied: false, cancelledAppointmentIds: [] };

  const cancelled = await cancelDay(tx, now, input);
  const ids = cancelled.map((r) => numberOf(r.id));
  // A visit that never left the checkout hold was not promised to anyone, so it gets no mail.
  const confirmed = cancelled.filter((r) => r.prev_status !== 'held').map((r) => numberOf(r.id));
  if (confirmed.length > 0) await queueMails(tx, now, confirmed);
  const freed: FreedInterval[] = cancelled.map((r) => ({
    doctorId: input.doctorId,
    clinicId: input.clinicId,
    serviceId: numberOf(r.service_id),
    usesUltrasoundRoom: r.uses_ultrasound_room,
    start: r.starts_at,
    end: r.blocked_until,
    reason: 'sick_leave',
  }));
  await hooks.onSlotsFreed(tx, freed);
  return { applied: true, cancelledAppointmentIds: ids };
}
