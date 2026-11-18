/**
 * Reads the schedule and busy ranges for the grid (docs/analysis/02 section 5):
 * SQL only selects, `computeFreeSlots` computes. Time comes from the injected Clock,
 * never from now() in SQL.
 */
import type { Clock } from '../clock.js';
import { numberOf, type Tx } from './tx.js';
import {
  computeFreeSlots,
  GRID_DAYS,
  type DoctorSchedule,
  type ExceptionRule,
  type FreeSlot,
  type Interval,
  type TemplateRule,
} from './slots.js';
import { addCalendarDays, localDateOf, zonedInstant } from './time.js';

/** A booking occupies its slot unless it is cancelled or an expired checkout hold (R2). */
const OCCUPIED = `status <> 'cancelled'
  AND NOT (status = 'held' AND hold_kind = 'checkout' AND hold_expires_at <= $NOW)`;

interface TemplateRow {
  doctor_id: string;
  weekday: number;
  work_start: string;
  work_end: string;
  break_start: string | null;
  break_end: string | null;
  valid_from: string | null;
  valid_until: string | null;
}

interface ExceptionRow {
  doctor_id: string;
  on_date: string;
  kind: 'day_off' | 'extra_day';
  work_start: string | null;
  work_end: string | null;
  break_start: string | null;
  break_end: string | null;
}

interface BusyRow {
  doctor_id: string;
  starts_at: Date;
  blocked_until: Date;
}

export interface ClinicService {
  timezone: string;
  durationMinutes: number;
  usesUltrasoundRoom: boolean;
}

