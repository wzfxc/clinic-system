import { runInTransaction, type Clock } from '@clinic/shared';
import type { Pool } from 'pg';
import type { WorkerConfig } from './config.js';

/**
 * Frees expired checkout holds (docs/analysis/04, section 5). Only `hold_kind = 'checkout'`:
 * an expired waitlist offer must go through the waitlist cascade, never through here (R2).
 * `onlyId` narrows it to one appointment for a BullMQ trigger. Returns how many holds were freed.
 */
export async function releaseExpiredHolds(pool: Pool, clock: Clock, cfg: WorkerConfig, onlyId?: number): Promise<number> {
  let freed = 0;
  for (;;) {
    const batch = await runInTransaction(pool, clock, async (tx, frozen) => {
      const { rowCount } = await tx.query(
        `UPDATE appointments
            SET status = 'cancelled', cancel_reason = 'hold_expired',
                hold_kind = NULL, hold_expires_at = NULL, updated_at = $1
          WHERE id IN (
            SELECT id FROM appointments
             WHERE status = 'held' AND hold_kind = 'checkout' AND hold_expires_at <= $1
               AND ($3::bigint IS NULL OR id = $3)
             ORDER BY hold_expires_at, id
             LIMIT $2 FOR UPDATE SKIP LOCKED)`,
        [frozen.now(), cfg.batchSize, onlyId ?? null],
      );
      return rowCount ?? 0;
    });
    freed += batch;
    if (batch < cfg.batchSize || onlyId !== undefined) return freed;
  }
}

/** Deletes idempotency keys past their expiry, in batches. A live key is never touched. */
export async function purgeExpiredIdempotencyKeys(pool: Pool, clock: Clock, cfg: WorkerConfig): Promise<number> {
  let purged = 0;
  for (;;) {
    const { rowCount } = await pool.query(
      `DELETE FROM idempotency_keys
        WHERE ctid IN (SELECT ctid FROM idempotency_keys WHERE expires_at <= $1 LIMIT $2 FOR UPDATE SKIP LOCKED)`,
      [clock.now(), cfg.batchSize],
    );
    const batch = rowCount ?? 0;
    purged += batch;
    if (batch < cfg.batchSize) return purged;
  }
}
