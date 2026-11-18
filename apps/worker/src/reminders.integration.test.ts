/** Reminders and outbox delivery against a real Postgres (acceptance 9; invariant 8 of docs/analysis/04). */
import { FixedClock, zonedInstant } from '@clinic/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { drainOutbox } from './outbox.js';
import { RecordingMailer } from './mailer.js';
import { processDueReminders } from './reminders.js';
import { bookVisit, count, DAY_MS, HOUR_MS, NOW, patientWithEmail, setupWorld, TEST_CONFIG, openDb, type Setup } from './test-support.js';
import type { TestDb } from '@clinic/shared/testing';

let db: TestDb;
const clock = new FixedClock(NOW);
const mailer = new RecordingMailer();

beforeAll(async () => {
  db = await openDb();
}, 60_000);
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  clock.set(NOW);
  mailer.sent.length = 0;
  mailer.failWith = null;
  await db.reset();
});

const kyiv = (date: string, time: string): Date => zonedInstant('Europe/Kyiv', date, time);

/** One sweeper pass for reminders and mail, as the worker runs it. */
async function sweep(): Promise<void> {
  await processDueReminders(db.pool, clock, TEST_CONFIG);
  await drainOutbox(db.pool, clock, mailer, 'w1', TEST_CONFIG);
}

const reminderRows = async (appointmentId: number) =>
  (
    await db.pool.query<{ kind: string; time_version: number; cancelled: boolean; enqueued: boolean; skipped: boolean }>(
      `SELECT kind, time_version, cancelled_at IS NOT NULL AS cancelled, enqueued_at IS NOT NULL AS enqueued,
              skipped_at IS NOT NULL AS skipped
         FROM reminders WHERE appointment_id = $1 ORDER BY id`,
      [appointmentId],
    )
  ).rows;

async function booked(s: Setup, startsAt: Date, n = 1) {
  return bookVisit(s, await patientWithEmail(db.pool, n), startsAt);
}

describe('reminders', () => {
  it('sends exactly one mail at 24h and one at 2h, however often the sweeper runs', async () => {
    const s = await setupWorld(db, clock);
    const start = kyiv('2026-06-05', '12:00');
    await booked(s, start);

    await sweep();
    expect(mailer.sent).toHaveLength(0);

    clock.set(new Date(start.getTime() - 24 * HOUR_MS));
    await sweep();
    await sweep();
    expect(mailer.sent.map((m) => m.subject)).toEqual(['Нагадування: візит завтра']);
    expect(mailer.sent[0]?.text).toContain('2026-06-05 12:00');

    clock.set(new Date(start.getTime() - 2 * HOUR_MS));
    await sweep();
    await sweep();
    expect(mailer.sent).toHaveLength(2);
    expect(new Set(mailer.sent.map((m) => m.messageId)).size).toBe(2);
    expect(await count(db.pool, `SELECT count(*) AS n FROM email_outbox WHERE status = 'sent'`)).toBe(2);
  });

  it('a visit booked less than 24h ahead gets only the 2h reminder', async () => {
    const s = await setupWorld(db, clock);
    const a = await booked(s, kyiv('2026-06-02', '09:00'));
    expect((await reminderRows(a.id)).map((r) => [r.kind, r.skipped])).toEqual([
      ['h24', true],
      ['h2', false],
    ]);
    clock.set(new Date(a.startsAt.getTime() - 2 * HOUR_MS));
    await sweep();
    expect(mailer.sent.map((m) => m.subject)).toEqual(['Нагадування: візит за 2 години']);
  });

  it('after a reschedule only the new time is reminded (acceptance 9)', async () => {
    const s = await setupWorld(db, clock);
    const patientId = await patientWithEmail(db.pool, 1);
    const a = await bookVisit(s, patientId, kyiv('2026-06-05', '12:00'));
    const moved = await s.svc.reschedule({
      appointmentId: a.id,
      expectedVersion: a.timeVersion,
      newStartsAt: kyiv('2026-06-08', '15:00'),
      actor: { role: 'patient', userId: 1, patientId },
    });

    const rows = await reminderRows(a.id);
    expect(rows.filter((r) => r.time_version === a.timeVersion).every((r) => r.cancelled)).toBe(true);
    expect(rows.filter((r) => r.time_version === moved.appointment.timeVersion).every((r) => !r.cancelled)).toBe(true);

    clock.set(new Date(a.startsAt.getTime() - 24 * HOUR_MS));
    await sweep();
    expect(mailer.sent).toHaveLength(0);

    clock.set(new Date(moved.appointment.startsAt.getTime() - 24 * HOUR_MS));
    await sweep();
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.text).toContain('2026-06-08 15:00');
  });

  it('a stale reminder that slipped past the trigger is cancelled, not mailed', async () => {
    const s = await setupWorld(db, clock);
    const a = await booked(s, kyiv('2026-06-05', '12:00'));
    // Simulate a job for the old time: the visit moved without the trigger noticing.
    await db.pool.query(`ALTER TABLE appointments DISABLE TRIGGER appointments_reminders`);
    await db.inTx(clock.now(), (c) =>
      c.query(`UPDATE appointments SET starts_at = starts_at + interval '1 hour', ends_at = ends_at + interval '1 hour',
                      blocked_until = blocked_until + interval '1 hour', time_version = time_version + 1 WHERE id = $1`, [a.id]),
    );
    await db.pool.query(`ALTER TABLE appointments ENABLE TRIGGER appointments_reminders`);
    clock.set(new Date(a.startsAt.getTime()));
    await sweep();
    expect(mailer.sent).toHaveLength(0);
    expect((await reminderRows(a.id)).every((r) => r.cancelled)).toBe(true);
  });

  it('after a cancel there is no reminder at all', async () => {
    const s = await setupWorld(db, clock);
    const patientId = await patientWithEmail(db.pool, 1);
    const a = await bookVisit(s, patientId, kyiv('2026-06-05', '12:00'));
    await s.svc.cancel({ appointmentId: a.id, actor: { role: 'patient', userId: 1, patientId }, reason: 'changed my mind' });
    clock.set(new Date(a.startsAt.getTime()));
    await sweep();
    expect(mailer.sent).toHaveLength(0);
    expect((await reminderRows(a.id)).every((r) => r.cancelled)).toBe(true);
  });

  it('a hold that was never confirmed has no reminders', async () => {
    const s = await setupWorld(db, clock);
    const patientId = await patientWithEmail(db.pool, 1);
    const held = await s.svc.hold({
      patientId, doctorId: s.doctorId, clinicId: s.w.clinicId, serviceId: s.w.serviceId,
      startsAt: kyiv('2026-06-05', '12:00'), channel: 'online',
    });
    expect(await reminderRows(held.id)).toEqual([]);
  });

  it('DST night in Warsaw: due_at is exactly 24h before the start and the mail shows local time', async () => {
    const s = await setupWorld(db, clock, 'Europe/Warsaw');
    clock.set(new Date('2027-03-20T10:00:00Z'));
    const start = zonedInstant('Europe/Warsaw', '2027-03-28', '12:00');
    const a = await booked(s, start);
    const { rows } = await db.pool.query<{ gap: string }>(
      `SELECT extract(epoch FROM a.starts_at - r.due_at)::text AS gap FROM reminders r JOIN appointments a ON a.id = r.appointment_id
        WHERE r.appointment_id = $1 AND r.kind = 'h24'`,
      [a.id],
    );
    expect(Number(rows[0]?.gap)).toBe(DAY_MS / 1000);
    clock.set(new Date(start.getTime() - DAY_MS));
    await sweep();
    expect(mailer.sent[0]?.text).toContain('2027-03-28 12:00');
  });

  it('a mail queued earlier is not sent if the visit was cancelled meanwhile (stale_visit)', async () => {
    const s = await setupWorld(db, clock);
    const patientId = await patientWithEmail(db.pool, 1);
    const a = await bookVisit(s, patientId, kyiv('2026-06-05', '12:00'));
    clock.set(new Date(a.startsAt.getTime() - 24 * HOUR_MS));
    await processDueReminders(db.pool, clock, TEST_CONFIG);
    await s.svc.cancel({ appointmentId: a.id, actor: { role: 'patient', userId: 1, patientId }, reason: 'changed my mind' });
    expect(await drainOutbox(db.pool, clock, mailer, 'w1', TEST_CONFIG)).toEqual({ sent: 0, retried: 0, dead: 1 });
    expect(mailer.sent).toHaveLength(0);
    expect((await db.pool.query(`SELECT last_error FROM email_outbox`)).rows).toEqual([{ last_error: 'stale_visit' }]);
  });

  it('a reminder found only after the visit began is skipped, not mailed', async () => {
    const s = await setupWorld(db, clock);
    const a = await booked(s, kyiv('2026-06-05', '12:00'));
    clock.set(new Date(a.startsAt.getTime() + HOUR_MS));
    await sweep();
    expect(mailer.sent).toHaveLength(0);
    expect((await reminderRows(a.id)).every((r) => r.skipped)).toBe(true);
  });
});

