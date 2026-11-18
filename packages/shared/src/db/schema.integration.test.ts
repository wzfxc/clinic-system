import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_FUTURE_APPOINTMENTS } from '../rules.js';
import { createTestDb, type TestDb } from './test-db.js';

const CLOCK = new Date('2026-06-01T08:00:00Z');
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const PARALLEL = 20;

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
}, 60_000);
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  await db.reset();
});

interface PgError extends Error {
  code?: string;
  constraint?: string;
}

async function one(pool: Pool, text: string, values: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(text, values);
  const row = rows[0];
  if (!row) throw new Error('no row returned');
  return Number(row.id);
}

interface World {
  clinicId: number;
  serviceId: number;
  uziServiceId: number;
}

/** One Kyiv clinic offering a plain service and an ultrasound service. */
async function seedWorld(): Promise<World> {
  const { pool } = db;
  const clinicId = await one(
    pool,
    `INSERT INTO clinics (city, name, timezone, currency) VALUES ('Kyiv','C1','Europe/Kyiv','UAH') RETURNING id`,
  );
  const serviceId = await one(
    pool,
    `INSERT INTO services (name, duration_minutes, uses_ultrasound_room) VALUES ('Consult',30,false) RETURNING id`,
  );
  const uziServiceId = await one(
    pool,
    `INSERT INTO services (name, duration_minutes, uses_ultrasound_room) VALUES ('Ultrasound',30,true) RETURNING id`,
  );
  for (const sid of [serviceId, uziServiceId]) {
    await pool.query(`INSERT INTO clinic_services (clinic_id, service_id, price_minor) VALUES ($1,$2,50000)`, [clinicId, sid]);
  }
  return { clinicId, serviceId, uziServiceId };
}

async function seedDoctor(w: World): Promise<number> {
  const { pool } = db;
  const doctorId = await one(pool, `INSERT INTO doctors (specialty) VALUES ('general') RETURNING id`);
  await pool.query(`INSERT INTO doctor_clinics (doctor_id, clinic_id) VALUES ($1,$2)`, [doctorId, w.clinicId]);
  for (const sid of [w.serviceId, w.uziServiceId]) {
    await pool.query(`INSERT INTO doctor_services (doctor_id, service_id) VALUES ($1,$2)`, [doctorId, sid]);
  }
  return doctorId;
}

const seedPatient = (n: number): Promise<number> =>
  one(db.pool, `INSERT INTO patients (full_name) VALUES ($1) RETURNING id`, [`Patient ${n}`]);

interface NewAppointment {
  w: World;
  doctorId: number;
  patientId: number;
  startsAt: Date;
  ultrasound?: boolean;
}

/** Inserts a 30-minute `held` appointment (checkout hold, 10 minutes TTL). */
async function insertHeld(client: PoolClient, a: NewAppointment): Promise<void> {
  const endsAt = new Date(a.startsAt.getTime() + 30 * MINUTE_MS);
  const blockedUntil = new Date(endsAt.getTime() + 5 * MINUTE_MS);
  await client.query(
    `INSERT INTO appointments
       (clinic_id, doctor_id, patient_id, service_id, status, starts_at, ends_at, blocked_until,
        uses_ultrasound_room, price_minor, currency, hold_kind, hold_expires_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,'held',$5,$6,$7,$8,50000,'UAH','checkout',$9,$10,$10)`,
    [
      a.w.clinicId,
      a.doctorId,
      a.patientId,
      a.ultrasound ? a.w.uziServiceId : a.w.serviceId,
      a.startsAt,
      endsAt,
      blockedUntil,
      a.ultrasound ?? false,
      new Date(CLOCK.getTime() + 10 * MINUTE_MS),
      CLOCK,
    ],
  );
}

const DEADLOCK_RETRIES = 5;

/**
 * Own transaction per call; resolves to null on success or the Postgres error.
 * Two concurrent inserts into the same exclusion index may both see each other's
 * uncommitted entry, and Postgres then aborts one with 40P01 instead of 23P01.
 * The service layer retries such a transaction (docs/analysis/03, "Обробка 23P01
 * і ретраї"), so the helper does the same; the retry sees the committed winner.
 */
