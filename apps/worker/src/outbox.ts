import type { Clock } from '@clinic/shared';
import type { Pool } from 'pg';
import type { WorkerConfig } from './config.js';
import type { Mailer } from './mailer.js';
import { renderMail } from './render.js';

interface ClaimedRow {
  id: string;
  to_address: string | null;
  template: string;
  payload: Record<string, unknown>;
  message_id: string;
  attempts: number;
}

export type Report = (message: string, err: unknown) => void;

export interface OutboxResult {
  sent: number;
  retried: number;
  dead: number;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 500);

/**
 * Takes due rows for this worker: SKIP LOCKED keeps copies off each other's rows, and the lease
 * (`claimed_until`) keeps them off a row while SMTP runs outside any transaction.
 */
async function claim(
  pool: Pool,
  clock: Clock,
  workerId: string,
  cfg: WorkerConfig,
  onlyId?: number,
): Promise<ClaimedRow[]> {
  const now = clock.now();
  const { rows } = await pool.query<ClaimedRow>(
    `UPDATE email_outbox o
        SET claimed_by = $1, claimed_until = $2::timestamptz + make_interval(secs => $3)
      WHERE o.id IN (
        SELECT id FROM email_outbox
         WHERE status = 'pending' AND next_attempt_at <= $2
           AND (claimed_until IS NULL OR claimed_until < $2)
           AND ($5::bigint IS NULL OR id = $5)
         ORDER BY next_attempt_at, id
         LIMIT $4 FOR UPDATE SKIP LOCKED)
      RETURNING o.id, o.to_address, o.template, o.payload, o.message_id, o.attempts`,
    [workerId, now, cfg.leaseMs / 1000, cfg.batchSize, onlyId ?? null],
  );
  return rows;
}

const MARK_SENT_TRIES = 3;

/** The mail is already out, so a failed bookkeeping write is retried before it is reported. */
function errorCodeOf(err: unknown): string {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' || typeof code === 'number' ? String(code) : 'unknown';
}

async function markSent(pool: Pool, clock: Clock, workerId: string, id: string, report: Report): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      const { rowCount } = await pool.query(
        `UPDATE email_outbox SET status = 'sent', sent_at = $3, claimed_until = NULL, last_error = NULL
          WHERE id = $1 AND claimed_by = $2 AND status = 'pending'`,
        [id, workerId, clock.now()],
      );
      if (rowCount !== 1) report(`outbox ${id}: sent but the lease was lost, another copy may send it again`, null);
      return;
    } catch (err) {
      if (attempt >= MARK_SENT_TRIES) {
        report(`outbox ${id}: sent but could not be marked sent; it will be re-sent after the lease`, err);
        return;
      }
    }
  }
}

/** Renews the lease for one row right before its SMTP call; false means another copy owns the row now. */
async function renewLease(pool: Pool, clock: Clock, workerId: string, cfg: WorkerConfig, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE email_outbox SET claimed_until = $3::timestamptz + make_interval(secs => $4)
      WHERE id = $1 AND claimed_by = $2 AND status = 'pending'`,
    [id, workerId, clock.now(), cfg.leaseMs / 1000],
  );
  return rowCount === 1;
}

/** A reminder is useless once its visit moved, was cancelled or has started; it must not go out late. */
async function visitStillAhead(pool: Pool, clock: Clock, row: ClaimedRow): Promise<boolean> {
  if (!row.template.startsWith('reminder_')) return true;
  const { rowCount } = await pool.query(
    `SELECT 1 FROM appointments WHERE id = $1 AND status = 'booked' AND starts_at = $2 AND starts_at > $3`,
    [row.payload.appointmentId, row.payload.startsAt, clock.now()],
  );
  return rowCount === 1;
}

/** Exponential backoff; the row goes `dead` once `maxAttempts` deliveries have failed. */
async function markFailed(
  pool: Pool,
  clock: Clock,
  cfg: WorkerConfig,
  workerId: string,
  row: ClaimedRow,
  err: unknown,
  report: Report,
): Promise<'retried' | 'dead'> {
  const attempts = row.attempts + 1;
  const dead = attempts >= cfg.maxAttempts;
  const retryAt = new Date(clock.now().getTime() + cfg.backoffBaseMs * 2 ** (attempts - 1));
  await pool.query(
    `UPDATE email_outbox
        SET attempts = $2, last_error = $3, claimed_until = NULL,
            status = CASE WHEN $4::boolean THEN 'dead'::email_status ELSE status END,
            next_attempt_at = $5
      WHERE id = $1 AND status = 'pending' AND claimed_by = $6`,
    [row.id, attempts, errorText(err), dead, retryAt, workerId],
  );
  // Provider messages can contain the recipient address, so the log gets only a code; the text stays in last_error.
  if (dead) report(`outbox ${row.id} is dead after ${attempts} attempts (${errorCodeOf(err)})`, null);
  return dead ? 'dead' : 'retried';
}

async function deliver(
  pool: Pool,
  clock: Clock,
  mailer: Mailer,
  workerId: string,
  cfg: WorkerConfig,
  row: ClaimedRow,
  report: Report,
): Promise<keyof OutboxResult> {
  try {
    if (!(await renewLease(pool, clock, workerId, cfg, row.id))) return 'retried';
    if (!(await visitStillAhead(pool, clock, row))) {
      await pool.query(
        `UPDATE email_outbox SET status = 'dead', last_error = 'stale_visit', claimed_until = NULL
          WHERE id = $1 AND claimed_by = $2 AND status = 'pending'`,
        [row.id, workerId],
      );
      return 'dead';
    }
    if (row.to_address === null) throw new Error('no_email');
    const { subject, text } = renderMail(row.template, row.payload);
    await mailer.send({ messageId: row.message_id, to: row.to_address, subject, text });
  } catch (err) {
    return markFailed(pool, clock, cfg, workerId, row, err, report);
  }
  // If the lease was lost meanwhile the row is another copy's now; a repeat carries the same Message-ID.
  await markSent(pool, clock, workerId, row.id, report);
  return 'sent';
}

/** Delivers everything due (or only row `onlyId`); returns when no due row is left to claim. */
export async function drainOutbox(
  pool: Pool,
  clock: Clock,
  mailer: Mailer,
  workerId: string,
  cfg: WorkerConfig,
  onlyId?: number,
  report: Report = () => {},
): Promise<OutboxResult> {
  const result: OutboxResult = { sent: 0, retried: 0, dead: 0 };
  for (;;) {
    const rows = await claim(pool, clock, workerId, cfg, onlyId);
    if (rows.length === 0) return result;
    for (const row of rows) result[await deliver(pool, clock, mailer, workerId, cfg, row, report)] += 1;
    if (onlyId !== undefined) return result;
  }
}
