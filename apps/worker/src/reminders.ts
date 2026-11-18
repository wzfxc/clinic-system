import { runInTransaction, type Clock, type Tx } from '@clinic/shared';
import type { Pool } from 'pg';
import type { WorkerConfig } from './config.js';

interface DueReminder {
  id: string;
  kind: 'h24' | 'h2';
  appointment_id: string;
  start_snapshot: Date;
  time_version: number;
}

interface VisitRow {
  status: string;
  starts_at: Date;
  time_version: number;
  patient_id: string;
  email: string | null;
  timezone: string;
}

/**
 * Turns one due reminder into an outbox row (docs/analysis/04, section 4). The reminder row is
 * locked by the caller, so a concurrent move or cancel (whose trigger updates the same row) either
 * waits for this transaction or has already cancelled it. A reminder for a visit that has moved or
 * is no longer booked is cancelled instead of mailed.
 */
async function settle(tx: Tx, now: Date, due: DueReminder): Promise<'mailed' | 'closed'> {
  const { rows } = await tx.query<VisitRow>(
    `SELECT a.status, a.starts_at, a.time_version, p.id AS patient_id, p.email, c.timezone
       FROM appointments a
       JOIN patients p ON p.id = a.patient_id
       JOIN clinics c ON c.id = a.clinic_id
      WHERE a.id = $1`,
    [due.appointment_id],
  );
  const visit = rows[0];
  const current =
    visit !== undefined &&
    visit.status === 'booked' &&
    visit.time_version === due.time_version &&
    visit.starts_at.getTime() === due.start_snapshot.getTime();
  if (!current) {
    await tx.query(`UPDATE reminders SET cancelled_at = $2 WHERE id = $1`, [due.id, now]);
    return 'closed';
  }
  // Found after the visit began (a long outage): the reminder is useless, so it is skipped, not mailed.
  if (due.start_snapshot.getTime() <= now.getTime()) {
    await tx.query(`UPDATE reminders SET skipped_at = $2 WHERE id = $1`, [due.id, now]);
    return 'closed';
  }
  const email = visit.email;
  await tx.query(
    `INSERT INTO email_outbox
       (dedupe_key, to_address, patient_id, template, payload, status, last_error, next_attempt_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [
      `reminder:${due.id}`,
      email,
      visit.patient_id,
      `reminder_${due.kind}`,
      JSON.stringify({
        appointmentId: Number(due.appointment_id),
        startsAt: due.start_snapshot.toISOString(),
        timezone: visit.timezone,
      }),
      email === null ? 'dead' : 'pending',
      email === null ? 'no_email' : null,
      now,
    ],
  );
  await tx.query(`UPDATE reminders SET enqueued_at = $2 WHERE id = $1`, [due.id, now]);
  return 'mailed';
}

/**
 * Handles every due reminder (or only `onlyId`, for a BullMQ trigger). Safe to run in several
 * copies and repeatedly: SKIP LOCKED splits the rows, `enqueued_at` plus the outbox UNIQUE
 * key make the effect exactly-once. Returns how many outbox rows were created.
 */
export async function processDueReminders(
  pool: Pool,
  clock: Clock,
  cfg: WorkerConfig,
  onlyId?: number,
  report: (message: string, err: unknown) => void = () => {},
): Promise<number> {
  let created = 0;
  for (;;) {
    const handled = await runInTransaction(pool, clock, async (tx, frozen) => {
      const now = frozen.now();
      const { rows } = await tx.query<DueReminder>(
        `SELECT id, kind, appointment_id, start_snapshot, time_version
           FROM reminders
          WHERE enqueued_at IS NULL AND cancelled_at IS NULL AND skipped_at IS NULL
            AND due_at <= $1 AND ($3::bigint IS NULL OR id = $3)
          ORDER BY due_at, id
          LIMIT $2 FOR UPDATE SKIP LOCKED`,
        [now, cfg.batchSize, onlyId ?? null],
      );
      let mailed = 0;
      let closed = 0;
      for (const due of rows) {
        // One bad row must not roll back, or forever block, the healthy rows behind it.
        await tx.query('SAVEPOINT reminder');
        try {
          if ((await settle(tx, now, due)) === 'mailed') mailed += 1;
          else closed += 1;
          await tx.query('RELEASE SAVEPOINT reminder');
        } catch (err) {
          await tx.query('ROLLBACK TO SAVEPOINT reminder');
          report(`reminder ${due.id} could not be settled and stays pending`, err);
        }
      }
      return { mailed, settled: mailed + closed };
    });
    created += handled.mailed;
    // A pass that settled nothing (empty, or only failing rows) ends the loop instead of spinning on them.
    if (handled.settled === 0 || onlyId !== undefined) return created;
  }
}
