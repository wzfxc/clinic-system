/**
 * Cancel, reschedule, status transitions, online booking block and sick leave against a real
 * Postgres (acceptance 7, 13, 14 of docs/analysis/03 and 04; the 24:00:00 boundary; permissions).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FixedClock } from '../clock.js';
import { createTestDb, type TestDb } from '../db/test-db.js';
import { seedDoctor, seedPatient, seedWorld, type World } from '../db/test-fixtures.js';
import { BLOCK_DAYS, FREE_CANCEL_HOURS, MAX_FUTURE_APPOINTMENTS } from '../rules.js';
import type { AuthActor } from './actor.js';
import type { Appointment } from './appointment.js';
import { BookingService } from './booking-service.js';
import type { FreedInterval } from './hooks.js';
import { addCalendarDays, DAY_MS, HOUR_MS, MINUTE_MS, zonedInstant } from './time.js';
import { BookingError } from './tx.js';

/** 11:00 in Kyiv on Monday 1 June 2026. */
const NOW = new Date('2026-06-01T08:00:00Z');
const ROUNDS = 5;
const SICK_PATIENTS = 12;

let db: TestDb;
let svc: BookingService;
const clock = new FixedClock(NOW);
const freed = vi.fn<(intervals: readonly FreedInterval[]) => void>();

beforeAll(async () => {
  db = await createTestDb();
  svc = new BookingService(db.pool, clock, {
    onSlotsFreed: async (_tx, intervals) => {
      freed(intervals);
    },
  });
}, 60_000);
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  clock.set(NOW);
  freed.mockClear();
  await db.reset();
});

const day = (n: number): string => `2026-06-${String(3 + n).padStart(2, '0')}`;
const kyivAt = (date: string, time: string): Date => zonedInstant('Europe/Kyiv', date, time);

interface Setup {
  w: World;
  doctorId: number;
}

async function setup(options: Parameters<typeof seedDoctor>[2] = {}): Promise<Setup> {
  const w = await seedWorld(db.pool);
  return { w, doctorId: await seedDoctor(db.pool, w, options) };
}

const patientActor = (patientId: number): AuthActor => ({ role: 'patient', userId: 1000 + patientId, patientId });
const registrar = (clinicId: number): AuthActor => ({ role: 'receptionist', userId: 900 + clinicId, clinicId });
const doctorActor = (doctorId: number): AuthActor => ({ role: 'doctor', userId: 800 + doctorId, doctorId });

const holdInput = (s: Setup, patientId: number, startsAt: Date, serviceId = s.w.serviceId) => ({
  patientId,
  doctorId: s.doctorId,
  clinicId: s.w.clinicId,
  serviceId,
  startsAt,
  channel: 'online' as const,
});

async function bookOne(s: Setup, patientId: number, startsAt: Date, serviceId = s.w.serviceId): Promise<Appointment> {
  const held = await svc.hold(holdInput(s, patientId, startsAt, serviceId));
  return svc.confirm({ appointmentId: held.id, patientId, idempotencyKey: randomUUID() });
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (err) {
    return err instanceof BookingError ? err.code : `RAW:${String(err)}`;
  }
}

