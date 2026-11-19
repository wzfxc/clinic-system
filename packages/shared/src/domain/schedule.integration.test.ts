/**
 * Schedule integrity tests (real Postgres):
 * - Vacation (`day_off`, `reason = 'vacation'`) on a day with 12 live visits is rejected with CONFLICT.
 * - Narrowing a weekly template (e.g. Thursday to 09:00-09:30) when existing future appointments fall outside
 *   the new hours is rejected with CONFLICT.
 * - Updating a weekly template splits `valid_during` at `effectiveFrom` so past dates keep their historical
 *   hours and are never overwritten.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '../clock.js';
import { createTestDb, insertRawAppointment, seedDoctor, seedPatient, seedWorld, type TestDb, type World } from '../testing.js';
import { BookingService } from './booking-service.js';
import type { AuthActor } from './actor.js';
import { MINUTE_MS } from './time.js';

const NOW = new Date('2026-06-01T08:00:00Z'); // Monday

let db: TestDb;
let clock: FixedClock;
let svc: BookingService;
let world: World;
let doctorId: number;
let registrar: AuthActor;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.reset();
  clock = new FixedClock(NOW);
  svc = new BookingService(db.pool, clock);
  world = await seedWorld(db.pool);
  // Doctor works Monday..Friday 09:00-17:00 (Europe/Kyiv, UTC+3 -> 06:00Z-14:00Z)
  doctorId = await seedDoctor(db.pool, world, {
    workStart: '09:00',
    workEnd: '17:00',
    weekdays: [1, 2, 3, 4, 5],
  });
  registrar = { role: 'receptionist', userId: 1, clinicId: world.clinicId };
});

describe('schedule integrity against existing appointments', () => {
  it('refuses setting vacation on a day that has 12 active appointments with CONFLICT', async () => {
    // Thursday 2026-06-04: place 12 appointments of 30 min (+ 5 min buffer), spaced every 35-45 min on the 15-min grid
    const baseStart = new Date('2026-06-04T06:00:00Z').getTime(); // 09:00 Kyiv
    for (let i = 0; i < 12; i += 1) {
      const pid = await seedPatient(db.pool, i + 1);
      const startsAt = new Date(baseStart + i * 45 * MINUTE_MS);
      await db.inTx(NOW, (client) =>
        insertRawAppointment(client, { w: world, doctorId, patientId: pid, startsAt, createdAt: NOW }),
      );
    }

    await expect(
      svc.upsertScheduleException({
        doctorId,
        clinicId: world.clinicId,
        date: '2026-06-04',
        kind: 'day_off',
        reason: 'vacation',
        actor: registrar,
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { conflictingAppointments: 12 },
    });

    // All 12 appointments remain booked and no day_off row was inserted
    const { rows } = await db.pool.query<{ count: string }>(
      `SELECT count(*) FROM appointments WHERE doctor_id = $1 AND local_date = '2026-06-04' AND status = 'booked'`,
      [doctorId],
    );
    expect(Number(rows[0]?.count)).toBe(12);
  });

  it('refuses narrowing a Thursday template to 09:00-09:30 when existing appointments fall outside the new hours', async () => {
    // Place bookings across future Thursdays (2026-06-04, 2026-06-11, 2026-06-18, 2026-06-25, 2026-07-02)
    const thursdays = ['2026-06-04', '2026-06-11', '2026-06-18', '2026-06-25', '2026-07-02'];
    let placed = 0;
    for (const date of thursdays) {
      const dayStart = new Date(`${date}T06:00:00Z`).getTime(); // 09:00 Kyiv
      for (let slot = 0; slot < 11; slot += 1) {
        const pid = await seedPatient(db.pool, placed + 1);
        const startsAt = new Date(dayStart + slot * 45 * MINUTE_MS);
        await db.inTx(NOW, (client) =>
          insertRawAppointment(client, { w: world, doctorId, patientId: pid, startsAt, createdAt: NOW }),
        );
        placed += 1;
      }
    }
    expect(placed).toBe(55); // 5 Thursdays * 11 bookings (50 sit after 09:30)

    await expect(
      svc.upsertScheduleTemplate({
        doctorId,
        clinicId: world.clinicId,
        weekday: 4, // Thursday
        workStart: '09:00',
        workEnd: '09:30',
        actor: registrar,
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { conflictingAppointments: 50 },
    });
  });

  it('splits valid_during at effectiveFrom so past dates keep their historical template', async () => {
    // Update Thursday (weekday 4) template starting from 2026-06-04 to 09:00-15:00
    await svc.upsertScheduleTemplate({
      doctorId,
      clinicId: world.clinicId,
      weekday: 4,
      workStart: '09:00',
      workEnd: '15:00',
      effectiveFrom: '2026-06-04',
      actor: registrar,
    });

    const { rows } = await db.pool.query<{
      work_start: string;
      work_end: string;
      valid_from: string | null;
      valid_until: string | null;
    }>(
      `SELECT work_start::text, work_end::text,
              lower(valid_during)::text AS valid_from,
              upper(valid_during)::text AS valid_until
         FROM schedule_templates
        WHERE doctor_id = $1 AND clinic_id = $2 AND weekday = 4
        ORDER BY lower(valid_during) NULLS FIRST`,
      [doctorId, world.clinicId],
    );

    expect(rows).toEqual([
      { work_start: '09:00:00', work_end: '17:00:00', valid_from: null, valid_until: '2026-06-04' },
      { work_start: '09:00:00', work_end: '15:00:00', valid_from: '2026-06-04', valid_until: null },
    ]);
  });
});