describe('outbox delivery', () => {
  async function dueMail(email: string | null) {
    const s = await setupWorld(db, clock);
    const a = await bookVisit(s, await patientWithEmail(db.pool, 1, email), kyiv('2026-06-05', '12:00'));
    clock.set(new Date(a.startsAt.getTime() - 24 * HOUR_MS));
    await processDueReminders(db.pool, clock, TEST_CONFIG);
  }
  const outbox = async () =>
    (await db.pool.query<{ status: string; attempts: number; last_error: string | null }>(
      `SELECT status, attempts, last_error FROM email_outbox`,
    )).rows;

  it('retries with exponential backoff and gives up as dead after maxAttempts', async () => {
    await dueMail('p1@example.test');
    mailer.failWith = new Error('smtp down');
    for (let attempt = 1; attempt <= TEST_CONFIG.maxAttempts; attempt++) {
      const result = await drainOutbox(db.pool, clock, mailer, 'w1', TEST_CONFIG);
      expect(result.sent).toBe(0);
      expect(await drainOutbox(db.pool, clock, mailer, 'w1', TEST_CONFIG)).toEqual({ sent: 0, retried: 0, dead: 0 });
      clock.advance(TEST_CONFIG.backoffBaseMs * 2 ** attempt);
    }
    expect(await outbox()).toEqual([{ status: 'dead', attempts: TEST_CONFIG.maxAttempts, last_error: 'smtp down' }]);
  });

  it('a transient failure is retried and then sent once', async () => {
    await dueMail('p1@example.test');
    mailer.failWith = new Error('smtp down');
    await drainOutbox(db.pool, clock, mailer, 'w1', TEST_CONFIG);
    mailer.failWith = null;
    clock.advance(TEST_CONFIG.backoffBaseMs);
    expect(await drainOutbox(db.pool, clock, mailer, 'w1', TEST_CONFIG)).toMatchObject({ sent: 1 });
    expect(mailer.sent).toHaveLength(1);
  });

  it('a patient without an email gets a dead row and no send attempt', async () => {
    await dueMail(null);
    await drainOutbox(db.pool, clock, mailer, 'w1', TEST_CONFIG);
    expect(mailer.sent).toHaveLength(0);
    expect(await outbox()).toEqual([{ status: 'dead', attempts: 0, last_error: 'no_email' }]);
  });
});
