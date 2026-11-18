import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '../clock.js';
import { createTestDb, type TestDb } from '../db/test-db.js';
import {
  insertRawAppointment,
  seedDoctor,
  seedPatient,
  seedWorld,
  type World,
} from '../db/test-fixtures.js';
import { HOLD_TTL_MINUTES, MAX_FUTURE_APPOINTMENTS } from '../rules.js';
import type { Appointment } from './appointment.js';
import { BookingService } from './booking-service.js';
import { MINUTE_MS, zonedInstant } from './time.js';
import { BookingError } from './tx.js';

/** 11:00 in Kyiv on Monday 1 June 2026. */
const NOW = new Date('2026-06-01T08:00:00Z');
const HOLD_MS = HOLD_TTL_MINUTES * MINUTE_MS;
const PARALLEL = 20;
const ROUNDS = 5;

let db: TestDb;
let svc: BookingService;
const clock = new FixedClock(NOW);

beforeAll(async () => {
  db = await createTestDb();
  svc = new BookingService(db.pool, clock);
}, 60_000);
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  clock.set(NOW);
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

const holdInput = (s: Setup, patientId: number, startsAt: Date, serviceId = s.w.serviceId) => ({
  patientId,
  doctorId: s.doctorId,
  clinicId: s.w.clinicId,
  serviceId,
  startsAt,
  channel: 'online' as const,
});

const confirmInput = (appointmentId: number, patientId: number, idempotencyKey: string = randomUUID()) => ({
  appointmentId,
  patientId,
  idempotencyKey,
});

async function bookOne(s: Setup, patientId: number, startsAt: Date): Promise<Appointment> {
  const held = await svc.hold(holdInput(s, patientId, startsAt));
  return svc.confirm(confirmInput(held.id, patientId));
}

type Settled = { ok: true; value: Appointment } | { ok: false; error: unknown };
const settle = (p: Promise<Appointment>): Promise<Settled> =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

const failureCodes = (results: Settled[]): string[] =>
  results.flatMap((r) => (r.ok ? [] : [r.error instanceof BookingError ? r.error.code : `RAW:${String(r.error)}`]));

