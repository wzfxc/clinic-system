/**
 * Schedule management by a clinic registrar (docs/test-assignment-12.md:38, 00-decisions D3, R3):
 * - Date exceptions: `day_off` (`vacation`, `sick`, `other`) or `extra_day` (`work_start < work_end`).
 *   `sick` delegates to `markSickLeave` (cancels the day's visits, queues mails, raises waitlist priority).
 *   `vacation` / `other` (`day_off`) and `extra_day` refuse with `CONFLICT` if any active visit on that date
 *   would be left outside working hours.
 * - Weekly templates: effective from `effectiveFrom` (default: clinic's today) forward (`[effectiveFrom, infinity)`).
 *   Past template periods (`< effectiveFrom`) are closed at `effectiveFrom`, never overwritten, so the 90-day
 *   report over past dates stays accurate. Any active future visit on that weekday (not covered by an exception)
 *   that falls outside the new template hours causes a `CONFLICT` refusal.
 */
import type { Clock } from '../clock.js';
import type { AuthActor } from './actor.js';
import { applyActor } from './appointment.js';
import { advisoryLock } from './hold.js';
import { DEFAULT_HOOKS, type DomainHooks } from './hooks.js';
import { markSickLeave } from './sick-leave.js';
import type { Interval } from './slots.js';
import { isValidIsoDate, localDateOf, zonedInstant } from './time.js';
import { BookingError, type Tx } from './tx.js';

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface UpsertExceptionInput {
  doctorId: number;
  clinicId: number;
  /** Clinic calendar date, YYYY-MM-DD. */
  date: string;
  kind: 'day_off' | 'extra_day';
  reason: 'vacation' | 'sick' | 'other';
  workStart?: string | null;
  workEnd?: string | null;
  breakStart?: string | null;
  breakEnd?: string | null;
  actor: AuthActor;
}

export interface UpsertTemplateInput {
  doctorId: number;
  clinicId: number;
  /** ISO weekday 1 (Monday) .. 7 (Sunday). */
  weekday: number;
  workStart: string;
  workEnd: string;
  breakStart?: string | null;
  breakEnd?: string | null;
  /** Clinic calendar date from which the template takes effect; defaults to clinic's today. */
  effectiveFrom?: string;
  actor: AuthActor;
}

interface ActiveVisitRow {
  id: string;
  starts_at: Date;
  ends_at: Date;
  local_date: string;
}

function validateTimeStr(value: string | null | undefined, field: string): string {
  if (!value || !TIME_PATTERN.test(value)) {
    throw new BookingError('VALIDATION_FAILED', `${field} must be HH:MM`);
  }
  return value;
}

function validateShiftTimes(
  workStartRaw: string | null | undefined,
  workEndRaw: string | null | undefined,
  breakStartRaw: string | null | undefined,
  breakEndRaw: string | null | undefined,
): { workStart: string; workEnd: string; breakStart: string | null; breakEnd: string | null } {
  const workStart = validateTimeStr(workStartRaw, 'workStart');
  const workEnd = validateTimeStr(workEndRaw, 'workEnd');
  if (workStart >= workEnd) {
    throw new BookingError('VALIDATION_FAILED', 'workStart must precede workEnd');
  }
  const hasBreakStart = breakStartRaw !== undefined && breakStartRaw !== null && breakStartRaw !== '';
  const hasBreakEnd = breakEndRaw !== undefined && breakEndRaw !== null && breakEndRaw !== '';
  if (hasBreakStart !== hasBreakEnd) {
    throw new BookingError('VALIDATION_FAILED', 'breakStart and breakEnd must be provided together');
  }
  if (!hasBreakStart) {
    return { workStart, workEnd, breakStart: null, breakEnd: null };
  }
  const breakStart = validateTimeStr(breakStartRaw, 'breakStart');
  const breakEnd = validateTimeStr(breakEndRaw, 'breakEnd');
  if (breakStart < workStart || breakEnd <= breakStart || breakEnd > workEnd) {
    throw new BookingError('VALIDATION_FAILED', 'break must fall within working hours');
  }
  return { workStart, workEnd, breakStart, breakEnd };
}

function buildDaySegments(
  timezone: string,
  date: string,
  shift: { workStart: string; workEnd: string; breakStart: string | null; breakEnd: string | null },
): Interval[] {
  const start = zonedInstant(timezone, date, shift.workStart);
  const end = zonedInstant(timezone, date, shift.workEnd);
  if (shift.breakStart === null || shift.breakEnd === null) {
    return [{ start, end }];
  }
  return [
    { start, end: zonedInstant(timezone, date, shift.breakStart) },
    { start: zonedInstant(timezone, date, shift.breakEnd), end },
  ];
}

