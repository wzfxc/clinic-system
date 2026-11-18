/**
 * Sweeper, Redis-loss recovery and several worker copies against real Postgres and real Redis
 * (acceptance 10, 11 and 13 of docs/analysis/04). Handlers run with a FixedClock; BullMQ is
 * only the trigger, so time-dependent behaviour is driven by the sweeper after `clock.advance`.
 */
import { randomUUID } from 'node:crypto';
import { FixedClock, loadEnv, zonedInstant } from '@clinic/shared';
import { insertRawAppointment, seedPatient, type TestDb } from '@clinic/shared/testing';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RecordingMailer } from './mailer.js';
import { WorkerRuntime } from './runtime.js';
import { sweepOnce } from './sweeper.js';
import { jobIds, TIMERS_QUEUE } from './triggers.js';
import {
  bookVisit, count, HOUR_MS, NOW, openDb, patientWithEmail, setupWorld, TEST_CONFIG, waitFor, type Setup,
} from './test-support.js';

const MINUTE_MS = 60_000;
let db: TestDb;
let redis: Redis;
const clock = new FixedClock(NOW);
const mailer = new RecordingMailer();
const runtimes: WorkerRuntime[] = [];
const errors: string[] = [];
let prefix: string;

beforeAll(async () => {
  db = await openDb();
  redis = new Redis(loadEnv().REDIS_URL);
}, 60_000);
afterAll(async () => {
  await db.close();
  redis.disconnect();
});
beforeEach(async () => {
  clock.set(NOW);
  mailer.sent.length = 0;
  errors.length = 0;
  prefix = `test-${randomUUID()}`;
  await db.reset();
});
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.stop()));
});

const kyiv = (date: string, time: string): Date => zonedInstant('Europe/Kyiv', date, time);

async function startWorker(name: string, shared: RecordingMailer = mailer): Promise<WorkerRuntime> {
  const runtime = new WorkerRuntime({
    pool: db.pool,
    clock,
    mailer: shared,
    workerId: name,
    config: TEST_CONFIG,
    redisUrl: loadEnv().REDIS_URL,
    bullPrefix: prefix,
    onError: (message, err) => errors.push(`${message}: ${String(err)}`),
  });
  runtimes.push(runtime);
  await runtime.start();
  return runtime;
}

const sweepDeps = (workerId: string) => ({ pool: db.pool, clock, mailer, workerId, config: TEST_CONFIG });

async function statusOf(id: number): Promise<string> {
  const { rows } = await db.pool.query<{ status: string }>(`SELECT status FROM appointments WHERE id = $1`, [id]);
  return rows[0]?.status ?? 'missing';
}

describe('sweeper', () => {
  it('frees expired checkout holds only, and purges only expired idempotency keys', async () => {
    const s = await setupWorld(db, clock);
    const p1 = await patientWithEmail(db.pool, 1);
    const p2 = await seedPatient(db.pool, 2);
    const checkout = await s.svc.hold({
      patientId: p1, doctorId: s.doctorId, clinicId: s.w.clinicId, serviceId: s.w.serviceId,
      startsAt: kyiv('2026-06-05', '10:00'), channel: 'online',
    });
    const offerStart = kyiv('2026-06-05', '12:00');
    await db.inTx(NOW, (c) =>
      insertRawAppointment(c, {
        w: s.w, doctorId: s.doctorId, patientId: p2, startsAt: offerStart, status: 'held',
        holdKind: 'waitlist_offer', holdExpiresAt: new Date(NOW.getTime() + 5 * MINUTE_MS), createdAt: NOW,
      }),
    );
    await db.pool.query(
      `INSERT INTO idempotency_keys (scope, actor_id, key, request_hash, response, created_at, expires_at) VALUES
        ('confirm', 1, 'old', 'h', '{}', $1, $2), ('confirm', 1, 'live', 'h', '{}', $1, $3)`,
      [NOW, new Date(NOW.getTime() + 5 * MINUTE_MS), new Date(NOW.getTime() + 24 * HOUR_MS)],
    );

    expect(await sweepOnce(sweepDeps('w1'))).toMatchObject({ holdsFreed: 0, keysPurged: 0 });
    clock.advance(11 * MINUTE_MS);
    expect(await sweepOnce(sweepDeps('w1'))).toMatchObject({ holdsFreed: 1, keysPurged: 1 });

    expect(await statusOf(checkout.id)).toBe('cancelled');
    expect(await count(db.pool, `SELECT count(*) AS n FROM appointments WHERE status = 'held' AND hold_kind = 'waitlist_offer'`)).toBe(1);
    expect(await count(db.pool, `SELECT count(*) AS n FROM idempotency_keys WHERE key = 'live'`)).toBe(1);
    expect(await sweepOnce(sweepDeps('w2'))).toMatchObject({ holdsFreed: 0, keysPurged: 0 });
  });
});