export async function loadClinicService(
  tx: Tx,
  clinicId: number,
  serviceId: number,
): Promise<ClinicService | null> {
  const { rows } = await tx.query<{ timezone: string; duration_minutes: number; uses_ultrasound_room: boolean }>(
    `SELECT c.timezone, s.duration_minutes, s.uses_ultrasound_room
       FROM clinics c
       JOIN clinic_services cs ON cs.clinic_id = c.id
       JOIN services s ON s.id = cs.service_id
      WHERE c.id = $1 AND s.id = $2`,
    [clinicId, serviceId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    timezone: row.timezone,
    durationMinutes: row.duration_minutes,
    usesUltrasoundRoom: row.uses_ultrasound_room,
  };
}

/** Doctors of the clinic who perform the service. */
async function loadDoctorIds(tx: Tx, clinicId: number, serviceId: number, doctorId?: number): Promise<number[]> {
  const { rows } = await tx.query<{ doctor_id: string }>(
    `SELECT dc.doctor_id
       FROM doctor_clinics dc
       JOIN doctor_services ds ON ds.doctor_id = dc.doctor_id AND ds.service_id = $2
      WHERE dc.clinic_id = $1 AND ($3::bigint IS NULL OR dc.doctor_id = $3)
      ORDER BY dc.doctor_id`,
    [clinicId, serviceId, doctorId ?? null],
  );
  return rows.map((r) => numberOf(r.doctor_id));
}

/** Templates and exceptions of the given doctors in this clinic (no bookings). */
export async function loadSchedules(
  tx: Tx,
  clinicId: number,
  doctorIds: readonly number[],
  fromDate: string,
  toDate: string,
): Promise<DoctorSchedule[]> {
  // Sequential on purpose: pg deprecates overlapping queries on one connection.
  const templates = await tx.query<TemplateRow>(
      `SELECT doctor_id, weekday, work_start::text, work_end::text, break_start::text, break_end::text,
              lower(valid_during)::text AS valid_from, upper(valid_during)::text AS valid_until
         FROM schedule_templates
        WHERE clinic_id = $1 AND doctor_id = ANY($2::bigint[])`,
    [clinicId, doctorIds],
  );
  const exceptions = await tx.query<ExceptionRow>(
      `SELECT doctor_id, on_date::text, kind, work_start::text, work_end::text, break_start::text, break_end::text
         FROM schedule_exceptions
        WHERE clinic_id = $1 AND doctor_id = ANY($2::bigint[]) AND on_date BETWEEN $3::date AND $4::date`,
    [clinicId, doctorIds, fromDate, toDate],
  );
  return doctorIds.map((doctorId) => ({
    doctorId,
    templates: templates.rows.filter((r) => numberOf(r.doctor_id) === doctorId).map(toTemplate),
    exceptions: exceptions.rows.filter((r) => numberOf(r.doctor_id) === doctorId).map(toException),
    busy: [],
  }));
}

const toTemplate = (r: TemplateRow): TemplateRule => ({
  weekday: r.weekday,
  workStart: r.work_start,
  workEnd: r.work_end,
  breakStart: r.break_start,
  breakEnd: r.break_end,
  validFrom: r.valid_from,
  validUntil: r.valid_until,
});

const toException = (r: ExceptionRow): ExceptionRule => ({
  onDate: r.on_date,
  kind: r.kind,
  workStart: r.work_start,
  workEnd: r.work_end,
  breakStart: r.break_start,
  breakEnd: r.break_end,
});

/** Occupied `[starts_at, blocked_until)` ranges per doctor, as the grid sees them at `now`. */
async function loadDoctorBusy(
  tx: Tx,
  doctorIds: readonly number[],
  range: Interval,
  now: Date,
): Promise<Map<number, Interval[]>> {
  const { rows } = await tx.query<BusyRow>(
    `SELECT doctor_id, starts_at, blocked_until FROM appointments
      WHERE doctor_id = ANY($1::bigint[]) AND starts_at < $3 AND blocked_until > $2
        AND ${OCCUPIED.replace('$NOW', '$4')}`,
    [doctorIds, range.start, range.end, now],
  );
  const byDoctor = new Map<number, Interval[]>();
  for (const r of rows) {
    const list = byDoctor.get(numberOf(r.doctor_id)) ?? [];
    list.push({ start: r.starts_at, end: r.blocked_until });
    byDoctor.set(numberOf(r.doctor_id), list);
  }
  return byDoctor;
}

async function loadRoomBusy(tx: Tx, clinicId: number, range: Interval, now: Date): Promise<Interval[]> {
  const { rows } = await tx.query<BusyRow>(
    `SELECT doctor_id, starts_at, blocked_until FROM appointments
      WHERE clinic_id = $1 AND uses_ultrasound_room AND starts_at < $3 AND blocked_until > $2
        AND ${OCCUPIED.replace('$NOW', '$4')}`,
    [clinicId, range.start, range.end, now],
  );
  return rows.map((r) => ({ start: r.starts_at, end: r.blocked_until }));
}

export interface FreeSlotsRequest {
  clinicId: number;
  serviceId: number;
  doctorId?: number;
  fromDate?: string;
  days?: number;
}

/** Free slots of a clinic (all its doctors for the service, or one doctor) over up to 14 days. */
export async function loadFreeSlots(tx: Tx, clock: Clock, request: FreeSlotsRequest): Promise<FreeSlot[]> {
  const now = clock.now();
  const service = await loadClinicService(tx, request.clinicId, request.serviceId);
  if (service === null) return [];
  const doctorIds = await loadDoctorIds(tx, request.clinicId, request.serviceId, request.doctorId);
  if (doctorIds.length === 0) return [];

  const today = localDateOf(now, service.timezone);
  const lastDate = addCalendarDays(today, GRID_DAYS - 1);
  const range: Interval = {
    start: zonedInstant(service.timezone, today, '00:00'),
    end: zonedInstant(service.timezone, addCalendarDays(lastDate, 1), '00:00'),
  };
  const schedules = await loadSchedules(tx, request.clinicId, doctorIds, today, lastDate);
  const busy = await loadDoctorBusy(tx, doctorIds, range, now);
  const roomBusy = service.usesUltrasoundRoom ? await loadRoomBusy(tx, request.clinicId, range, now) : [];
  return computeFreeSlots({
    now,
    timezone: service.timezone,
    durationMinutes: service.durationMinutes,
    usesUltrasoundRoom: service.usesUltrasoundRoom,
    ...(request.fromDate !== undefined && { fromDate: request.fromDate }),
    ...(request.days !== undefined && { days: request.days }),
    doctors: schedules.map((s) => ({ ...s, busy: busy.get(s.doctorId) ?? [] })),
    roomBusy,
  });
}
