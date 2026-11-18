/**
 * The only place that does zone arithmetic (docs/analysis/02 section 3).
 * Day boundaries come from the clinic zone, never from "+24h"; a wall-clock time
 * inside a spring-forward gap moves forward, a repeated autumn hour resolves to
 * its first occurrence (Luxon defaults, pinned by slots.test.ts).
 */
import { DateTime } from 'luxon';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

function inZone(instant: Date, timezone: string): DateTime {
  const dt = DateTime.fromJSDate(instant, { zone: timezone });
  if (!dt.isValid) throw new Error(`Invalid time zone: ${timezone}`);
  return dt;
}

/** Wall-clock `date` (YYYY-MM-DD) and `time` (HH:mm[:ss]) in `timezone` as an instant. */
export function zonedInstant(timezone: string, date: string, time: string): Date {
  const dt = DateTime.fromISO(`${date}T${time.slice(0, 5)}`, { zone: timezone });
  if (!dt.isValid) throw new Error(`Invalid local time ${date} ${time} in ${timezone}`);
  return dt.toJSDate();
}

/** Calendar date (YYYY-MM-DD) of `instant` in `timezone`. */
export function localDateOf(instant: Date, timezone: string): string {
  const iso = inZone(instant, timezone).toISODate();
  if (iso === null) throw new Error('Unreachable: valid DateTime without ISO date');
  return iso;
}

/** Date arithmetic on plain calendar dates; unaffected by DST by construction. */
export function addCalendarDays(date: string, days: number): string {
  const iso = DateTime.fromISO(date, { zone: 'utc' }).plus({ days }).toISODate();
  if (iso === null) throw new Error(`Invalid date: ${date}`);
  return iso;
}

/** ISO weekday (1 = Monday .. 7 = Sunday) of a calendar date. */
export function isoWeekday(date: string): number {
  return DateTime.fromISO(date, { zone: 'utc' }).weekday;
}

/** `instant` plus whole calendar days in `timezone`, keeping the wall-clock time. */
export function plusCalendarDays(instant: Date, timezone: string, days: number): Date {
  return inZone(instant, timezone).plus({ days }).toJSDate();
}

export interface LocalSlotInfo {
  localDate: string;
  localTime: string;
  utcOffsetMinutes: number;
}

export function localSlotInfo(instant: Date, timezone: string): LocalSlotInfo {
  const dt = inZone(instant, timezone);
  return {
    localDate: dt.toISODate() ?? '',
    localTime: dt.toFormat('HH:mm'),
    utcOffsetMinutes: dt.offset,
  };
}