describe('Redis loss (acceptance 10)', () => {
  const timers = () => new Queue(TIMERS_QUEUE, { connection: redis, prefix });

  /** A visit whose 24h reminder is due 1h from NOW (inside the re-seed horizon) and a fresh checkout hold. */
  async function seedWork(s: Setup) {
    const patientId = await patientWithEmail(db.pool, 1);
    const visit = await bookVisit(s, patientId, new Date(NOW.getTime() + 25 * HOUR_MS));
    const held = await s.svc.hold({
      patientId: await patientWithEmail(db.pool, 2), doctorId: s.doctorId, clinicId: s.w.clinicId,
      serviceId: s.w.serviceId, startsAt: kyiv('2026-06-09', '10:00'), channel: 'online',
    });
    return { visit, held, reminderJob: jobIds.reminder('h24', visit.id, visit.timeVersion) };
  }

  it('FLUSHALL then a worker restart: holds are freed, the reminder goes out once, no duplicates', async () => {
    const s = await setupWorld(db, clock);
    const { visit, held, reminderJob } = await seedWork(s);
    const queue = timers();

    await startWorker('w1');
    expect(await queue.getJob(reminderJob)).toBeDefined();

    await redis.flushall();
    expect(await queue.getJob(reminderJob)).toBeUndefined();
    await runtimes.splice(0)[0]?.stop();

    await startWorker('w1-restarted');
    expect(await queue.getJob(reminderJob)).toBeDefined();

    clock.advance(2 * HOUR_MS);
    await waitFor('reminder mail', async () => mailer.sent.length >= 1);
    await waitFor('hold freed', async () => (await statusOf(held.id)) === 'cancelled');
    await new Promise((resolve) => setTimeout(resolve, 4 * TEST_CONFIG.sweepIntervalMs));

    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.text).toContain('2026-06-02 12:00');
    expect(await statusOf(visit.id)).toBe('booked');
    await queue.close();
  });

  it('FLUSHALL under a running worker: the epoch check mirrors the work into Redis again', async () => {
    const s = await setupWorld(db, clock);
    const { reminderJob } = await seedWork(s);
    const queue = timers();
    await startWorker('w1');
    expect(await queue.getJob(reminderJob)).toBeDefined();

    await redis.flushall();
    await waitFor('job re-seeded', async () => (await queue.getJob(reminderJob)) !== undefined);
    expect(errors).toEqual([]);
    await queue.close();
  });

  it('a delayed BullMQ job triggers the handler, and the sweeper does not duplicate its mail', async () => {
    const s = await setupWorld(db, clock);
    const { reminderJob } = await seedWork(s);
    const queue = timers();
    // Make the reminder due "now" so BullMQ fires it with delay 0, racing the sweeper.
    clock.advance(HOUR_MS);
    await startWorker('w1');
    await startWorker('w2');
    await waitFor('reminder mail', async () => mailer.sent.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 4 * TEST_CONFIG.sweepIntervalMs));
    expect(mailer.sent).toHaveLength(1);
    expect(reminderJob).toMatch(/^reminder-h24_\d+_\d+$/);
    await queue.close();
  });
});