async function row(id: number): Promise<{ status: string; starts_at: Date; time_version: number; cancel_reason: string | null }> {
  const { rows } = await db.pool.query<{ status: string; starts_at: Date; time_version: number; cancel_reason: string | null }>(
    `SELECT status, starts_at, time_version, cancel_reason FROM appointments WHERE id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) throw new Error(`appointment ${id} missing`);
  return r;
}

async function eventKinds(appointmentId: number): Promise<string[]> {
  const { rows } = await db.pool.query<{ kind: string }>(
    `SELECT kind FROM appointment_events WHERE appointment_id = $1 ORDER BY id`,
    [appointmentId],
  );
  return rows.map((r) => r.kind);
}

async function lastEvent(appointmentId: number): Promise<{ is_late: boolean; is_strike: boolean; actor_role: string | null }> {
  const { rows } = await db.pool.query<{ is_late: boolean; is_strike: boolean; actor_role: string | null }>(
    `SELECT is_late, is_strike, actor_role FROM appointment_events WHERE appointment_id = $1 ORDER BY id DESC LIMIT 1`,
    [appointmentId],
  );
  const r = rows[0];
  if (!r) throw new Error('no events');
  return r;
}

async function freeTimes(s: Setup, date: string): Promise<string[]> {
  const slots = await svc.freeSlots({
    clinicId: s.w.clinicId,
    serviceId: s.w.serviceId,
    doctorId: s.doctorId,
    fromDate: date,
    days: 1,
  });
  return slots.filter((x) => x.localDate === date).map((x) => x.startAt.toISOString());
}

describe('cancel', () => {
  it('cancels with a reason, frees the slot and calls the hook', async () => {
    const s = await setup();
    const p = await seedPatient(db.pool, 1);
    const startsAt = kyivAt(day(1), '10:00');
    const booked = await bookOne(s, p, startsAt);
    expect(await freeTimes(s, day(1))).not.toContain(startsAt.toISOString());

    const res = await svc.cancel({ appointmentId: booked.id, actor: patientActor(p), reason: 'changed my mind' });

    expect(res.late).toBe(false);
    expect(await row(booked.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'changed my mind' });
    expect(await freeTimes(s, day(1))).toContain(startsAt.toISOString());
    expect(freed).toHaveBeenCalledTimes(1);
    expect(freed.mock.calls[0]?.[0]).toMatchObject([{ doctorId: s.doctorId, start: startsAt, reason: 'cancelled' }]);
    expect(await lastEvent(booked.id)).toMatchObject({ is_late: false, is_strike: false, actor_role: 'patient' });
  });

  it.each([
    ['blank', '   '],
    ['reserved sick_leave', 'sick_leave'],
    ['reserved hold_expired', 'hold_expired'],
  ])('rejects a %s reason', async (_name, reason) => {
    const s = await setup();
    const p = await seedPatient(db.pool, 1);
    const booked = await bookOne(s, p, kyivAt(day(1), '10:00'));

    expect(await codeOf(svc.cancel({ appointmentId: booked.id, actor: patientActor(p), reason }))).toBe('VALIDATION_FAILED');
    expect((await row(booked.id)).status).toBe('booked');
  });

  it('24-hour boundary: strictly more than 24h is free, exactly 24:00:00 and less are late', async () => {
    const s = await setup();
    const startsAt = kyivAt(day(5), '10:00');
    const cases: Array<[string, number, boolean]> = [
      ['24:00:01', FREE_CANCEL_HOURS * HOUR_MS + 1000, false],
      ['24:00:00', FREE_CANCEL_HOURS * HOUR_MS, true],
      ['23:59:59', FREE_CANCEL_HOURS * HOUR_MS - 1000, true],
    ];
    for (const [i, [label, msBefore, expectLate]] of cases.entries()) {
      const p = await seedPatient(db.pool, i + 1);
      clock.set(NOW);
      const booked = await bookOne(s, p, kyivAt(day(5), i === 0 ? '10:00' : i === 1 ? '11:00' : '12:00'));
      const start = booked.startsAt;
      clock.set(new Date(start.getTime() - msBefore));

      const res = await svc.cancel({ appointmentId: booked.id, actor: patientActor(p), reason: label });

      expect(res.late, label).toBe(expectLate);
      expect(await lastEvent(booked.id), label).toMatchObject({ is_late: expectLate, is_strike: expectLate });
    }
    expect(startsAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('cannot cancel twice, after the start, or a completed visit', async () => {
    const s = await setup();
    const p = await seedPatient(db.pool, 1);
    const booked = await bookOne(s, p, kyivAt(day(1), '10:00'));
    await svc.cancel({ appointmentId: booked.id, actor: patientActor(p), reason: 'x' });
    expect(await codeOf(svc.cancel({ appointmentId: booked.id, actor: patientActor(p), reason: 'x' }))).toBe(
      'INVALID_STATUS_TRANSITION',
    );

    const second = await bookOne(s, p, kyivAt(day(2), '10:00'));
    clock.set(new Date(second.startsAt.getTime() + MINUTE_MS));
    expect(await codeOf(svc.cancel({ appointmentId: second.id, actor: patientActor(p), reason: 'x' }))).toBe(
      'INVALID_STATUS_TRANSITION',
    );
  });

  it('a held (unconfirmed) booking can be cancelled without a strike', async () => {
    const s = await setup();
    const p = await seedPatient(db.pool, 1);
    clock.set(new Date(kyivAt(day(0), '10:00').getTime() - 3 * HOUR_MS));
    const held = await svc.hold(holdInput(s, p, kyivAt(day(0), '10:00')));

    const res = await svc.cancel({ appointmentId: held.id, actor: patientActor(p), reason: 'no' });

    expect(res.late).toBe(false);
    expect(await lastEvent(held.id)).toMatchObject({ is_strike: false });
  });
});

describe('permissions', () => {
  it('refuses another patient, a registrar of another clinic and a doctor; the booking stays', async () => {
    const s = await setup();
    const other = await seedWorld(db.pool);
    const [owner, stranger] = [await seedPatient(db.pool, 1), await seedPatient(db.pool, 2)] as [number, number];
    const booked = await bookOne(s, owner, kyivAt(day(1), '10:00'));

    for (const actor of [patientActor(stranger), registrar(other.clinicId), doctorActor(s.doctorId)]) {
      expect(await codeOf(svc.cancel({ appointmentId: booked.id, actor, reason: 'x' }))).toBe('FORBIDDEN');
      expect(
        await codeOf(
          svc.reschedule({
            appointmentId: booked.id,
            expectedVersion: booked.timeVersion,
            newStartsAt: kyivAt(day(1), '12:00'),
            actor,
          }),
        ),
      ).toBe('FORBIDDEN');
    }
    expect(await row(booked.id)).toMatchObject({ status: 'booked', time_version: booked.timeVersion });
    expect(await eventKinds(booked.id)).toEqual(['held', 'confirmed']);
  });

  it('the registrar of the clinic may cancel and reschedule', async () => {
    const s = await setup();
    const p = await seedPatient(db.pool, 1);
    const booked = await bookOne(s, p, kyivAt(day(1), '10:00'));

    const moved = await svc.reschedule({
      appointmentId: booked.id,
      expectedVersion: booked.timeVersion,
      newStartsAt: kyivAt(day(1), '12:00'),
      actor: registrar(s.w.clinicId),
    });
    await svc.cancel({ appointmentId: moved.appointment.id, actor: registrar(s.w.clinicId), reason: 'phone call' });

    expect((await row(booked.id)).status).toBe('cancelled');
    expect(await lastEvent(booked.id)).toMatchObject({ actor_role: 'receptionist' });
  });

  it('an unknown appointment is NOT_FOUND', async () => {
    await setup();
    expect(await codeOf(svc.cancel({ appointmentId: 999, actor: patientActor(1), reason: 'x' }))).toBe('NOT_FOUND');
  });
});

describe('reschedule (acceptance 7)', () => {
  /** A booked at T1, B booked at T2, both with the same doctor. */
  async function twoBookings(s: Setup): Promise<{ a: Appointment; pa: number; pb: number; t1: Date; t2: Date }> {
    const [pa, pb] = [await seedPatient(db.pool, 1), await seedPatient(db.pool, 2)] as [number, number];
    const t1 = kyivAt(day(1), '10:00');
    const t2 = kyivAt(day(2), '10:00');
    const a = await bookOne(s, pa, t1);
    await bookOne(s, pb, t2);
    return { a, pa, pb, t1, t2 };
  }

  it('7.1-7.2: moving onto a taken slot fails with SLOT_TAKEN and changes nothing', async () => {
    const s = await setup();
    const { a, pa, t1, t2 } = await twoBookings(s);

    const code = await codeOf(
      svc.reschedule({ appointmentId: a.id, expectedVersion: a.timeVersion, newStartsAt: t2, actor: patientActor(pa) }),
    );

    expect(code).toBe('SLOT_TAKEN');
    expect(await row(a.id)).toMatchObject({ status: 'booked', starts_at: t1, time_version: a.timeVersion });
    expect(await eventKinds(a.id)).toEqual(['held', 'confirmed']);
  });

  it('7.3: a reschedule and a hold on the same slot at once: exactly one wins', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      await db.reset();
      const s = await setup();
      const { a, pa, t2 } = await twoBookings(s);
      await db.inTx(NOW, (c) =>
        c.query(`UPDATE appointments SET status = 'cancelled', cancel_reason = 'test' WHERE starts_at = $1`, [t2]),
      );
      const rival = await seedPatient(db.pool, 3);

      const results = await Promise.all([
        codeOf(svc.reschedule({ appointmentId: a.id, expectedVersion: a.timeVersion, newStartsAt: t2, actor: patientActor(pa) })),
        codeOf(svc.hold(holdInput(s, rival, t2))),
      ]);

      expect([...results].sort(), `round ${round}`).toEqual(['OK', 'SLOT_TAKEN']);
      const { rows } = await db.pool.query(
        `SELECT 1 FROM appointments WHERE doctor_id = $1 AND starts_at = $2 AND status <> 'cancelled'`,
        [s.doctorId, t2],
      );
      expect(rows).toHaveLength(1);
    }
  });

  it('two concurrent reschedules of different visits to one slot: exactly one wins', async () => {
    const s = await setup();
    const [p1, p2] = [await seedPatient(db.pool, 1), await seedPatient(db.pool, 2)] as [number, number];
    const a1 = await bookOne(s, p1, kyivAt(day(1), '10:00'));
    const a2 = await bookOne(s, p2, kyivAt(day(1), '12:00'));
    const target = kyivAt(day(2), '10:00');

    const results = await Promise.all(
      [
        [a1, p1],
        [a2, p2],
      ].map(([a, p]) =>
        codeOf(
          svc.reschedule({
            appointmentId: (a as Appointment).id,
            expectedVersion: (a as Appointment).timeVersion,
            newStartsAt: target,
            actor: patientActor(p as number),
          }),
        ),
      ),
    );

    expect([...results].sort()).toEqual(['OK', 'SLOT_TAKEN']);
  });

  it('7.4: moving to a free slot frees the old one in the same transaction', async () => {
    const s = await setup();
    const p = await seedPatient(db.pool, 1);
    const a = await bookOne(s, p, kyivAt(day(1), '10:00'));
    const t2 = kyivAt(day(1), '14:00');

    const res = await svc.reschedule({ appointmentId: a.id, expectedVersion: a.timeVersion, newStartsAt: t2, actor: patientActor(p) });

    expect(res.appointment).toMatchObject({ id: a.id, startsAt: t2, timeVersion: a.timeVersion + 1, status: 'booked' });
    const times = await freeTimes(s, day(1));
    expect(times).toContain(kyivAt(day(1), '10:00').toISOString());
    expect(times).not.toContain(t2.toISOString());
    expect(freed.mock.calls[0]?.[0]).toMatchObject([{ start: kyivAt(day(1), '10:00'), reason: 'rescheduled' }]);
    expect(await eventKinds(a.id)).toEqual(['held', 'confirmed', 'rescheduled']);
    expect(await lastEvent(a.id)).toMatchObject({ is_late: false, is_strike: false });
  });

  it('7.5: moving onto the patient\'s own other visit fails and the old one stays alive', async () => {
    const s = await setup();
    const doctor2 = await seedDoctor(db.pool, s.w);
    const p = await seedPatient(db.pool, 1);
    const a = await bookOne(s, p, kyivAt(day(1), '10:00'));
    const other = await svc.hold({ ...holdInput(s, p, kyivAt(day(1), '14:00')), doctorId: doctor2 });
    await svc.confirm({ appointmentId: other.id, patientId: p, idempotencyKey: randomUUID() });

    const code = await codeOf(
      svc.reschedule({ appointmentId: a.id, expectedVersion: a.timeVersion, newStartsAt: kyivAt(day(1), '14:15'), actor: patientActor(p) }),
    );

    expect(code).toBe('PATIENT_TIME_CONFLICT');
    expect(await row(a.id)).toMatchObject({ status: 'booked', time_version: a.timeVersion });
  });

  it('a stale version is a CONFLICT; a second move with the new version succeeds', async () => {
    const s = await setup();
    const p = await seedPatient(db.pool, 1);
    const a = await bookOne(s, p, kyivAt(day(1), '10:00'));
    const move = (version: number, time: string) =>
      svc.reschedule({ appointmentId: a.id, expectedVersion: version, newStartsAt: kyivAt(day(1), time), actor: patientActor(p) });

    const first = await move(a.timeVersion, '12:00');

    expect(await codeOf(move(a.timeVersion, '13:00'))).toBe('CONFLICT');
    await expect(move(first.appointment.timeVersion, '13:00')).resolves.toMatchObject({
      appointment: { timeVersion: a.timeVersion + 2 },
    });
  });

  it('a late reschedule (at most 24h before the old start) is a strike', async () => {
    const s = await setup();
    const p = await seedPatient(db.pool, 1);
    const a = await bookOne(s, p, kyivAt(day(1), '10:00'));
    clock.set(new Date(a.startsAt.getTime() - 5 * HOUR_MS));

    const res = await svc.reschedule({
      appointmentId: a.id,
      expectedVersion: a.timeVersion,
      newStartsAt: kyivAt(day(1), '16:00'),
      actor: patientActor(p),
    });

    expect(res.late).toBe(true);
    expect(await lastEvent(a.id)).toMatchObject({ is_late: true, is_strike: true });
  });

  it('reaps another patient\'s expired checkout hold in the new range', async () => {
    const s = await setup();
    const [pa, pb] = [await seedPatient(db.pool, 1), await seedPatient(db.pool, 2)] as [number, number];
    const a = await bookOne(s, pa, kyivAt(day(1), '10:00'));
    const target = kyivAt(day(1), '12:00');
    const stale = await svc.hold(holdInput(s, pb, target));
    clock.advance(11 * MINUTE_MS);

    await svc.reschedule({ appointmentId: a.id, expectedVersion: a.timeVersion, newStartsAt: target, actor: patientActor(pa) });

    expect(await row(stale.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'hold_expired' });
  });

  it('rejects an out-of-hours target and a non-booked visit', async () => {
    const s = await setup();
    const p = await seedPatient(db.pool, 1);
    const a = await bookOne(s, p, kyivAt(day(1), '10:00'));
    const move = (time: string) =>
      svc.reschedule({ appointmentId: a.id, expectedVersion: a.timeVersion, newStartsAt: kyivAt(day(1), time), actor: patientActor(p) });

    expect(await codeOf(move('07:00'))).toBe('OUTSIDE_WORKING_HOURS');
    await svc.cancel({ appointmentId: a.id, actor: patientActor(p), reason: 'x' });
    expect(await codeOf(move('12:00'))).toBe('INVALID_STATUS_TRANSITION');
  });
});

describe('status transitions', () => {
  it('registrar checks in on the day of the visit only; the doctor completes', async () => {
    const s = await setup();
    const p = await seedPatient(db.pool, 1);
    const a = await bookOne(s, p, kyivAt(day(1), '10:00'));
    const reg = registrar(s.w.clinicId);

    expect(await codeOf(svc.changeStatus({ appointmentId: a.id, to: 'checked_in', actor: reg }))).toBe('INVALID_STATUS_TRANSITION');
    clock.set(kyivAt(day(1), '09:30'));
    await expect(svc.changeStatus({ appointmentId: a.id, to: 'checked_in', actor: reg })).resolves.toMatchObject({
      status: 'checked_in',
    });
    clock.set(kyivAt(day(1), '10:40'));
    await expect(svc.changeStatus({ appointmentId: a.id, to: 'completed', actor: doctorActor(s.doctorId) })).resolves.toMatchObject({
      status: 'completed',
    });
    expect(await eventKinds(a.id)).toEqual(['held', 'confirmed', 'checked_in', 'completed']);
    expect(await codeOf(svc.changeStatus({ appointmentId: a.id, to: 'no_show', actor: doctorActor(s.doctorId) }))).toBe(
      'INVALID_STATUS_TRANSITION',
    );
  });

  it('no_show only after the start; registrar or doctor from booked, doctor only from checked_in', async () => {
    const s = await setup();
    const [p1, p2] = [await seedPatient(db.pool, 1), await seedPatient(db.pool, 2)] as [number, number];
    const a1 = await bookOne(s, p1, kyivAt(day(1), '10:00'));
    const a2 = await bookOne(s, p2, kyivAt(day(1), '12:00'));
    const reg = registrar(s.w.clinicId);

    expect(await codeOf(svc.changeStatus({ appointmentId: a1.id, to: 'no_show', actor: reg }))).toBe('INVALID_STATUS_TRANSITION');
    clock.set(kyivAt(day(1), '10:00'));
    await svc.changeStatus({ appointmentId: a1.id, to: 'no_show', actor: reg });
    expect(await lastEvent(a1.id)).toMatchObject({ is_strike: true, actor_role: 'receptionist' });

    clock.set(kyivAt(day(1), '11:50'));
    await svc.changeStatus({ appointmentId: a2.id, to: 'checked_in', actor: reg });
    clock.set(kyivAt(day(1), '12:10'));
    expect(await codeOf(svc.changeStatus({ appointmentId: a2.id, to: 'no_show', actor: reg }))).toBe('FORBIDDEN');
    await expect(svc.changeStatus({ appointmentId: a2.id, to: 'no_show', actor: doctorActor(s.doctorId) })).resolves.toMatchObject({
      status: 'no_show',
    });
  });

  it('refuses the wrong roles and another clinic or doctor', async () => {
    const s = await setup();
    const other = await seedWorld(db.pool);
    const otherDoctor = await seedDoctor(db.pool, s.w);
    const p = await seedPatient(db.pool, 1);
    const a = await bookOne(s, p, kyivAt(day(1), '10:00'));
    clock.set(kyivAt(day(1), '10:30'));

    const attempts: Array<[Parameters<BookingService['changeStatus']>[0]['to'], AuthActor]> = [
      ['checked_in', patientActor(p)],
      ['checked_in', registrar(other.clinicId)],
      ['checked_in', doctorActor(s.doctorId)],
      ['completed', registrar(s.w.clinicId)],
      ['completed', doctorActor(otherDoctor)],
      ['no_show', registrar(other.clinicId)],
    ];
    for (const [to, actor] of attempts) {
      expect(await codeOf(svc.changeStatus({ appointmentId: a.id, to, actor })), `${to} by ${actor.role}`).toBe('FORBIDDEN');
    }
    expect((await row(a.id)).status).toBe('booked');
  });

  it('a held or cancelled appointment cannot be moved to a staff status', async () => {
    const s = await setup();
    const p = await seedPatient(db.pool, 1);
    clock.set(kyivAt(day(0), '08:00'));
    const held = await svc.hold(holdInput(s, p, kyivAt(day(0), '10:00')));
    clock.set(kyivAt(day(0), '10:30'));

    expect(await codeOf(svc.changeStatus({ appointmentId: held.id, to: 'completed', actor: doctorActor(s.doctorId) }))).toBe(
      'INVALID_STATUS_TRANSITION',
    );
  });
});

describe('online booking block (acceptance 14)', () => {
  const FIRST = day(1);

  /** A strike made through the real flow: a late cancel at 00:00 or a no_show at 10:30 of `date`. */
  async function strike(s: Setup, patientId: number, kind: 'late' | 'no_show', date: string): Promise<Date> {
    clock.set(kyivAt(date, '00:00'));
    const booked = await bookOne(s, patientId, kyivAt(date, '10:00'));
    if (kind === 'late') {
      await svc.cancel({ appointmentId: booked.id, actor: patientActor(patientId), reason: 'late' });
      return clock.now();
    }
    clock.set(kyivAt(date, '10:30'));
    await svc.changeStatus({ appointmentId: booked.id, to: 'no_show', actor: registrar(s.w.clinicId) });
    return clock.now();
  }

  const tryOnline = async (s: Setup, patientId: number, at: Date, time = '16:00'): Promise<{ code: string; blockedUntil?: string }> => {
    clock.set(at);
    const target = kyivAt(localDate(at), time);
    try {
      await svc.hold(holdInput(s, patientId, new Date(target.getTime() + DAY_MS)));
      return { code: 'OK' };
    } catch (err) {
      if (!(err instanceof BookingError)) throw err;
      const until = err.details.blockedUntil;
      return typeof until === 'string' ? { code: err.code, blockedUntil: until } : { code: err.code };
    }
  };

  const localDate = (instant: Date): string => instant.toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' });

  it('14.1: a no_show and a late cancel block online booking and report when it ends', async () => {
    const s = await setup();
    const p = await seedPatient(db.pool, 1);
    await strike(s, p, 'late', FIRST);
    const second = await strike(s, p, 'no_show', day(2));

    const res = await tryOnline(s, p, second);

    expect(res).toEqual({ code: 'ONLINE_BOOKING_BLOCKED', blockedUntil: new Date(second.getTime() + BLOCK_DAYS * DAY_MS).toISOString() });
  });

  it('14.2: the registrar books the blocked patient, under the same limits', async () => {
    const s = await setup();
    const p = await seedPatient(db.pool, 1);
    await strike(s, p, 'late', FIRST);
    const second = await strike(s, p, 'late', day(2));
    clock.set(second);
    const front = (date: string, time: string, extra: Partial<ReturnType<typeof holdInput>> = {}) =>
      svc.hold({ ...holdInput(s, p, kyivAt(date, time)), channel: 'front_desk', ...extra });
    const confirm = async (a: Appointment) => svc.confirm({ appointmentId: a.id, patientId: p, idempotencyKey: randomUUID() });

    await confirm(await front(day(5), '10:00'));
    expect(await codeOf(front(day(5), '15:00'))).toBe('DOCTOR_DAILY_LIMIT');
    await confirm(await front(day(6), '10:00'));
    await confirm(await front(day(7), '10:00'));
    expect(await codeOf(front(day(8), '10:00'))).toBe('PATIENT_LIMIT_EXCEEDED');
    expect(MAX_FUTURE_APPOINTMENTS).toBe(3);
    expect(await codeOf(front(addCalendarDays(day(0), 90), '10:00'))).toBe('SLOT_OUT_OF_WINDOW');
  });

  it('14.3: one incident does not block', async () => {
    const s = await setup();
    const p = await seedPatient(db.pool, 1);
    const at = await strike(s, p, 'late', FIRST);

    expect((await tryOnline(s, p, at)).code).toBe('OK');
  });

  it('14.4: a strike 89 days old counts, one 91 days old does not, exactly 90 counts', async () => {
    for (const [age, expected] of [
      [89, 'ONLINE_BOOKING_BLOCKED'],
      [90, 'ONLINE_BOOKING_BLOCKED'],
      [91, 'OK'],
    ] as const) {
      await db.reset();
      const s = await setup();
      const p = await seedPatient(db.pool, 1);
      await strike(s, p, 'late', FIRST);
      const second = await strike(s, p, 'late', addCalendarDays(FIRST, age));

      expect((await tryOnline(s, p, second)).code, `age ${age}`).toBe(expected);
    }
  });

  it('14.5: the block ends exactly 30 days after the second strike', async () => {
    const s = await setup();
    const p = await seedPatient(db.pool, 1);
    await strike(s, p, 'late', FIRST);
    const second = await strike(s, p, 'late', day(2));
    const end = second.getTime() + BLOCK_DAYS * DAY_MS;

    expect((await tryOnline(s, p, new Date(end - 1))).code).toBe('ONLINE_BOOKING_BLOCKED');
    expect((await tryOnline(s, p, new Date(end))).code).toBe('OK');
  });

  it('14.6: strikes of different patients are not mixed', async () => {
    const s = await setup();
    const [p1, p2] = [await seedPatient(db.pool, 1), await seedPatient(db.pool, 2)] as [number, number];
    await strike(s, p1, 'late', FIRST);
    const at = await strike(s, p2, 'late', day(2));

    expect((await tryOnline(s, p1, at)).code).toBe('OK');
    expect((await tryOnline(s, p2, at, '14:00')).code).toBe('OK');
  });

  it('the legacy column is ignored', async () => {
    const s = await setup();
    const p = await seedPatient(db.pool, 1);
    await db.pool.query(`UPDATE patients SET online_booking_blocked_until = $1 WHERE id = $2`, [new Date(NOW.getTime() + DAY_MS * 5), p]);

    expect((await tryOnline(s, p, NOW)).code).toBe('OK');
  });
});

describe('sick leave (acceptance 13)', () => {
  async function seedDay(): Promise<{ s: Setup; ids: number[]; patients: number[] }> {
    const s = await setup({ workStart: '09:00', workEnd: '20:00' });
    const patients: number[] = [];
    const ids: number[] = [];
    for (let i = 0; i < SICK_PATIENTS; i++) {
      const p = await seedPatient(db.pool, i + 1);
      await db.pool.query(`UPDATE patients SET email = $1 WHERE id = $2`, [`p${i + 1}@example.test`, p]);
      patients.push(p);
      const start = new Date(kyivAt(day(1), '09:00').getTime() + i * 45 * MINUTE_MS);
      ids.push((await bookOne(s, p, start)).id);
    }
    return { s, ids, patients };
  }

  const sick = (s: Setup, date = day(1), actor: AuthActor = registrar(s.w.clinicId)) =>
    svc.markSickLeave({ doctorId: s.doctorId, clinicId: s.w.clinicId, date, actor });

  it('13: 12 visits cancelled, 12 outbox rows, a repeat call changes nothing', async () => {
    const { s, ids, patients } = await seedDay();

    const first = await sick(s);
    const second = await sick(s);

    expect(first.applied).toBe(true);
    expect([...first.cancelledAppointmentIds].sort((a, b) => a - b)).toEqual(ids);
    expect(second).toEqual({ applied: false, cancelledAppointmentIds: [] });
    const { rows: cancelled } = await db.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM appointments WHERE status = 'cancelled' AND cancel_reason = 'sick_leave'`,
    );
    expect(Number(cancelled[0]?.n)).toBe(SICK_PATIENTS);
    const { rows: mails } = await db.pool.query<{ dedupe_key: string; to_address: string; status: string; message_id: string }>(
      `SELECT dedupe_key, to_address, status, message_id FROM email_outbox ORDER BY id`,
    );
    expect(mails).toHaveLength(SICK_PATIENTS);
    expect(new Set(mails.map((m) => m.dedupe_key)).size).toBe(SICK_PATIENTS);
    expect(new Set(mails.map((m) => m.dedupe_key))).toEqual(new Set(ids.map((id) => `sick:${id}`)));
    expect(mails.every((m) => m.status === 'pending' && m.message_id.endsWith('@clinic.local>'))).toBe(true);
    expect(patients).toHaveLength(SICK_PATIENTS);
    const { rows: strikes } = await db.pool.query(`SELECT 1 FROM appointment_events WHERE is_strike OR is_late`);
    expect(strikes).toHaveLength(0);
    const { rows: exc } = await db.pool.query(`SELECT kind, reason FROM schedule_exceptions`);
    expect(exc).toEqual([{ kind: 'day_off', reason: 'sick' }]);
  });

  it('closes the day: no free slots, new bookings refused, other days and doctors untouched', async () => {
    const { s } = await seedDay();
    const otherDoctor = await seedDoctor(db.pool, s.w);
    const p = await seedPatient(db.pool, 50);
    const unaffected = await bookOne(s, p, kyivAt(day(2), '10:00'));
    const p2 = await seedPatient(db.pool, 51);
    const elsewhere = await svc.hold({ ...holdInput(s, p2, kyivAt(day(1), '10:00')), doctorId: otherDoctor });

    await sick(s);

    expect(await freeTimes(s, day(1))).toEqual([]);
    expect(await codeOf(svc.hold(holdInput(s, p, kyivAt(day(1), '09:00'))))).toBe('OUTSIDE_WORKING_HOURS');
    expect((await row(unaffected.id)).status).toBe('booked');
    expect((await row(elsewhere.id)).status).toBe('held');
  });

  it('calls the hook once with every freed interval; a repeat call does not call it', async () => {
    const { s } = await seedDay();
    await sick(s);
    await sick(s);

    expect(freed).toHaveBeenCalledTimes(1);
    expect(freed.mock.calls[0]?.[0]).toHaveLength(SICK_PATIENTS);
    expect(freed.mock.calls[0]?.[0]?.every((i) => i.reason === 'sick_leave')).toBe(true);
  });

  it('two simultaneous calls cancel and mail exactly once', async () => {
    const { s } = await seedDay();

    const results = await Promise.all([sick(s), sick(s)]);

    expect(results.filter((r) => r.applied)).toHaveLength(1);
    const { rows } = await db.pool.query(`SELECT 1 FROM email_outbox`);
    expect(rows).toHaveLength(SICK_PATIENTS);
  });

  it('an extra_day becomes a day_off and its visits are cancelled', async () => {
    const s = await setup({ weekdays: [1] }); // works Mondays only
    const sunday = day(4); // 2026-06-07
    await db.pool.query(
      `INSERT INTO schedule_exceptions (doctor_id, clinic_id, on_date, kind, reason, work_start, work_end, created_at)
       VALUES ($1, $2, $3, 'extra_day', 'other', '09:00', '13:00', $4)`,
      [s.doctorId, s.w.clinicId, sunday, NOW],
    );
    const p = await seedPatient(db.pool, 1);
    const a = await bookOne(s, p, kyivAt(sunday, '10:00'));

    const res = await sick(s, sunday);

    expect(res).toEqual({ applied: true, cancelledAppointmentIds: [a.id] });
    const { rows } = await db.pool.query(`SELECT kind, reason, work_start FROM schedule_exceptions`);
    expect(rows).toEqual([{ kind: 'day_off', reason: 'sick', work_start: null }]);
  });

  it('a held visit is cancelled without a mail; a visit that already started is left alone', async () => {
    const s = await setup();
    const [p1, p2] = [await seedPatient(db.pool, 1), await seedPatient(db.pool, 2)] as [number, number];
    const held = await svc.hold(holdInput(s, p1, kyivAt(day(1), '12:00')));
    const early = await bookOne(s, p2, kyivAt(day(1), '09:00'));
    clock.set(kyivAt(day(1), '09:30'));

    const res = await sick(s);

    expect(res.cancelledAppointmentIds).toEqual([held.id]);
    expect((await row(early.id)).status).toBe('booked');
    const { rows } = await db.pool.query(`SELECT 1 FROM email_outbox`);
    expect(rows).toHaveLength(0);
  });

  it('a hold that replaces an own hold of a doctor on sick leave does not deadlock with it', async () => {
    const s = await setup();
    const p = await seedPatient(db.pool, 1);
    await svc.hold(holdInput(s, p, kyivAt(day(1), '12:00')));

    const results = await Promise.all([
      codeOf(svc.hold(holdInput(s, p, kyivAt(day(2), '12:00')))),
      codeOf(sick(s)),
    ]);

    expect(results).toEqual(['OK', 'OK']);
  });

  it('a patient without an email still gets an outbox row, marked dead', async () => {
    const s = await setup();
    const p = await seedPatient(db.pool, 1);
    const a = await bookOne(s, p, kyivAt(day(1), '10:00'));

    await sick(s);

    const { rows } = await db.pool.query(`SELECT dedupe_key, status, last_error FROM email_outbox`);
    expect(rows).toEqual([{ dedupe_key: `sick:${a.id}`, status: 'dead', last_error: 'no_email' }]);
  });

  it('only the registrar of that clinic; the doctor must work there that day; no past dates', async () => {
    const s = await setup({ weekdays: [1] });
    const other = await seedWorld(db.pool);

    expect(await codeOf(sick(s, day(1), registrar(other.clinicId)))).toBe('FORBIDDEN');
    expect(await codeOf(sick(s, day(1), doctorActor(s.doctorId)))).toBe('FORBIDDEN');
    expect(await codeOf(sick(s, day(1)))).toBe('VALIDATION_FAILED'); // Wednesday: no template
    expect(await codeOf(sick(s, '2026-05-25'))).toBe('VALIDATION_FAILED'); // before today
    expect(await codeOf(sick(s, 'tomorrow'))).toBe('VALIDATION_FAILED');
    const { rows } = await db.pool.query(`SELECT 1 FROM schedule_exceptions`);
    expect(rows).toHaveLength(0);
  });
});
