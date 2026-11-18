import { describe, expect, it } from 'vitest';
import {
  computeFreeSlots,
  isWithinBookingWindow,
  type DoctorSchedule,
  type ExceptionRule,
  type FreeSlot,
  type Interval,
  type SlotQuery,
  type TemplateRule,
} from './slots.js';
import { addCalendarDays, localDateOf, zonedInstant } from './time.js';

const KYIV = 'Europe/Kyiv';
const WARSAW = 'Europe/Warsaw';
const iso = (d: Date): string => d.toISOString();

function template(overrides: Partial<TemplateRule> = {}): TemplateRule {
  return {
    weekday: 1,
    workStart: '09:00',
    workEnd: '11:00',
    breakStart: null,
    breakEnd: null,
    validFrom: null,
    validUntil: null,
    ...overrides,
  };
}

/** Same hours on every weekday, so tests do not depend on which weekday a date is. */
const everyDay = (overrides: Partial<TemplateRule> = {}): TemplateRule[] =>
  [1, 2, 3, 4, 5, 6, 7].map((weekday) => template({ ...overrides, weekday }));

function doctor(
  templates: TemplateRule[],
  extra: { exceptions?: ExceptionRule[]; busy?: Interval[]; doctorId?: number } = {},
): DoctorSchedule {
  return { doctorId: extra.doctorId ?? 1, templates, exceptions: extra.exceptions ?? [], busy: extra.busy ?? [] };
}

function slots(query: Partial<SlotQuery> & Pick<SlotQuery, 'now' | 'doctors'>): FreeSlot[] {
  return computeFreeSlots({
    timezone: KYIV,
    durationMinutes: 30,
    usesUltrasoundRoom: false,
    roomBusy: [],
    ...query,
  });
}

const kyiv = (date: string, time: string): Date => zonedInstant(KYIV, date, time);
const times = (list: FreeSlot[]): string[] => list.map((s) => s.localTime);
const onDate = (list: FreeSlot[], date: string): FreeSlot[] => list.filter((s) => s.localDate === date);

/** A quiet "now": long before the dates under test, early morning so that today is mostly open. */
const NOW = new Date('2026-06-01T00:00:00Z');
const DATE = '2026-06-03';

