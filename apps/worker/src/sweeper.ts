import type { Clock } from '@clinic/shared';
import type { Pool } from 'pg';
import type { WorkerConfig } from './config.js';
import type { Mailer } from './mailer.js';
import { drainOutbox } from './outbox.js';
import { processDueReminders } from './reminders.js';

export interface SweepDeps {
  pool: Pool;
  clock: Clock;
  mailer: Mailer;
  workerId: string;
  config: WorkerConfig;
}

export interface SweepResult {
  reminders: number;
  mailSent: number;
}

/**
 * One pass over everything Postgres says is due. This is the whole correctness story: BullMQ
 * only makes it happen sooner, so a lost Redis costs at most one sweep interval.
 */
export async function sweepOnce(deps: SweepDeps): Promise<SweepResult> {
  const { pool, clock, mailer, workerId, config } = deps;
  const reminders = await processDueReminders(pool, clock, config);
  const mail = await drainOutbox(pool, clock, mailer, workerId, config);
  return { reminders, mailSent: mail.sent };
}