function visitFitsSegments(visit: { starts_at: Date; ends_at: Date }, segments: readonly Interval[]): boolean {
  const s = visit.starts_at.getTime();
  const e = visit.ends_at.getTime();
  return segments.some((seg) => s >= seg.start.getTime() && e <= seg.end.getTime());
}

async function assertDoctorInClinic(tx: Tx, doctorId: number, clinicId: number): Promise<string> {
  const { rowCount } = await tx.query(`SELECT 1 FROM doctor_clinics WHERE doctor_id = $1 AND clinic_id = $2`, [
    doctorId,
    clinicId,
  ]);
  if (rowCount === 0) throw new BookingError('NOT_FOUND', 'the doctor does not work in this clinic');
  const clinic = await tx.query<{ timezone: string }>(`SELECT timezone FROM clinics WHERE id = $1`, [clinicId]);
  const timezone = clinic.rows[0]?.timezone;
  if (timezone === undefined) throw new BookingError('NOT_FOUND', 'clinic not found');
  return timezone;
}

export async function upsertScheduleException(
  tx: Tx,
  clock: Clock,
  input: UpsertExceptionInput,
  hooks: DomainHooks = DEFAULT_HOOKS,
): Promise<boolean> {
  if (input.actor.role !== 'receptionist' || input.actor.clinicId !== input.clinicId) {
    throw new BookingError('FORBIDDEN', 'only the clinic registrar may edit schedule exceptions');
  }
  if (!isValidIsoDate(input.date)) {
    throw new BookingError('VALIDATION_FAILED', 'date must be a valid YYYY-MM-DD calendar date');
  }
  if (input.kind !== 'day_off' && input.kind !== 'extra_day') {
    throw new BookingError('VALIDATION_FAILED', 'kind must be day_off or extra_day');
  }
  if (input.reason !== 'vacation' && input.reason !== 'sick' && input.reason !== 'other') {
    throw new BookingError('VALIDATION_FAILED', 'reason must be vacation, sick or other');
  }
  if (input.kind === 'day_off' && input.reason === 'sick') {
    await markSickLeave(
      tx,
      clock,
      { doctorId: input.doctorId, clinicId: input.clinicId, date: input.date, actor: input.actor },
      hooks,
    );
    return true;
  }

  const now = clock.now();
  await applyActor(tx, input.actor);
  await advisoryLock(tx, `doctor:${input.doctorId}`);
  const timezone = await assertDoctorInClinic(tx, input.doctorId, input.clinicId);
  if (input.date < localDateOf(now, timezone)) {
    throw new BookingError('VALIDATION_FAILED', 'cannot edit schedule exceptions in the past');
  }

  const shift =
    input.kind === 'extra_day'
      ? validateShiftTimes(input.workStart, input.workEnd, input.breakStart, input.breakEnd)
      : null;

  const { rows: activeVisits } = await tx.query<ActiveVisitRow>(
    `SELECT id, starts_at, ends_at, local_date::text AS local_date
       FROM appointments
      WHERE doctor_id = $1 AND clinic_id = $2 AND local_date = $3::date
        AND status IN ('held', 'booked', 'checked_in')`,
    [input.doctorId, input.clinicId, input.date],
  );

  if (shift === null) {
    if (activeVisits.length > 0) {
      throw new BookingError(
        'CONFLICT',
        `cannot set day off on ${input.date}: ${activeVisits.length} active appointment(s) exist`,
        { conflictingAppointments: activeVisits.length },
      );
    }
  } else {
    const segments = buildDaySegments(timezone, input.date, shift);
    const conflicting = activeVisits.filter((v) => !visitFitsSegments(v, segments));
    if (conflicting.length > 0) {
      throw new BookingError(
        'CONFLICT',
        `exception hours conflict with ${conflicting.length} active appointment(s) on ${input.date}`,
        { conflictingAppointments: conflicting.length },
      );
    }
  }

  await tx.query(
    `INSERT INTO schedule_exceptions
       (doctor_id, clinic_id, on_date, kind, reason, work_start, work_end, break_start, break_end, created_by, created_at)
     VALUES ($1, $2, $3::date, $4::exception_kind, $5::exception_reason, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (doctor_id, clinic_id, on_date) DO UPDATE
       SET kind = EXCLUDED.kind, reason = EXCLUDED.reason,
           work_start = EXCLUDED.work_start, work_end = EXCLUDED.work_end,
           break_start = EXCLUDED.break_start, break_end = EXCLUDED.break_end,
           created_by = EXCLUDED.created_by, created_at = EXCLUDED.created_at`,
    [
      input.doctorId,
      input.clinicId,
      input.date,
      input.kind,
      input.reason,
      shift?.workStart ?? null,
      shift?.workEnd ?? null,
      shift?.breakStart ?? null,
      shift?.breakEnd ?? null,
      input.actor.userId,
      now,
    ],
  );
  return true;
}

