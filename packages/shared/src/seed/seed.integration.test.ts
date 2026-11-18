import { scryptSync } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '../db/test-db.js';
import { DEMO_PASSWORD, PATIENT_COUNT, runSeed, type SeedReport } from './seed.js';

const SEED_TIMEOUT_MS = 180_000;
const MIN_APPOINTMENTS = 140_000;
const MAX_FUTURE_PER_PATIENT = 3;

let db: TestDb;
let report: SeedReport;
let totalMs = 0;

async function scalar(sql: string): Promise<number> {
  const { rows } = await db.pool.query<{ v: string }>(sql);
  return Number(rows[0]?.v ?? Number.NaN);
}

beforeAll(async () => {
  db = await createTestDb();
  const client = await db.pool.connect();
  try {
    const started = performance.now();
    report = await runSeed(client, '2026-11-18T12:00:00.000Z');
    totalMs = Math.round(performance.now() - started);
  } finally {
    client.release();
  }
  console.log(`[seed] ${report.appointments} appointments in ${totalMs} ms`, JSON.stringify(report.timingsMs));
}, SEED_TIMEOUT_MS);

afterAll(async () => {
  await db.close();
});

describe('demo seed', () => {
  it('produces the specified volumes', async () => {
    expect(report.skipped).toBe(false);
    expect(report.appointments).toBeGreaterThan(MIN_APPOINTMENTS);
    expect(await scalar('SELECT count(*) AS v FROM clinics')).toBe(3);
    expect(await scalar('SELECT count(*) AS v FROM doctors')).toBe(40);
    expect(await scalar('SELECT count(*) AS v FROM services')).toBe(15);
    expect(await scalar('SELECT count(*) AS v FROM patients')).toBe(PATIENT_COUNT);
    expect(await scalar('SELECT count(*) AS v FROM appointments')).toBe(report.appointments);
  });

  it('keeps cancelled and no_show between 40 and 50 percent', async () => {
    const share = await scalar(
      "SELECT count(*) FILTER (WHERE status IN ('cancelled','no_show'))::float / count(*) AS v FROM appointments",
    );
    expect(share).toBeGreaterThanOrEqual(0.4);
    expect(share).toBeLessThanOrEqual(0.5);
  });

  it('records cancel events so the late-cancel share is computable', async () => {
    const cancelled = await scalar("SELECT count(*) AS v FROM appointments WHERE status = 'cancelled'");
    expect(await scalar("SELECT count(*) AS v FROM appointment_events WHERE kind = 'cancelled'")).toBe(cancelled);
    const late = await scalar("SELECT count(*) AS v FROM appointment_events WHERE kind = 'cancelled' AND is_late");
    expect(late).toBeGreaterThan(0);
    expect(late).toBeLessThan(cancelled);
    expect(await scalar("SELECT count(*) AS v FROM appointments WHERE status = 'cancelled' AND cancel_reason IS NULL")).toBe(0);
  });

  it('respects the future limit, local_date and the re-created constraints', async () => {
    expect(
      await scalar(`SELECT coalesce(max(c), 0) AS v FROM (SELECT count(*) AS c FROM appointments
        WHERE status <> 'cancelled' AND starts_at > '2026-11-18T12:00:00Z' GROUP BY patient_id) x`),
    ).toBeLessThanOrEqual(MAX_FUTURE_PER_PATIENT);
    expect(
      await scalar(`SELECT count(*) AS v FROM appointments a JOIN clinics c ON c.id = a.clinic_id
        WHERE a.local_date <> (a.starts_at AT TIME ZONE c.timezone)::date`),
    ).toBe(0);
    expect(await scalar("SELECT count(*) AS v FROM pg_constraint WHERE conrelid = 'appointments'::regclass AND contype = 'x'")).toBe(3);
    expect(await scalar("SELECT count(*) AS v FROM pg_trigger WHERE tgrelid = 'appointments'::regclass AND tgenabled = 'D'")).toBe(0);
  });

  it('stores demo logins in the scrypt format used by the API', async () => {
    const { rows } = await db.pool.query<{ role: string; password_hash: string }>(
      "SELECT role, password_hash FROM users WHERE email IN ('manager@clinic.local','reception1@clinic.local','doctor1@clinic.local','patient1@clinic.local') ORDER BY email",
    );
    expect(rows.map((r) => r.role).sort()).toEqual(['doctor', 'manager', 'patient', 'receptionist']);
    for (const row of rows) {
      const [salt = '', key = ''] = row.password_hash.split(':');
      expect(scryptSync(DEMO_PASSWORD, Buffer.from(salt, 'base64'), 64).toString('base64')).toBe(key);
    }
  });

  it('is idempotent: a second run skips', async () => {
    const client = await db.pool.connect();
    try {
      expect((await runSeed(client)).skipped).toBe(true);
    } finally {
      client.release();
    }
    expect(await scalar('SELECT count(*) AS v FROM appointments')).toBe(report.appointments);
  });
});