async function attempt(a: NewAppointment): Promise<PgError | null> {
  for (let tries = 0; ; tries++) {
    try {
      await db.inTx(CLOCK, (c) => insertHeld(c, a));
      return null;
    } catch (err) {
      const pgErr = err as PgError;
      if (pgErr.code !== '40P01' || tries >= DEADLOCK_RETRIES) return pgErr;
    }
  }
}

const SLOT = new Date('2026-06-10T09:00:00Z');
const outcomes = (results: (PgError | null)[]) => ({
  ok: results.filter((r) => r === null).length,
  failed: results.filter((r): r is PgError => r !== null),
});

describe('exclusion constraints and limit trigger (real Postgres)', () => {
  it('(a) 20 parallel holds on one doctor slot: exactly one wins, the rest get 23P01', async () => {
    const w = await seedWorld();
    const doctorId = await seedDoctor(w);
    const patients = await Promise.all(Array.from({ length: PARALLEL }, (_, i) => seedPatient(i)));

    const results = await Promise.all(patients.map((patientId) => attempt({ w, doctorId, patientId, startsAt: SLOT })));

    const { ok, failed } = outcomes(results);
    expect(ok).toBe(1);
    expect(failed).toHaveLength(PARALLEL - 1);
    for (const err of failed) {
      expect(err.code).toBe('23P01');
      expect(err.constraint).toBe('appt_doctor_no_overlap');
    }
  });

  it('(b) ultrasound: two doctors at the same time, only one booking passes', async () => {
    const w = await seedWorld();
    const [d1, d2] = [await seedDoctor(w), await seedDoctor(w)] as [number, number];
    const [p1, p2] = [await seedPatient(1), await seedPatient(2)] as [number, number];

    const results = await Promise.all([
      attempt({ w, doctorId: d1, patientId: p1, startsAt: SLOT, ultrasound: true }),
      attempt({ w, doctorId: d2, patientId: p2, startsAt: SLOT, ultrasound: true }),
    ]);

    const { ok, failed } = outcomes(results);
    expect(ok).toBe(1);
    expect(failed[0]?.code).toBe('23P01');
    expect(failed[0]?.constraint).toBe('appt_ultrasound_no_overlap');
  });

  it('(b) control: the same two doctors at the same time both pass without ultrasound', async () => {
    const w = await seedWorld();
    const [d1, d2] = [await seedDoctor(w), await seedDoctor(w)] as [number, number];
    const [p1, p2] = [await seedPatient(1), await seedPatient(2)] as [number, number];

    const results = await Promise.all([
      attempt({ w, doctorId: d1, patientId: p1, startsAt: SLOT }),
      attempt({ w, doctorId: d2, patientId: p2, startsAt: SLOT }),
    ]);

    expect(outcomes(results).ok).toBe(2);
  });

  it('(c) the same patient cannot be booked twice at the same time', async () => {
    const w = await seedWorld();
    const [d1, d2] = [await seedDoctor(w), await seedDoctor(w)] as [number, number];
    const patientId = await seedPatient(1);

    const results = await Promise.all([
      attempt({ w, doctorId: d1, patientId, startsAt: SLOT }),
      attempt({ w, doctorId: d2, patientId, startsAt: SLOT }),
    ]);

    const { ok, failed } = outcomes(results);
    expect(ok).toBe(1);
    expect(failed[0]?.code).toBe('23P01');
    expect(failed[0]?.constraint).toBe('appt_patient_no_overlap');
  });

  it('same patient and doctor on one local day is rejected by the unique index (23505)', async () => {
    const w = await seedWorld();
    const doctorId = await seedDoctor(w);
    const patientId = await seedPatient(1);

    expect(await attempt({ w, doctorId, patientId, startsAt: SLOT })).toBeNull();
    const err = await attempt({ w, doctorId, patientId, startsAt: new Date(SLOT.getTime() + 3 * 60 * MINUTE_MS) });

    expect(err?.code).toBe('23505');
    expect(err?.constraint).toBe('appt_patient_doctor_day_uq');
  });

  it('(d) with 2 future appointments already, 5 parallel inserts on different slots let only one through', async () => {
    const w = await seedWorld();
    const doctorId = await seedDoctor(w);
    const patientId = await seedPatient(1);
    const day = (n: number) => new Date(SLOT.getTime() + n * DAY_MS);

    expect(await attempt({ w, doctorId, patientId, startsAt: day(0) })).toBeNull();
    expect(await attempt({ w, doctorId, patientId, startsAt: day(1) })).toBeNull();

    const results = await Promise.all(
      [2, 3, 4, 5, 6].map((n) => attempt({ w, doctorId, patientId, startsAt: day(n) })),
    );

    const { ok, failed } = outcomes(results);
    expect(ok).toBe(MAX_FUTURE_APPOINTMENTS - 2);
    expect(failed).toHaveLength(4);
    for (const err of failed) expect(err.code).toBe('CL001');
    const { rows } = await db.pool.query(`SELECT count(*)::int AS n FROM appointments WHERE patient_id = $1`, [patientId]);
    expect(rows[0]).toEqual({ n: MAX_FUTURE_APPOINTMENTS });
  });

  it('(e) without SET LOCAL app.clock_now the trigger raises CL003', async () => {
    const w = await seedWorld();
    const doctorId = await seedDoctor(w);
    const patientId = await seedPatient(1);

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await expect(insertHeld(client, { w, doctorId, patientId, startsAt: SLOT })).rejects.toMatchObject({ code: 'CL003' });
      await client.query('ROLLBACK');

      // A connection that already used the setting in a finished transaction must still fail.
      await db.inTx(CLOCK, async () => undefined);
      await client.query('BEGIN');
      await expect(insertHeld(client, { w, doctorId, patientId, startsAt: SLOT })).rejects.toMatchObject({ code: 'CL003' });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  });

  it('cancelled appointments free the slot, and local_date follows the clinic zone', async () => {
    const w = await seedWorld();
    const doctorId = await seedDoctor(w);
    const [p1, p2] = [await seedPatient(1), await seedPatient(2)] as [number, number];
    // 22:30Z on 10 June is 01:30 on 11 June in Kyiv (UTC+3).
    const late = new Date('2026-06-10T22:30:00Z');

    expect(await attempt({ w, doctorId, patientId: p1, startsAt: late })).toBeNull();
    await db.inTx(CLOCK, (c) => c.query(`UPDATE appointments SET status='cancelled', hold_kind=NULL, hold_expires_at=NULL, cancel_reason='patient'`));
    expect(await attempt({ w, doctorId, patientId: p2, startsAt: late })).toBeNull();

    const { rows } = await db.pool.query<{ local_date: string }>(
      `SELECT local_date::text FROM appointments WHERE patient_id = $1`,
      [p2],
    );
    expect(rows[0]?.local_date).toBe('2026-06-11');
  });

  it('status transitions and append-only history are enforced', async () => {
    const w = await seedWorld();
    const doctorId = await seedDoctor(w);
    const patientId = await seedPatient(1);
    await attempt({ w, doctorId, patientId, startsAt: SLOT });

    await db.inTx(CLOCK, (c) =>
      c.query(`UPDATE appointments SET status='booked', hold_kind=NULL, hold_expires_at=NULL`),
    );
    await expect(db.inTx(CLOCK, (c) => c.query(`UPDATE appointments SET status='held'`))).rejects.toMatchObject({ code: 'CL002' });
    await db.inTx(CLOCK, (c) => c.query(`UPDATE appointments SET status='completed'`));
    await expect(db.inTx(CLOCK, (c) => c.query(`UPDATE appointments SET status='booked'`))).rejects.toMatchObject({ code: 'CL002' });

    const { rows } = await db.pool.query<{ kind: string }>(`SELECT kind FROM appointment_events ORDER BY id`);
    expect(rows.map((r) => r.kind)).toEqual(['held', 'confirmed', 'completed']);
    await expect(db.inTx(CLOCK, (c) => c.query(`DELETE FROM appointment_events`))).rejects.toMatchObject({ code: 'CL004' });
    await expect(db.inTx(CLOCK, (c) => c.query(`UPDATE appointment_events SET reason = 'x'`))).rejects.toMatchObject({ code: 'CL004' });
    await db.inTx(CLOCK, (c) => c.query(`UPDATE appointment_events SET processed_at = $1`, [CLOCK]));
  });

  it('late cancel is a strike, a system cancel (sick leave) is not', async () => {
    const w = await seedWorld();
    const doctorId = await seedDoctor(w);
    const [p1, p2] = [await seedPatient(1), await seedPatient(2)] as [number, number];
    const soon = new Date(CLOCK.getTime() + 5 * 60 * MINUTE_MS); // 5 hours ahead: inside the 24h window
    for (const [patientId, startsAt] of [[p1, soon], [p2, new Date(soon.getTime() + 60 * MINUTE_MS)]] as const) {
      expect(await attempt({ w, doctorId, patientId, startsAt })).toBeNull();
    }
    await db.inTx(CLOCK, (c) => c.query(`UPDATE appointments SET status='booked', hold_kind=NULL, hold_expires_at=NULL`));
    await db.inTx(CLOCK, (c) => c.query(`UPDATE appointments SET status='cancelled', cancel_reason='patient' WHERE patient_id=$1`, [p1]));
    await db.inTx(CLOCK, (c) => c.query(`UPDATE appointments SET status='cancelled', cancel_reason='sick_leave' WHERE patient_id=$1`, [p2]));

    const { rows } = await db.pool.query<{ patient_id: string; is_late: boolean; is_strike: boolean }>(
      `SELECT patient_id, is_late, is_strike FROM appointment_events WHERE kind='cancelled' ORDER BY patient_id`,
    );
    expect(rows.map((r) => [Number(r.patient_id), r.is_late, r.is_strike])).toEqual([
      [p1, true, true],
      [p2, false, false],
    ]);
  });

  it('moving a past appointment into the future cannot exceed the limit', async () => {
    const w = await seedWorld();
    const doctorId = await seedDoctor(w);
    const patientId = await seedPatient(1);
    for (let n = 0; n < MAX_FUTURE_APPOINTMENTS; n++) {
      expect(await attempt({ w, doctorId, patientId, startsAt: new Date(SLOT.getTime() + n * DAY_MS) })).toBeNull();
    }
    await db.inTx(CLOCK, (c) => c.query(`UPDATE appointments SET status='booked', hold_kind=NULL, hold_expires_at=NULL`));
    // A past booking is outside the count, so inserting it passes.
    const past = new Date('2026-05-20T09:00:00Z');
    await db.inTx(CLOCK, async (c) => {
      await insertHeld(c, { w, doctorId, patientId, startsAt: past });
      await c.query(`UPDATE appointments SET status='booked', hold_kind=NULL, hold_expires_at=NULL WHERE starts_at=$1`, [past]);
    });
    const target = new Date(SLOT.getTime() + 10 * DAY_MS);
    const move = db.inTx(CLOCK, (c) =>
      c.query(
        `UPDATE appointments SET starts_at=$1, ends_at=$1::timestamptz + interval '30 minutes',
                blocked_until=$1::timestamptz + interval '35 minutes' WHERE starts_at=$2`,
        [target, past],
      ),
    );
    await expect(move).rejects.toMatchObject({ code: 'CL001' });
  });

  it('local_date cannot be overwritten by hand', async () => {
    const w = await seedWorld();
    const doctorId = await seedDoctor(w);
    const patientId = await seedPatient(1);
    expect(await attempt({ w, doctorId, patientId, startsAt: SLOT })).toBeNull();

    await db.inTx(CLOCK, (c) => c.query(`UPDATE appointments SET local_date = '2030-01-01'`));

    const { rows } = await db.pool.query<{ local_date: string }>(`SELECT local_date::text FROM appointments`);
    expect(rows[0]?.local_date).toBe('2026-06-10');
  });

  it('migrations keep the expected constraints and triggers (nothing silently lost)', async () => {
    const constraints = await db.pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE contype = 'x' ORDER BY conname`,
    );
    expect(constraints.rows.map((r) => r.conname)).toEqual([
      'appt_doctor_no_overlap',
      'appt_patient_no_overlap',
      'appt_ultrasound_no_overlap',
      'schedule_templates_no_overlap',
    ]);
    const triggers = await db.pool.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname`,
    );
    expect(triggers.rows.map((r) => r.tgname)).toEqual([
      'appointment_events_append_only',
      'appointments_a_local_date',
      'appointments_b_patient_limit',
      'appointments_c_status_transition',
      'appointments_history',
    ]);
  });
});
