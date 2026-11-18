/**
 * Transaction plumbing shared by the domain services: every write runs in its own
 * READ COMMITTED transaction with `app.clock_now` set from the injected Clock
 * (the DB triggers read time only from there), and is retried on deadlock or
 * serialization failure (docs/analysis/03, "Обробка 23P01 і ретраї").
 */
import { setTimeout as sleep } from 'node:timers/promises';
import type { Pool, PoolClient } from 'pg';
import type { Clock } from '../clock.js';
import type { ErrorCode } from '../errors.js';

/** What the domain functions need from a connection that is already inside a transaction. */
export type Tx = Pick<PoolClient, 'query'>;

/** Retries after the first attempt, for 40P01 (deadlock) and 40001 (serialization failure). */
export const MAX_TX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 10;
const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(['40P01', '40001']);

/** A business failure with a stable code from the shared registry. */
export class BookingError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string = code,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'BookingError';
  }
}

export interface PgErrorLike {
  code?: string;
  constraint?: string;
}

export function pgErrorOf(err: unknown): PgErrorLike {
  return typeof err === 'object' && err !== null ? (err as PgErrorLike) : {};
}

export const numberOf = (value: string | number): number => Number(value);

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // The original error is what the caller needs; a failed ROLLBACK means a dead
    // connection, which the pool discards on release(err).
  }
}

async function runOnce<T>(pool: Pool, clock: Clock, fn: (tx: Tx, clock: Clock) => Promise<T>): Promise<T> {
  const frozenNow = clock.now();
  const frozenClock: Clock = { now: () => new Date(frozenNow.getTime()) };
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    await client.query(`SELECT set_config('app.clock_now', $1, true)`, [frozenNow.toISOString()]);
    const result = await fn(client, frozenClock);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await rollbackQuietly(client);
    throw err;
  } finally {
    client.release();
  }
}

/** Runs `fn` in a transaction; retries it as a whole on 40P01 and 40001, up to 3 times. */
export async function runInTransaction<T>(
  pool: Pool,
  clock: Clock,
  fn: (tx: Tx, clock: Clock) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await runOnce(pool, clock, fn);
    } catch (err) {
      const code = pgErrorOf(err).code;
      if (code === undefined || !RETRYABLE_SQLSTATES.has(code) || attempt >= MAX_TX_RETRIES) throw err;
      await sleep(RETRY_BASE_DELAY_MS * (attempt + 1) + Math.floor(Math.random() * RETRY_BASE_DELAY_MS));
    }
  }
}