async function statusOf(id: number): Promise<{ status: string; cancel_reason: string | null }> {
  const { rows } = await db.pool.query<{ status: string; cancel_reason: string | null }>(
    `SELECT status, cancel_reason FROM appointments WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new Error(`appointment ${id} missing`);
  return row;
}

async function eventKinds(appointmentId: number): Promise<string[]> {
  const { rows } = await db.pool.query<{ kind: string }>(
    `SELECT kind FROM appointment_events WHERE appointment_id = $1 ORDER BY id`,
    [appointmentId],
  );
  return rows.map((r) => r.kind);
}

async function freeTimes(s: Setup, date: string): Promise<string[]> {
  const slots = await svc.freeSlots({ clinicId: s.w.clinicId, serviceId: s.w.serviceId, doctorId: s.doctorId, fromDate: date, days: 1 });
  return slots.filter((x) => x.localDate === date).map((x) => x.localTime);
}

describe('acceptance 3: hold then confirm', () => {
  it('hold lasts 10 minutes and hides the slot; confirm books it and writes history', async () => {
    const s = await setup();
    const patientId = await seedPatient(db.pool, 1);
    const startsAt = kyivAt(day(0), '10:00');
    expect(await freeTimes(s, day(0))).toContain('10:00');

    const held = await svc.hold(holdInput(s, patientId, startsAt));

    expect(held.status).toBe('held');
    expect(held.holdKind).toBe('checkout');
    expect(held.holdExpiresAt).toEqual(new Date(NOW.getTime() + HOLD_MS));
    expect(held.localDate).toBe(day(0));
    expect(await freeTimes(s, day(0))).not.toContain('10:00');

    const booked = await svc.confirm(confirmInput(held.id, patientId));

    expect(booked).toMatchObject({ id: held.id, status: 'booked', holdKind: null, holdExpiresAt: null });
    expect(await eventKinds(held.id)).toEqual(['held', 'confirmed']);
  });
});

describe('acceptance 4: parallel holds', () => {
  it(`${PARALLEL} patients on one slot: exactly one wins, the rest get SLOT_TAKEN, repeated ${ROUNDS} times`, async () => {
    const s = await setup();
    const patients = await Promise.all(Array.from({ length: PARALLEL }, (_, i) => seedPatient(db.pool, i)));

    for (let round = 0; round < ROUNDS; round++) {
      const startsAt = kyivAt(day(round), '10:00');
      const results = await Promise.all(patients.map((p) => settle(svc.hold(holdInput(s, p, startsAt)))));

      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(failureCodes(results)).toEqual(Array<string>(PARALLEL - 1).fill('SLOT_TAKEN'));
      const { rows } = await db.pool.query(
        `SELECT 1 FROM appointments WHERE doctor_id = $1 AND starts_at = $2 AND status <> 'cancelled'`,
        [s.doctorId, startsAt],
      );
      expect(rows).toHaveLength(1);
    }
  });

  it('one patient firing 20 holds at once ends with exactly one live hold (D2)', async () => {
    const s = await setup();
    const patientId = await seedPatient(db.pool, 1);
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, (_, i) => settle(svc.hold(holdInput(s, patientId, kyivAt(day(i % 10), '10:00'))))),
    );

    expect(failureCodes(results)).toEqual([]);
    const { rows } = await db.pool.query(`SELECT 1 FROM appointments WHERE patient_id = $1 AND status = 'held'`, [patientId]);
    expect(rows).toHaveLength(1);
  });

  it('limit of 3: with three booked visits every parallel hold is refused', async () => {
    const s = await setup();
    const patientId = await seedPatient(db.pool, 1);
    for (let i = 0; i < MAX_FUTURE_APPOINTMENTS; i++) await bookOne(s, patientId, kyivAt(day(i), '10:00'));

    const results = await Promise.all(
      [3, 4, 5, 6, 7].map((n) => settle(svc.hold(holdInput(s, patientId, kyivAt(day(n), '10:00'))))),
    );

    expect(failureCodes(results)).toEqual(Array<string>(5).fill('PATIENT_LIMIT_EXCEEDED'));
  });

  it('limit of 3: with two booked visits parallel holds never push the total above 3', async () => {
    const s = await setup();
    const patientId = await seedPatient(db.pool, 1);
    for (let i = 0; i < 2; i++) await bookOne(s, patientId, kyivAt(day(i), '10:00'));

    const results = await Promise.all(
      [3, 4, 5, 6, 7].map((n) => settle(svc.hold(holdInput(s, patientId, kyivAt(day(n), '10:00'))))),
    );

    expect(failureCodes(results)).toEqual([]);
    const { rows } = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM appointments WHERE patient_id = $1 AND status <> 'cancelled'`,
      [patientId],
    );
    expect(rows[0]?.n).toBe(MAX_FUTURE_APPOINTMENTS);
  });

  it('ultrasound room: two doctors at the same time, exactly one gets it', async () => {
    const w = await seedWorld(db.pool);
    const [d1, d2] = [await seedDoctor(db.pool, w), await seedDoctor(db.pool, w)] as [number, number];
    const [p1, p2] = [await seedPatient(db.pool, 1), await seedPatient(db.pool, 2)] as [number, number];
    const startsAt = kyivAt(day(0), '10:00');
    const hold = (doctorId: number, patientId: number) =>
      settle(svc.hold({ patientId, doctorId, clinicId: w.clinicId, serviceId: w.uziServiceId, startsAt, channel: 'online' }));

    const results = await Promise.all([hold(d1, p1), hold(d2, p2)]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(failureCodes(results)).toEqual(['ROOM_TAKEN']);
  });
});