describe('computeFreeSlots: grid rules', () => {
  it('T1: 30-minute visits in 09:00-11:00 start every 15 minutes up to 10:30', () => {
    const result = slots({ now: NOW, doctors: [doctor(everyDay())] });
    expect(times(onDate(result, DATE))).toEqual(['09:00', '09:15', '09:30', '09:45', '10:00', '10:15', '10:30']);
  });

  it('T2: a visit may not touch the break; 12:30 and 14:00 are fine', () => {
    const d = doctor(everyDay({ workStart: '09:00', workEnd: '17:00', breakStart: '13:00', breakEnd: '14:00' }));
    const got = times(onDate(slots({ now: NOW, doctors: [d] }), DATE));
    expect(got).not.toContain('13:00');
    expect(got).not.toContain('12:45');
    expect(got).toContain('12:30');
    expect(got).toContain('14:00');
  });

  it('T3: preparation after a visit blocks the next point; the next start is 10:30', () => {
    const busy = [{ start: kyiv(DATE, '10:00'), end: kyiv(DATE, '10:20') }]; // 15-minute visit + 5 minutes
    const d = doctor(everyDay({ workStart: '09:00', workEnd: '12:00' }), { busy });
    const got = times(onDate(slots({ now: NOW, durationMinutes: 15, doctors: [d] }), DATE));
    expect(got).toContain('09:30');
    expect(got).not.toContain('09:45'); // its own preparation would run into the 10:00 visit
    expect(got).not.toContain('10:00');
    expect(got).not.toContain('10:15');
    expect(got).toContain('10:30');
  });

  it('T4: a candidate must leave room for its own preparation before the next booking', () => {
    const busy = [{ start: kyiv(DATE, '10:30'), end: kyiv(DATE, '10:50') }];
    const d = doctor(everyDay({ workStart: '09:00', workEnd: '12:00' }), { busy });
    const got = times(onDate(slots({ now: NOW, durationMinutes: 15, doctors: [d] }), DATE));
    expect(got).toContain('10:00'); // 10:00-10:15 plus 5 minutes ends at 10:20, touching nothing
    expect(got).not.toContain('10:15'); // its preparation would run to 10:35 and overlap
    expect(got).not.toContain('10:45'); // starts inside the booking's blocked range 10:30-10:50
    expect(got).toContain('11:00');
  });

  it('T4b: back-to-back ranges are allowed (half-open intervals)', () => {
    const busy = [{ start: kyiv(DATE, '09:00'), end: kyiv(DATE, '10:20') }];
    const d = doctor(everyDay({ workStart: '09:00', workEnd: '12:00' }), { busy });
    const got = times(onDate(slots({ now: NOW, durationMinutes: 15, doctors: [d] }), DATE));
    expect(got).not.toContain('10:15');
    expect(got).toContain('10:30');
  });

  it('T5: a 90-minute visit cannot run past the end of the shift', () => {
    const d = doctor(everyDay({ workStart: '09:00', workEnd: '12:00' }));
    const got = times(onDate(slots({ now: NOW, durationMinutes: 90, doctors: [d] }), DATE));
    expect(got.at(-1)).toBe('10:30');
    expect(got).toHaveLength(7);
  });

  it('T6: day_off removes the day, extra_day adds one, an exception overrides the template', () => {
    const exceptions: ExceptionRule[] = [
      { onDate: '2026-06-03', kind: 'day_off', workStart: null, workEnd: null, breakStart: null, breakEnd: null },
      { onDate: '2026-06-04', kind: 'extra_day', workStart: '14:00', workEnd: '15:00', breakStart: null, breakEnd: null },
    ];
    const result = slots({ now: NOW, doctors: [doctor(everyDay(), { exceptions })] });
    expect(onDate(result, '2026-06-03')).toHaveLength(0);
    expect(times(onDate(result, '2026-06-04'))).toEqual(['14:00', '14:15', '14:30']);
    expect(onDate(result, '2026-06-05').length).toBeGreaterThan(0);
  });

  it('T6b: an extra_day works on a weekday without a template', () => {
    const exceptions: ExceptionRule[] = [
      { onDate: '2026-06-06', kind: 'extra_day', workStart: '10:00', workEnd: '10:30', breakStart: null, breakEnd: null },
    ];
    const result = slots({ now: NOW, doctors: [doctor([template({ weekday: 1 })], { exceptions })] }); // 6 June is a Saturday
    expect(times(onDate(result, '2026-06-06'))).toEqual(['10:00']);
  });

  it('a template outside its validity range is ignored', () => {
    const d = doctor(everyDay({ validFrom: '2026-06-04', validUntil: '2026-06-05' }));
    const result = slots({ now: NOW, doctors: [d] });
    expect([...new Set(result.map((s) => s.localDate))]).toEqual(['2026-06-04']);
  });

  it('T9: an ultrasound visit blocks the room for every doctor, an ordinary one does not', () => {
    const roomBusy = [{ start: kyiv(DATE, '10:00'), end: kyiv(DATE, '10:35') }];
    const d2 = doctor(everyDay(), { doctorId: 2 });
    const uzi = onDate(slots({ now: NOW, usesUltrasoundRoom: true, roomBusy, doctors: [d2] }), DATE);
    const plain = onDate(slots({ now: NOW, usesUltrasoundRoom: false, roomBusy, doctors: [d2] }), DATE);
    expect(times(uzi)).not.toContain('10:00');
    expect(times(uzi)).not.toContain('10:15');
    expect(times(plain)).toContain('10:00');
  });

  it('shows only the 14 clinic-local days starting today', () => {
    const result = slots({ now: NOW, doctors: [doctor(everyDay())] });
    const dates = [...new Set(result.map((s) => s.localDate))];
    expect(dates).toHaveLength(14);
    expect(dates[0]).toBe('2026-06-01');
    expect(dates.at(-1)).toBe('2026-06-14');
  });
});

describe('booking window', () => {
  const d = doctor(everyDay({ workStart: '09:00', workEnd: '13:00' }));

  it('T7: the first visible start is exactly now + 2h (inclusive), a millisecond later skips it', () => {
    const now = kyiv('2026-06-03', '10:00');
    expect(times(onDate(slots({ now, doctors: [d] }), '2026-06-03'))[0]).toBe('12:00');
    const later = new Date(now.getTime() + 1);
    expect(times(onDate(slots({ now: later, doctors: [d] }), '2026-06-03'))[0]).toBe('12:15');
  });

  it('T7: 60 days is inclusive, calendar days in the clinic zone', () => {
    const now = kyiv('2026-11-18', '10:00');
    expect(isWithinBookingWindow(now, KYIV, kyiv('2027-01-17', '10:00'))).toBe(true);
    expect(isWithinBookingWindow(now, KYIV, kyiv('2027-01-17', '10:15'))).toBe(false);
  });

  it('I9: 60 days across the spring change ends at 10:00 EEST, not 11:00', () => {
    const now = kyiv('2026-01-28', '10:00');
    const edge = kyiv('2026-03-29', '10:00');
    expect(iso(edge)).toBe('2026-03-29T07:00:00.000Z');
    expect(isWithinBookingWindow(now, KYIV, edge)).toBe(true);
    expect(isWithinBookingWindow(now, KYIV, new Date(edge.getTime() + 15 * 60_000))).toBe(false);
  });

  it('the +2h edge is inclusive, 11:45 is too early for now = 10:00', () => {
    const now = kyiv('2026-06-03', '10:00');
    expect(isWithinBookingWindow(now, KYIV, kyiv('2026-06-03', '12:00'))).toBe(true);
    expect(isWithinBookingWindow(now, KYIV, kyiv('2026-06-03', '11:45'))).toBe(false);
  });

  it('T12: "today" is the clinic date, not the viewer date', () => {
    // 01:00Z on 29 March is still 28 March in New York but already 29 March (02:00 CET) in Warsaw.
    const now = new Date('2026-03-29T01:00:00Z');
    expect(localDateOf(now, WARSAW)).toBe('2026-03-29');
    expect(localDateOf(now, 'America/New_York')).toBe('2026-03-28');
    const result = slots({ now, timezone: WARSAW, doctors: [doctor(everyDay())] });
    expect(result[0]?.localDate).toBe('2026-03-29');
  });
});

