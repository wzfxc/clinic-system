import { WaitlistService, type Clock } from '@clinic/shared';
import type { Pool } from 'pg';
import type { WorkerConfig } from './config.js';
import type { Mailer } from './mailer.js';
import { purgeExpiredIdempotencyKeys, releaseExpiredHolds } from './maintenance.js';
import { drainOutbox } from './outbox.js';
import { processDueReminders } from './reminders.js';

export interface SweepDeps {
  pool: Pool;
  clock: Clock;
  mailer: Mailer;
  workerId: string;
  config: WorkerConfig;
  /** Where failures and dead mail are reported; the sweep keeps going past a failing step. */
  onError?: (message: string, err: unknown) => void;
}

export interface SweepResult {
  holdsFreed: number;
  keysPurged: number;
  reminders: number;
  offersClosed: number;
  mailSent: number;
}

/**
 * One pass over everything Postgres says is due. This is the whole correctness story: BullMQ
 * only makes it happen sooner, so a lost Redis costs at most one sweep interval. Every step is
 * idempotent and safe to run in several copies at once (SKIP LOCKED, unique keys, leases).
 */
export async function sweepOnce(deps: SweepDeps): Promise<SweepResult> {
  const { pool, clock, mailer, workerId, config } = deps;
  const report = deps.onError ?? (() => {});
  const failures: unknown[] = [];
  // Each step stands alone: a failing one is reported and rethrown at the end, never hides the others.
  const step = async <T>(name: string, fallback: T, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      report(`sweep step ${name} failed`, err);
      failures.push(err);
      return fallback;
    }
  };
  const holdsFreed = await step('holds', 0, () => releaseExpiredHolds(pool, clock, config));
  const keysPurged = await step('idempotency', 0, () => purgeExpiredIdempotencyKeys(pool, clock, config));
  // Overdue waitlist offers go to the next candidate; the offer's own expires_at in Postgres decides.
  const offersClosed = await step('waitlist-offers', 0, () =>
    new WaitlistService(pool, clock).processDueOffers(config.batchSize),
  );
  const reminders = await step('reminders', 0, () => processDueReminders(pool, clock, config, undefined, report));
  const mail = await step('mail', { sent: 0, retried: 0, dead: 0 }, () =>
    drainOutbox(pool, clock, mailer, workerId, config, undefined, report),
  );
  if (failures.length > 0) throw new AggregateError(failures, `${failures.length} sweep step(s) failed`);
  return { holdsFreed, keysPurged, reminders, offersClosed, mailSent: mail.sent };
}