describe('acceptance 6: hold expiry without Redis', () => {
  it('confirm works just before the TTL and is refused exactly at it', async () => {
    const s = await setup();
    const [p1, p2] = [await seedPatient(db.pool, 1), await seedPatient(db.pool, 2)] as [number, number];
    const a = await svc.hold(holdInput(s, p1, kyivAt(day(0), '10:00')));
    const b = await svc.hold(holdInput(s, p2, kyivAt(day(0), '12:00')));

    clock.set(new Date(NOW.getTime() + HOLD_MS - 1));
    await expect(svc.confirm(confirmInput(a.id, p1))).resolves.toMatchObject({ status: 'booked' });
    clock.set(new Date(NOW.getTime() + HOLD_MS));
    await expect(svc.confirm(confirmInput(b.id, p2))).rejects.toMatchObject({ code: 'HOLD_EXPIRED' });
  });

  it('after expiry confirm fails, the slot is free in the grid, and another patient can take it', async () => {
    const s = await setup();
    const [p1, p2] = [await seedPatient(db.pool, 1), await seedPatient(db.pool, 2)] as [number, number];
    const startsAt = kyivAt(day(0), '10:00');
    const first = await svc.hold(holdInput(s, p1, startsAt));

    clock.advance(10 * MINUTE_MS + 1_000); // 10:01 after the hold
    await expect(svc.confirm(confirmInput(first.id, p1))).rejects.toMatchObject({ code: 'HOLD_EXPIRED' });
    expect((await statusOf(first.id)).status).toBe('held'); // nothing reaped it; no Redis, no worker
    expect(await freeTimes(s, day(0))).toContain('10:00');

    const second = await svc.hold(holdInput(s, p2, startsAt));

    expect(second.status).toBe('held');
    expect(await statusOf(first.id)).toEqual({ status: 'cancelled', cancel_reason: 'hold_expired' });
    expect(await eventKinds(first.id)).toEqual(['held', 'hold_expired']);
    // The first patient's late confirm must not write over the new owner.
    await expect(svc.confirm(confirmInput(first.id, p1))).rejects.toMatchObject({ code: 'HOLD_EXPIRED' });
    expect((await statusOf(second.id)).status).toBe('held');
  });

  it('D2: a new hold cancels the own live and expired checkout holds but keeps a waitlist offer', async () => {
    const s = await setup();
    const patientId = await seedPatient(db.pool, 1);
    const [live, expired, offer] = [kyivAt(day(0), '10:00'), kyivAt(day(1), '10:00'), kyivAt(day(2), '10:00')];
    await db.inTx(NOW, async (tx) => {
      const base = { w: s.w, doctorId: s.doctorId, patientId, status: 'held' as const, createdAt: NOW };
      await insertRawAppointment(tx, { ...base, startsAt: live, holdKind: 'checkout', holdExpiresAt: new Date(NOW.getTime() + HOLD_MS) });
      await insertRawAppointment(tx, { ...base, startsAt: expired, holdKind: 'checkout', holdExpiresAt: new Date(NOW.getTime() - MINUTE_MS) });
      await insertRawAppointment(tx, { ...base, startsAt: offer, holdKind: 'waitlist_offer', holdExpiresAt: new Date(NOW.getTime() + 15 * MINUTE_MS) });
    });

    const created = await svc.hold(holdInput(s, patientId, kyivAt(day(3), '10:00')));

    const { rows } = await db.pool.query<{ starts_at: Date; status: string; cancel_reason: string | null; hold_kind: string | null }>(
      `SELECT starts_at, status, cancel_reason, hold_kind FROM appointments WHERE patient_id = $1 ORDER BY starts_at`,
      [patientId],
    );
    expect(rows.map((r) => [r.starts_at.getTime(), r.status, r.cancel_reason, r.hold_kind])).toEqual([
      [live.getTime(), 'cancelled', 'checkout_replaced', null],
      [expired.getTime(), 'cancelled', 'hold_expired', null],
      [offer.getTime(), 'held', null, 'waitlist_offer'],
      [created.startsAt.getTime(), 'held', null, 'checkout'],
    ]);
  });
});

describe('idempotent confirm', () => {
  it('the same key returns the same record, also when repeated in parallel', async () => {
    const s = await setup();
    const patientId = await seedPatient(db.pool, 1);
    const held = await svc.hold(holdInput(s, patientId, kyivAt(day(0), '10:00')));
    const input = confirmInput(held.id, patientId, 'key-1');

    const first = await svc.confirm(input);
    const again = await svc.confirm(input);
    const parallel = await Promise.all(Array.from({ length: 5 }, () => svc.confirm(input)));

    expect(again).toEqual(first);
    for (const r of parallel) expect(r).toEqual(first);
    expect(await eventKinds(held.id)).toEqual(['held', 'confirmed']);
  });

  it('the same key with different content is rejected and changes nothing', async () => {
    const s = await setup();
    const patientId = await seedPatient(db.pool, 1);
    const a = await svc.hold(holdInput(s, patientId, kyivAt(day(0), '10:00')));
    await svc.confirm(confirmInput(a.id, patientId, 'key-1'));
    const b = await svc.hold(holdInput(s, patientId, kyivAt(day(1), '10:00')));

    await expect(svc.confirm(confirmInput(b.id, patientId, 'key-1'))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });

    expect((await statusOf(b.id)).status).toBe('held');
  });

  it('a refusal is stored: replaying the key repeats HOLD_EXPIRED even if the situation changed', async () => {
    const s = await setup();
    const patientId = await seedPatient(db.pool, 1);
    const held = await svc.hold(holdInput(s, patientId, kyivAt(day(0), '10:00')));
    clock.advance(HOLD_MS);
    await expect(svc.confirm(confirmInput(held.id, patientId, 'key-1'))).rejects.toMatchObject({ code: 'HOLD_EXPIRED' });

    await expect(svc.confirm(confirmInput(held.id, patientId, 'key-1'))).rejects.toMatchObject({ code: 'HOLD_EXPIRED' });
    const { rows } = await db.pool.query(`SELECT 1 FROM idempotency_keys`);
    expect(rows).toHaveLength(1);
  });

  it('a new key for an already booked record returns it as success; another patient gets HOLD_NOT_FOUND', async () => {
    const s = await setup();
    const [p1, p2] = [await seedPatient(db.pool, 1), await seedPatient(db.pool, 2)] as [number, number];
    const booked = await bookOne(s, p1, kyivAt(day(0), '10:00'));

    await expect(svc.confirm(confirmInput(booked.id, p1))).resolves.toMatchObject({ id: booked.id, status: 'booked' });
    await expect(svc.confirm(confirmInput(booked.id, p2))).rejects.toMatchObject({ code: 'HOLD_NOT_FOUND' });
  });

  it('keys are scoped per patient and expire after 24 hours', async () => {
    const s = await setup();
    const [p1, p2] = [await seedPatient(db.pool, 1), await seedPatient(db.pool, 2)] as [number, number];
    const a = await svc.hold(holdInput(s, p1, kyivAt(day(0), '10:00')));
    const b = await svc.hold(holdInput(s, p2, kyivAt(day(0), '12:00')));
    await svc.confirm(confirmInput(a.id, p1, 'shared-key'));
    await expect(svc.confirm(confirmInput(b.id, p2, 'shared-key'))).resolves.toMatchObject({ status: 'booked' });

    clock.advance(24 * 60 * MINUTE_MS);
    const c = await svc.hold(holdInput(s, p1, kyivAt(day(1), '10:00')));
    await expect(svc.confirm(confirmInput(c.id, p1, 'shared-key'))).resolves.toMatchObject({ id: c.id, status: 'booked' });
  });
});

