import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '../clock.js';
import { createTestDb, type TestDb } from '../db/test-db.js';
import {
  insertRawAppointment,
  seedDoctor,
  seedPatient,
  seedWorld,
  type RawAppointment,
  type World,
} from '../db/test-fixtures.js';
import { loadFreeSlots } from './slots-repo.js';
import { zonedInstant } from './time.js';

const NOW = new Date('2026-06-01T08:00:00Z');
const DAY = '2026-06-03';
const MINUTE_MS = 60_000;

let db: TestDb;
const clock = new FixedClock(NOW);

beforeAll(async () => {
  db = await createTestDb();
}, 60_000);
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  clock.set(NOW);
  await db.reset();
});

const at = (time: string): Date => zonedInstant('Europe/Kyiv', DAY, time);

async function localTimes(w: World, serviceId: number, doctorId?: number): Promise<string[]> {
  const slots = await db.inTx(NOW, (tx) =>
    loadFreeSlots(tx, clock, { clinicId: w.clinicId, serviceId, ...(doctorId !== undefined && { doctorId }), fromDate: DAY, days: 1 }),
  );
  return slots.map((s) => s.localTime);
}

async function book(a: Omit<RawAppointment, 'createdAt'>): Promise<void> {
  await db.inTx(NOW, (tx) => insertRawAppointment(tx, { ...a, createdAt: NOW }));
}

describe('loadFreeSlots (real Postgres)', () => {
  it('lists the doctor grid and hides a booked visit together with its preparation time', async () => {
    const w = await seedWorld(db.pool);
    const doctorId = await seedDoctor(db.pool, w, { workStart: '09:00', workEnd: '11:00' });
    const patientId = await seedPatient(db.pool, 1);
    expect(await localTimes(w, w.serviceId)).toEqual(['09:00', '09:15', '09:30', '09:45', '10:00', '10:15', '10:30']);

    await book({ w, doctorId, patientId, startsAt: at('09:30'), status: 'booked' });

    // The 09:30-10:00 visit blocks until 10:05. A candidate also needs its own 5 minutes of preparation,
    // so 09:00 (blocked until 09:35) overlaps it and 10:15 is the first point after it.
    expect(await localTimes(w, w.serviceId)).toEqual(['10:15', '10:30']);
  });

  it('T8: an expired checkout hold is free, exactly at expiry too; a live one blocks', async () => {
    const w = await seedWorld(db.pool);
    const doctorId = await seedDoctor(db.pool, w, { workStart: '09:00', workEnd: '10:30' });
    const patientId = await seedPatient(db.pool, 1);
    const expiresAt = new Date(NOW.getTime() + 10 * MINUTE_MS);
    await book({ w, doctorId, patientId, startsAt: at('09:00'), status: 'held', holdKind: 'checkout', holdExpiresAt: expiresAt });

    clock.set(new Date(expiresAt.getTime() - 1));
    expect(await localTimes(w, w.serviceId)).not.toContain('09:00');
    clock.set(expiresAt);
    expect(await localTimes(w, w.serviceId)).toContain('09:00');
  });

  it('T8: an expired waitlist offer still blocks until the sweeper handles it (R2)', async () => {
    const w = await seedWorld(db.pool);
    const doctorId = await seedDoctor(db.pool, w, { workStart: '09:00', workEnd: '10:30' });
    const patientId = await seedPatient(db.pool, 1);
    const expiresAt = new Date(NOW.getTime() + 15 * MINUTE_MS);
    await book({ w, doctorId, patientId, startsAt: at('09:00'), status: 'held', holdKind: 'waitlist_offer', holdExpiresAt: expiresAt });

    clock.set(new Date(expiresAt.getTime() + 60 * MINUTE_MS));
    expect(await localTimes(w, w.serviceId)).not.toContain('09:00');
  });

  it('a cancelled appointment frees its slot', async () => {
    const w = await seedWorld(db.pool);
    const doctorId = await seedDoctor(db.pool, w, { workStart: '09:00', workEnd: '10:30' });
    const patientId = await seedPatient(db.pool, 1);
    await book({ w, doctorId, patientId, startsAt: at('09:00'), status: 'cancelled' });
    expect(await localTimes(w, w.serviceId)).toContain('09:00');
  });

  it('T9: an ultrasound booking by one doctor blocks the other doctor, an ordinary service is unaffected', async () => {
    const w = await seedWorld(db.pool);
    const d1 = await seedDoctor(db.pool, w, { workStart: '09:00', workEnd: '11:00' });
    const d2 = await seedDoctor(db.pool, w, { workStart: '09:00', workEnd: '11:00' });
    const patientId = await seedPatient(db.pool, 1);
    await book({ w, doctorId: d1, patientId, startsAt: at('09:30'), status: 'booked', ultrasound: true });

    const uziForD2 = await localTimes(w, w.uziServiceId, d2);
    expect(uziForD2).not.toContain('09:30');
    expect(uziForD2).not.toContain('09:45');
    expect(await localTimes(w, w.serviceId, d2)).toContain('09:30');
  });

  it('a day_off exception removes the day for that doctor only', async () => {
    const w = await seedWorld(db.pool);
    const d1 = await seedDoctor(db.pool, w);
    await seedDoctor(db.pool, w);
    await db.pool.query(
      `INSERT INTO schedule_exceptions (doctor_id, clinic_id, on_date, kind, reason, created_at)
       VALUES ($1,$2,$3,'day_off','sick',$4)`,
      [d1, w.clinicId, DAY, NOW],
    );
    const slots = await db.inTx(NOW, (tx) =>
      loadFreeSlots(tx, clock, { clinicId: w.clinicId, serviceId: w.serviceId, fromDate: DAY, days: 1 }),
    );
    expect(new Set(slots.map((s) => s.doctorId)).size).toBe(1);
    expect(slots.every((s) => s.doctorId !== d1)).toBe(true);
  });

  it('returns nothing for a service the clinic does not offer', async () => {
    const w = await seedWorld(db.pool);
    await seedDoctor(db.pool, w);
    const other = await db.pool.query<{ id: string }>(
      `INSERT INTO services (name, duration_minutes) VALUES ('Other',30) RETURNING id`,
    );
    const serviceId = Number(other.rows[0]?.id);
    expect(await localTimes(w, serviceId)).toEqual([]);
  });
});
