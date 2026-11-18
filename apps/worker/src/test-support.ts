/** Shared setup for worker integration tests: real Postgres via @clinic/shared/testing, services booking real visits. */
import { randomUUID } from 'node:crypto';
import { BookingService, type Appointment, type Clock } from '@clinic/shared';
import { createTestDb, seedDoctor, seedPatient, seedWorld, type TestDb, type World } from '@clinic/shared/testing';
import type { Pool } from 'pg';
import { DEFAULT_CONFIG, type WorkerConfig } from './config.js';

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

/** 11:00 in Kyiv on Monday 1 June 2026. */
export const NOW = new Date('2026-06-01T08:00:00Z');

/** Small batches and no real waiting; the clock is the test's. */
export const TEST_CONFIG: WorkerConfig = { ...DEFAULT_CONFIG, batchSize: 7, sweepIntervalMs: 50, epochCheckMs: 100 };

export interface Setup {
  db: TestDb;
  svc: BookingService;
  w: World;
  doctorId: number;
}

export const openDb = (): Promise<TestDb> => createTestDb();

export async function setupWorld(
  db: TestDb,
  clock: Clock,
  timezone?: string,
  doctor?: Parameters<typeof seedDoctor>[2],
): Promise<Setup> {
  const w = await seedWorld(db.pool, timezone);
  const doctorId = await seedDoctor(db.pool, w, doctor);
  return { db, svc: new BookingService(db.pool, clock), w, doctorId };
}

/** A patient with an email address (the seed helper creates none). */
export async function patientWithEmail(pool: Pool, n: number, email: string | null = `p${n}@example.test`): Promise<number> {
  const id = await seedPatient(pool, n);
  await pool.query(`UPDATE patients SET email = $2 WHERE id = $1`, [id, email]);
  return id;
}

export async function bookVisit(s: Setup, patientId: number, startsAt: Date): Promise<Appointment> {
  const held = await s.svc.hold({
    patientId,
    doctorId: s.doctorId,
    clinicId: s.w.clinicId,
    serviceId: s.w.serviceId,
    startsAt,
    channel: 'online',
  });
  return s.svc.confirm({ appointmentId: held.id, patientId, idempotencyKey: randomUUID() });
}

export async function count(pool: Pool, sql: string, values: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(sql, values);
  return Number(rows[0]?.n ?? 0);
}

/** Polls until `check` returns a truthy value; fails with `what` after `timeoutMs`. */
export async function waitFor<T>(what: string, check: () => Promise<T | false | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