describe('several worker copies', () => {
  /** `n` booked visits 45 minutes apart over consecutive days, each with its own patient. */
  async function manyVisits(n: number): Promise<number> {
    const s = await setupWorld(db, clock, undefined, { workStart: '08:00', workEnd: '20:00' });
    let last = 0;
    for (let i = 0; i < n; i++) {
      const patientId = await patientWithEmail(db.pool, i);
      const startsAt = new Date(kyiv('2026-06-05', '09:00').getTime() + Math.floor(i / 16) * 24 * HOUR_MS + (i % 16) * 45 * MINUTE_MS);
      await db.inTx(NOW, (c) =>
        insertRawAppointment(c, { w: s.w, doctorId: s.doctorId, patientId, startsAt, createdAt: NOW }),
      );
      last = startsAt.getTime();
    }
    return last;
  }

  it('acceptance 11: three copies send every reminder exactly once', async () => {
    const visits = 40;
    const last = await manyVisits(visits);
    clock.set(new Date(last)); // every h24 and h2 is due
    await Promise.all(['w1', 'w2', 'w3'].map((name) => startWorker(name)));
    const expected = visits * 2;

    await waitFor('all mail sent', async () =>
      (await count(db.pool, `SELECT count(*) AS n FROM email_outbox WHERE status = 'sent'`)) === expected);
    await new Promise((resolve) => setTimeout(resolve, 4 * TEST_CONFIG.sweepIntervalMs));

    expect(mailer.sent).toHaveLength(expected);
    expect(new Set(mailer.sent.map((m) => m.messageId)).size).toBe(expected);
    expect(await count(db.pool, `SELECT count(*) AS n FROM email_outbox`)).toBe(expected);
    expect(errors).toEqual([]);
  });

  it('copies sweeping at the same instant never run the same row twice', async () => {
    await manyVisits(30);
    clock.set(new Date(NOW.getTime() + 8 * 24 * HOUR_MS));
    for (let round = 0; round < 3; round++) {
      await Promise.all(['a', 'b', 'c', 'd'].map((name) => sweepOnce(sweepDeps(name))));
    }
    expect(mailer.sent).toHaveLength(60);
    expect(new Set(mailer.sent.map((m) => m.messageId)).size).toBe(60);
  });

  it('acceptance 13: sick leave with 12 visits mails each patient exactly once, even when marked twice', async () => {
    const s = await setupWorld(db, clock, undefined, { workStart: '08:00', workEnd: '20:00' });
    const date = '2026-06-08';
    for (let i = 0; i < 12; i++) {
      await bookVisit(s, await patientWithEmail(db.pool, i), new Date(kyiv(date, '08:00').getTime() + i * 45 * MINUTE_MS));
    }
    const input = {
      doctorId: s.doctorId, clinicId: s.w.clinicId, date,
      actor: { role: 'receptionist' as const, userId: 1, clinicId: s.w.clinicId },
    };
    const first = await s.svc.markSickLeave(input);
    const second = await s.svc.markSickLeave(input);
    expect([first.applied, second.applied]).toEqual([true, false]);

    await Promise.all(['w1', 'w2', 'w3'].map((name) => startWorker(name)));
    await waitFor('12 mails', async () => mailer.sent.length >= 12);
    await new Promise((resolve) => setTimeout(resolve, 4 * TEST_CONFIG.sweepIntervalMs));

    expect(mailer.sent).toHaveLength(12);
    expect(new Set(mailer.sent.map((m) => m.to)).size).toBe(12);
    expect(mailer.sent.every((m) => m.subject === 'Ваш запис скасовано')).toBe(true);
    expect(await count(db.pool, `SELECT count(*) AS n FROM appointments WHERE status = 'booked'`)).toBe(0);
  });
});