export async function upsertScheduleTemplate(
  tx: Tx,
  clock: Clock,
  input: UpsertTemplateInput,
): Promise<boolean> {
  if (input.actor.role !== 'receptionist' || input.actor.clinicId !== input.clinicId) {
    throw new BookingError('FORBIDDEN', 'only the clinic registrar may edit schedule templates');
  }
  if (!Number.isInteger(input.weekday) || input.weekday < 1 || input.weekday > 7) {
    throw new BookingError('VALIDATION_FAILED', 'weekday must be between 1 and 7');
  }
  const shift = validateShiftTimes(input.workStart, input.workEnd, input.breakStart, input.breakEnd);

  const now = clock.now();
  await applyActor(tx, input.actor);
  await advisoryLock(tx, `doctor:${input.doctorId}`);
  const timezone = await assertDoctorInClinic(tx, input.doctorId, input.clinicId);
  const today = localDateOf(now, timezone);
  const effectiveFrom = input.effectiveFrom && input.effectiveFrom !== '' ? input.effectiveFrom : today;
  if (!isValidIsoDate(effectiveFrom) || effectiveFrom < today) {
    throw new BookingError('VALIDATION_FAILED', 'effectiveFrom must be today or a future YYYY-MM-DD date');
  }

  // Check all active future visits on this weekday from effectiveFrom forward (excluding dates overridden by an exception).
  const { rows: futureVisits } = await tx.query<ActiveVisitRow>(
    `SELECT a.id, a.starts_at, a.ends_at, a.local_date::text AS local_date
       FROM appointments a
      WHERE a.doctor_id = $1 AND a.clinic_id = $2
        AND a.local_date >= $3::date
        AND extract(isodow FROM a.local_date)::int = $4
        AND a.status IN ('held', 'booked', 'checked_in')
        AND NOT EXISTS (
          SELECT 1 FROM schedule_exceptions x
           WHERE x.doctor_id = a.doctor_id AND x.clinic_id = a.clinic_id AND x.on_date = a.local_date
        )`,
    [input.doctorId, input.clinicId, effectiveFrom, input.weekday],
  );

  const conflicting = futureVisits.filter((v) => !visitFitsSegments(v, buildDaySegments(timezone, v.local_date, shift)));
  if (conflicting.length > 0) {
    throw new BookingError(
      'CONFLICT',
      `template change conflicts with ${conflicting.length} existing appointment(s)`,
      { conflictingAppointments: conflicting.length },
    );
  }

  // Remove any template period for this (doctor, clinic, weekday) that starts on or after effectiveFrom.
  await tx.query(
    `DELETE FROM schedule_templates
      WHERE doctor_id = $1 AND clinic_id = $2 AND weekday = $3
        AND NOT lower_inf(valid_during) AND lower(valid_during) >= $4::date`,
    [input.doctorId, input.clinicId, input.weekday, effectiveFrom],
  );

  // Close any open or spanning template period at effectiveFrom so past dates (< effectiveFrom) keep their history.
  await tx.query(
    `UPDATE schedule_templates
        SET valid_during = daterange(lower(valid_during), $4::date, '[)')
      WHERE doctor_id = $1 AND clinic_id = $2 AND weekday = $3
        AND (upper_inf(valid_during) OR upper(valid_during) > $4::date)
        AND (lower_inf(valid_during) OR lower(valid_during) < $4::date)`,
    [input.doctorId, input.clinicId, input.weekday, effectiveFrom],
  );

  // Insert the new template period starting at effectiveFrom: [effectiveFrom, infinity).
  await tx.query(
    `INSERT INTO schedule_templates
       (doctor_id, clinic_id, weekday, work_start, work_end, break_start, break_end, valid_during)
     VALUES ($1, $2, $3, $4, $5, $6, $7, daterange($8::date, NULL, '[)'))`,
    [
      input.doctorId,
      input.clinicId,
      input.weekday,
      shift.workStart,
      shift.workEnd,
      shift.breakStart,
      shift.breakEnd,
      effectiveFrom,
    ],
  );
  return true;
}

