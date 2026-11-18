import { randomUUID } from 'node:crypto';
import type { Clock } from '@clinic/shared';
import { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { WorkerConfig } from './config.js';
import type { Mailer } from './mailer.js';
import { releaseExpiredHolds } from './maintenance.js';
import { drainOutbox } from './outbox.js';
import { processDueReminders } from './reminders.js';
import { sweepOnce } from './sweeper.js';
import { Triggers, type TriggerPayload } from './triggers.js';

export interface RuntimeDeps {
  pool: Pool;
  clock: Clock;
  mailer: Mailer;
  workerId: string;
  config: WorkerConfig;
  redisUrl: string;
  /** BullMQ key prefix; tests use a private one. */
  bullPrefix?: string;
  onError: (message: string, err: unknown) => void;
}

/**
 * One worker copy (docs/analysis/04, sections 5-6). Start order matters: reconcile Postgres first,
 * then mirror upcoming work into Redis, then let BullMQ consumers and the periodic sweeper run.
 * Redis trouble is reported and never stops the sweeper.
 */
export class WorkerRuntime {
  private readonly epoch = randomUUID();
  private triggers: Triggers | undefined;
  private connections: Redis[] = [];
  private sweepTimer: NodeJS.Timeout | undefined;
  private epochTimer: NodeJS.Timeout | undefined;
  private inFlight: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(private readonly deps: RuntimeDeps) {}

  async start(): Promise<void> {
    const { redisUrl, onError } = this.deps;
    // Queue side fails fast when Redis is down; consumer side needs unlimited retries per request.
    const queueConn = new Redis(redisUrl, { enableOfflineQueue: false, maxRetriesPerRequest: 1, lazyConnect: false });
    const workerConn = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.connections = [queueConn, workerConn];
    for (const c of this.connections) c.on('error', (err: Error) => onError('redis', err));
    this.triggers = new Triggers(queueConn, workerConn, this.deps.bullPrefix, onError);

    try {
      await sweepOnce(this.deps);
    } catch (err) {
      // Nothing is running yet, so release what was opened and let the caller decide (the process exits and restarts).
      await this.triggers.close();
      for (const c of this.connections) c.disconnect();
      throw err;
    }
    await this.safely('initial reseed', async () => {
      await this.reseed();
      await this.triggers?.ensureEpoch(this.epoch);
    });
    this.triggers.startConsumers((payload) => this.handle(payload));
    this.scheduleSweep();
    this.scheduleEpochCheck();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.sweepTimer);
    clearTimeout(this.epochTimer);
    await this.inFlight;
    await this.triggers?.close();
    for (const c of this.connections) c.disconnect();
  }

  /** The BullMQ handler: the same idempotent function the sweeper uses, narrowed to one row. */
  private async handle(payload: TriggerPayload): Promise<void> {
    const { pool, clock, mailer, workerId, config, onError } = this.deps;
    switch (payload.kind) {
      case 'reminder':
        await processDueReminders(pool, clock, config, payload.subjectId, onError);
        await drainOutbox(pool, clock, mailer, workerId, config, undefined, onError);
        return;
      case 'hold-expiry':
        await releaseExpiredHolds(pool, clock, config, payload.subjectId);
        return;
      case 'email-send':
        await drainOutbox(pool, clock, mailer, workerId, config, payload.subjectId, onError);
        return;
    }
  }

  private async reseed(): Promise<void> {
    await this.triggers?.reseed(this.deps.pool, this.deps.clock, this.deps.config);
  }

  private async safely(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.deps.onError(what, err);
    }
  }

  private scheduleSweep(): void {
    if (this.stopped) return;
    this.sweepTimer = setTimeout(() => {
      this.inFlight = (async () => {
        await this.safely('sweep', async () => void (await sweepOnce(this.deps)));
        await this.safely('reseed', () => this.reseed());
      })().finally(() => this.scheduleSweep());
    }, this.deps.config.sweepIntervalMs);
  }

  /** A missing epoch key means Redis lost its data: mirror everything upcoming again. */
  private scheduleEpochCheck(): void {
    if (this.stopped) return;
    this.epochTimer = setTimeout(() => {
      void this.safely('epoch check', async () => {
        if (await this.triggers?.ensureEpoch(this.epoch)) await this.reseed();
      }).finally(() => this.scheduleEpochCheck());
    }, this.deps.config.epochCheckMs);
  }
}
