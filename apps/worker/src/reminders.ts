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
async function settle(tx: Tx, now: Date, due: DueReminder): Promise<boolean> {
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
    return false;
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
  return true;
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
      for (const due of rows) if (await settle(tx, now, due)) mailed += 1;
      return { rows: rows.length, mailed };
    });
    created += handled.mailed;
    if (handled.rows === 0 || onlyId !== undefined) return created;
  }
}