describe('DST (T11, T13)', () => {
  const wholeDay = (tz: string, now: string, date: string, tpl: Partial<TemplateRule>): FreeSlot[] =>
    onDate(
      slots({ now: new Date(now), timezone: tz, durationMinutes: 15, doctors: [doctor(everyDay(tpl))] }),
      date,
    );

  it.each([
    ['Kyiv spring 2026', KYIV, '2026-03-20T00:00:00Z', '2026-03-29', '2026-03-29T05:00:00.000Z'],
    ['Kyiv autumn 2026', KYIV, '2026-10-20T00:00:00Z', '2026-10-25', '2026-10-25T06:00:00.000Z'],
    ['Warsaw spring 2026', WARSAW, '2026-03-20T00:00:00Z', '2026-03-29', '2026-03-29T06:00:00.000Z'],
    ['Warsaw autumn 2026', WARSAW, '2026-10-20T00:00:00Z', '2026-10-25', '2026-10-25T07:00:00.000Z'],
    ['Warsaw spring 2027', WARSAW, '2027-03-20T00:00:00Z', '2027-03-28', '2027-03-28T06:00:00.000Z'],
    ['Warsaw autumn 2027', WARSAW, '2027-10-25T00:00:00Z', '2027-10-31', '2027-10-31T07:00:00.000Z'],
  ])('%s: a 08:00 shift starts at the right instant and has 36 slots', (_name, tz, now, date, firstUtc) => {
    const result = wholeDay(tz, now, date, { workStart: '08:00', workEnd: '17:00' });
    expect(iso(result[0]?.startAt ?? new Date(NaN))).toBe(firstUtc);
    expect(result).toHaveLength(36);
  });

  it('Warsaw spring night shift 00:00-06:00 has 20 slots and none in the missing 02:xx hour', () => {
    const result = wholeDay(WARSAW, '2026-03-20T00:00:00Z', '2026-03-29', { workStart: '00:00', workEnd: '06:00' });
    expect(result).toHaveLength(20);
    expect(iso(result[0]?.startAt ?? new Date(NaN))).toBe('2026-03-28T23:00:00.000Z');
    expect(times(result).filter((t) => t.startsWith('02:'))).toEqual([]);
  });

  it('Warsaw autumn night shift 00:00-06:00 has 28 slots, 02:xx occurs twice with different offsets', () => {
    const result = wholeDay(WARSAW, '2026-10-20T00:00:00Z', '2026-10-25', { workStart: '00:00', workEnd: '06:00' });
    expect(result).toHaveLength(28);
    expect(iso(result[0]?.startAt ?? new Date(NaN))).toBe('2026-10-24T22:00:00.000Z');
    const second = result.filter((s) => s.localTime === '02:00');
    expect(second.map((s) => s.utcOffsetMinutes)).toEqual([120, 60]);
    expect(new Set(result.map((s) => s.startAt.getTime())).size).toBe(28);
  });

  it('Kyiv autumn night shift has the repeated 03:xx hour', () => {
    const result = wholeDay(KYIV, '2026-10-20T00:00:00Z', '2026-10-25', { workStart: '00:00', workEnd: '06:00' });
    expect(result).toHaveLength(28);
    expect(result.filter((s) => s.localTime === '03:00').map((s) => s.utcOffsetMinutes)).toEqual([180, 120]);
  });

  it('Kyiv spring night shift loses the 03:xx hour', () => {
    const result = wholeDay(KYIV, '2026-03-20T00:00:00Z', '2026-03-29', { workStart: '00:00', workEnd: '06:00' });
    expect(result).toHaveLength(20);
    expect(times(result).filter((t) => t.startsWith('03:'))).toEqual([]);
  });

  it('T13: iterating 14 days across the change yields 14 distinct dates', () => {
    const now = new Date('2026-03-25T04:00:00Z'); // 06:00 in Kyiv
    const d = doctor(everyDay({ workStart: '09:00', workEnd: '09:15' }));
    const dates = slots({ now, durationMinutes: 15, doctors: [d] }).map((s) => s.localDate);
    expect(dates).toEqual(Array.from({ length: 14 }, (_, i) => addCalendarDays('2026-03-25', i)));
  });

  it('a day with the clock change is 23 or 25 hours long but the shift is the same wall-clock span', () => {
    const spring = wholeDay(KYIV, '2026-03-20T00:00:00Z', '2026-03-29', { workStart: '00:00', workEnd: '23:45' });
    const autumn = wholeDay(KYIV, '2026-10-20T00:00:00Z', '2026-10-25', { workStart: '00:00', workEnd: '23:45' });
    expect(autumn.length - spring.length).toBe(8); // two hours apart in actual length: 25h vs 23h
  });
});