describe('booking window and schedule', () => {
  it('allows exactly now + 2h and refuses 15 minutes earlier', async () => {
    const s = await setup();
    const patientId = await seedPatient(db.pool, 1);
    const edge = new Date(NOW.getTime() + 2 * 60 * MINUTE_MS); // 13:00 Kyiv

    await expect(svc.hold(holdInput(s, patientId, new Date(edge.getTime() - 15 * MINUTE_MS)))).rejects.toMatchObject({
      code: 'SLOT_OUT_OF_WINDOW',
    });
    await expect(svc.hold(holdInput(s, patientId, edge))).resolves.toMatchObject({ status: 'held' });
  });

  it('allows now + 60 calendar days and refuses 15 minutes later', async () => {
    const s = await setup();
    const patientId = await seedPatient(db.pool, 1);
    const edge = kyivAt('2026-07-31', '11:00');

    await expect(svc.hold(holdInput(s, patientId, new Date(edge.getTime() + 15 * MINUTE_MS)))).rejects.toMatchObject({
      code: 'SLOT_OUT_OF_WINDOW',
    });
    await expect(svc.hold(holdInput(s, patientId, edge))).resolves.toMatchObject({ status: 'held' });
  });

  it('refuses times outside the grid, in the break and on a day off', async () => {
    const s = await setup({ breakStart: '13:00', breakEnd: '14:00' });
    const patientId = await seedPatient(db.pool, 1);
    await db.pool.query(
      `INSERT INTO schedule_exceptions (doctor_id, clinic_id, on_date, kind, reason, created_at) VALUES ($1,$2,$3,'day_off','sick',$4)`,
      [s.doctorId, s.w.clinicId, day(1), NOW],
    );
    const refused = (startsAt: Date) => svc.hold(holdInput(s, patientId, startsAt));

    await expect(refused(kyivAt(day(0), '08:45'))).rejects.toMatchObject({ code: 'OUTSIDE_WORKING_HOURS' });
    await expect(refused(kyivAt(day(0), '16:45'))).rejects.toMatchObject({ code: 'OUTSIDE_WORKING_HOURS' });
    await expect(refused(kyivAt(day(0), '13:00'))).rejects.toMatchObject({ code: 'OUTSIDE_WORKING_HOURS' });
    await expect(refused(kyivAt(day(0), '12:45'))).rejects.toMatchObject({ code: 'OUTSIDE_WORKING_HOURS' });
    await expect(refused(kyivAt(day(1), '10:00'))).rejects.toMatchObject({ code: 'OUTSIDE_WORKING_HOURS' });
    await expect(refused(new Date(kyivAt(day(0), '10:00').getTime() + 5 * MINUTE_MS))).rejects.toMatchObject({
      code: 'OUTSIDE_WORKING_HOURS',
    });
    await expect(refused(kyivAt(day(0), '12:30'))).resolves.toMatchObject({ status: 'held' });
  });

  it('refuses a service the doctor does not perform', async () => {
    const s = await setup();
    const patientId = await seedPatient(db.pool, 1);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO services (name, duration_minutes) VALUES ('Other',30) RETURNING id`,
    );
    const serviceId = Number(rows[0]?.id);
    await db.pool.query(`INSERT INTO clinic_services (clinic_id, service_id, price_minor) VALUES ($1,$2,1000)`, [s.w.clinicId, serviceId]);

    await expect(svc.hold(holdInput(s, patientId, kyivAt(day(0), '10:00'), serviceId))).rejects.toMatchObject({
      code: 'SERVICE_NOT_PROVIDED',
    });
  });
});

describe('patient rules', () => {
  it('online booking can be blocked; the registrar books the same patient anyway', async () => {
    const s = await setup();
    const patientId = await seedPatient(db.pool, 1);
    const until = new Date(NOW.getTime() + 5 * 24 * 60 * MINUTE_MS);
    await db.pool.query(`UPDATE patients SET online_booking_blocked_until = $1 WHERE id = $2`, [until, patientId]);
    const startsAt = kyivAt(day(0), '10:00');

    const err: unknown = await svc.hold(holdInput(s, patientId, startsAt)).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'ONLINE_BOOKING_BLOCKED', details: { blockedUntil: until.toISOString() } });
    await expect(svc.hold({ ...holdInput(s, patientId, startsAt), channel: 'front_desk' })).resolves.toMatchObject({
      status: 'held',
    });
  });

  it('one visit per doctor per local day, and no two visits at the same time', async () => {
    const s = await setup();
    const doctor2 = await seedDoctor(db.pool, s.w);
    const patientId = await seedPatient(db.pool, 1);
    await bookOne(s, patientId, kyivAt(day(0), '10:00'));

    await expect(svc.hold(holdInput(s, patientId, kyivAt(day(0), '15:00')))).rejects.toMatchObject({ code: 'DOCTOR_DAILY_LIMIT' });
    await expect(
      svc.hold({ ...holdInput(s, patientId, kyivAt(day(0), '10:15')), doctorId: doctor2 }),
    ).rejects.toMatchObject({ code: 'PATIENT_TIME_CONFLICT' });
  });

  it('a refused hold leaves the previous checkout hold untouched', async () => {
    const s = await setup();
    const [p1, p2] = [await seedPatient(db.pool, 1), await seedPatient(db.pool, 2)] as [number, number];
    const mine = await svc.hold(holdInput(s, p1, kyivAt(day(0), '10:00')));
    await svc.hold(holdInput(s, p2, kyivAt(day(0), '12:00')));

    await expect(svc.hold(holdInput(s, p1, kyivAt(day(0), '12:00')))).rejects.toMatchObject({ code: 'SLOT_TAKEN' });

    expect((await statusOf(mine.id)).status).toBe('held');
  });
});

describe('DST in the booking path', () => {
  it('Warsaw: a hold in the repeated autumn hour gets its own instant and the daily limit uses the local date', async () => {
    const w = await seedWorld(db.pool, 'Europe/Warsaw');
    const doctorId = await seedDoctor(db.pool, w, { workStart: '00:00', workEnd: '06:00' });
    const patientId = await seedPatient(db.pool, 1);
    clock.set(new Date('2026-10-20T08:00:00Z'));
    const s: Setup = { w, doctorId };
    const first = new Date('2026-10-25T00:00:00Z'); // 02:00 CEST
    const second = new Date('2026-10-25T01:15:00Z'); // 02:15 CET, an hour and 15 minutes later

    const booked = await bookOne(s, patientId, first);

    expect(booked.localDate).toBe('2026-10-25');
    await expect(svc.hold(holdInput(s, patientId, second))).rejects.toMatchObject({ code: 'DOCTOR_DAILY_LIMIT' });
  });

  it('Warsaw: 09:00 on the spring change day is 07:00 UTC (CEST), not 08:00', async () => {
    const w = await seedWorld(db.pool, 'Europe/Warsaw');
    const doctorId = await seedDoctor(db.pool, w);
    const patientId = await seedPatient(db.pool, 1);
    clock.set(new Date('2026-03-20T08:00:00Z'));
    const s: Setup = { w, doctorId };

    await expect(svc.hold(holdInput(s, patientId, new Date('2026-03-29T08:00:00Z')))).resolves.toMatchObject({
      localDate: '2026-03-29', // 10:00 CEST, on the grid
    });
    await expect(svc.hold(holdInput(s, patientId, new Date('2026-03-29T06:00:00Z')))).rejects.toMatchObject({
      code: 'OUTSIDE_WORKING_HOURS', // 08:00 CEST is before the 09:00 shift start
    });
  });
});
