/**
 * Pure free-slot computation (docs/analysis/02 section 4): no database, no NestJS,
 * no clock. Callers pass `now` and the already loaded schedule and busy intervals.
 */
import { MAX_LEAD_DAYS, MIN_LEAD_HOURS, PREP_BUFFER_MINUTES, SLOT_STEP_MINUTES } from '../rules.js';
import {
  addCalendarDays,
  HOUR_MS,
  isoWeekday,
  localDateOf,
  localSlotInfo,
  MINUTE_MS,
  plusCalendarDays,
  zonedInstant,
} from './time.js';

export const GRID_DAYS = 14;

export interface Interval {
  start: Date;
  end: Date;
}

export interface TemplateRule {
  /** ISO weekday 1..7. */
  weekday: number;
  workStart: string;
  workEnd: string;
  breakStart: string | null;
  breakEnd: string | null;
  /** Validity as a half-open date range [validFrom, validUntil); null = unbounded. */
  validFrom: string | null;
  validUntil: string | null;
}

export interface ExceptionRule {
  onDate: string;
  kind: 'day_off' | 'extra_day';
  workStart: string | null;
  workEnd: string | null;
  breakStart: string | null;
  breakEnd: string | null;
}

export interface DoctorSchedule {
  doctorId: number;
  templates: readonly TemplateRule[];
  exceptions: readonly ExceptionRule[];
  /** Busy `[starts_at, blocked_until)` ranges of this doctor, in any clinic. */
  busy: readonly Interval[];
}

export interface SlotQuery {
  now: Date;
  timezone: string;
  durationMinutes: number;
  usesUltrasoundRoom: boolean;
  /** First local date to show; defaults to (and never precedes) the clinic's today. */
  fromDate?: string;
  days?: number;
  doctors: readonly DoctorSchedule[];
  /** Busy ranges of the clinic's ultrasound room (only used for ultrasound services). */
  roomBusy: readonly Interval[];
}

export interface FreeSlot {
  doctorId: number;
  startAt: Date;
  endAt: Date;
  localDate: string;
  localTime: string;
  utcOffsetMinutes: number;
}

interface WorkDay {
  workStart: string;
  workEnd: string;
  breakStart: string | null;
  breakEnd: string | null;
}

function templateApplies(t: TemplateRule, date: string): boolean {
  return (t.validFrom === null || date >= t.validFrom) && (t.validUntil === null || date < t.validUntil);
}

/** Effective working day: an exception replaces the weekly template for that date. */
function effectiveDay(schedule: DoctorSchedule, date: string): WorkDay | null {
  const exception = schedule.exceptions.find((e) => e.onDate === date);
  if (exception) {
    if (exception.kind === 'day_off' || exception.workStart === null || exception.workEnd === null) return null;
    return {
      workStart: exception.workStart,
      workEnd: exception.workEnd,
      breakStart: exception.breakStart,
      breakEnd: exception.breakEnd,
    };
  }
  const weekday = isoWeekday(date);
  return schedule.templates.find((t) => t.weekday === weekday && templateApplies(t, date)) ?? null;
}

/** One or two [start, end) working segments in absolute time, split by the break. */
function segmentsOf(timezone: string, date: string, day: WorkDay): Interval[] {
  const workStart = zonedInstant(timezone, date, day.workStart);
  const workEnd = zonedInstant(timezone, date, day.workEnd);
  if (day.breakStart === null || day.breakEnd === null) return [{ start: workStart, end: workEnd }];
  return [
    { start: workStart, end: zonedInstant(timezone, date, day.breakStart) },
    { start: zonedInstant(timezone, date, day.breakEnd), end: workEnd },
  ];
}

const overlaps = (a: Interval, b: Interval): boolean => a.start < b.end && b.start < a.end;

/** Both bounds inclusive; the upper one is 60 calendar days in the clinic zone (wall-clock kept). */
function bookingWindow(now: Date, timezone: string): Interval {
  return {
    start: new Date(now.getTime() + MIN_LEAD_HOURS * HOUR_MS),
    end: plusCalendarDays(now, timezone, MAX_LEAD_DAYS),
  };
}

/** Visit start times: every 15 minutes of absolute time from the start of each working segment. */
function workingStarts(timezone: string, date: string, day: WorkDay, durationMinutes: number): Date[] {
  const starts: Date[] = [];
  const durationMs = durationMinutes * MINUTE_MS;
  for (const segment of segmentsOf(timezone, date, day)) {
    for (
      let s = segment.start.getTime();
      s + durationMs <= segment.end.getTime();
      s += SLOT_STEP_MINUTES * MINUTE_MS
    ) {
      starts.push(new Date(s));
    }
  }
  return starts;
}

/** Is `startAt` a point of this doctor's working grid on its clinic-local day (bookings ignored)? */
export function isGridStart(
  schedule: DoctorSchedule,
  timezone: string,
  startAt: Date,
  durationMinutes: number,
): boolean {
  const date = localDateOf(startAt, timezone);
  const day = effectiveDay(schedule, date);
  if (day === null) return false;
  return workingStarts(timezone, date, day, durationMinutes).some((s) => s.getTime() === startAt.getTime());
}

export function isWithinBookingWindow(now: Date, timezone: string, startAt: Date): boolean {
  const window = bookingWindow(now, timezone);
  return startAt >= window.start && startAt <= window.end;
}

export function computeFreeSlots(query: SlotQuery): FreeSlot[] {
  const { now, timezone, durationMinutes } = query;
  const today = localDateOf(now, timezone);
  const first = query.fromDate !== undefined && query.fromDate > today ? query.fromDate : today;
  const lastShown = addCalendarDays(today, GRID_DAYS - 1);
  const count = Math.min(query.days ?? GRID_DAYS, GRID_DAYS);
  const window = bookingWindow(now, timezone);
  const blockMs = (durationMinutes + PREP_BUFFER_MINUTES) * MINUTE_MS;
  const slots: FreeSlot[] = [];

  for (const schedule of query.doctors) {
    for (let i = 0; i < count; i++) {
      const date = addCalendarDays(first, i);
      if (date > lastShown) break;
      const day = effectiveDay(schedule, date);
      if (day === null) continue;
      for (const start of workingStarts(timezone, date, day, durationMinutes)) {
        if (start < window.start || start > window.end) continue;
        const blocked: Interval = { start, end: new Date(start.getTime() + blockMs) };
        if (schedule.busy.some((b) => overlaps(blocked, b))) continue;
        if (query.usesUltrasoundRoom && query.roomBusy.some((b) => overlaps(blocked, b))) continue;
        slots.push({
          doctorId: schedule.doctorId,
          startAt: start,
          endAt: new Date(start.getTime() + durationMinutes * MINUTE_MS),
          ...localSlotInfo(start, timezone),
        });
      }
    }
  }
  return slots.sort((a, b) => a.startAt.getTime() - b.startAt.getTime() || a.doctorId - b.doctorId);
}
