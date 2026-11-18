import { numberOf, type Clock } from '@clinic/shared';
import { Queue, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import type { WorkerConfig } from './config.js';

/** BullMQ is only a trigger (docs/analysis/04, section 3): payloads carry ids, handlers re-read Postgres. */
export const TIMERS_QUEUE = 'timers';
export const MAIL_QUEUE = 'mail';
export const EPOCH_KEY = 'clinic:epoch';

export type TriggerName = 'reminder' | 'hold-expiry' | 'email-send';

export interface TriggerPayload {
  subjectId: number;
  kind: TriggerName;
}

/** No colon (BullMQ forbids it in custom ids); every part comes from Postgres, so each copy computes the same id. */
export const jobIds = {
  reminder: (kind: string, appointmentId: number, timeVersion: number): string =>
    `reminder-${kind}_${appointmentId}_${timeVersion}`,
  holdExpiry: (appointmentId: number, expiresAt: Date): string => `hold-expiry_${appointmentId}_${expiresAt.getTime()}`,
  emailSend: (outboxId: number, attempts: number): string => `email-send_${outboxId}_${attempts}`,
};

export const delayUntil = (due: Date, now: Date): number => Math.max(0, due.getTime() - now.getTime());

const JOB_DEFAULTS = {
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 7 * 86_400 },
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000 },
} as const;

export type TriggerHandler = (payload: TriggerPayload) => Promise<void>;

/** The Redis side of one worker copy: two queues, their consumers, and re-seeding from Postgres. */
export class Triggers {
  private readonly timers: Queue<TriggerPayload>;
  private readonly mail: Queue<TriggerPayload>;
  private consumers: Worker<TriggerPayload>[] = [];

  /**
   * `queueConnection` must fail fast when Redis is down (enableOfflineQueue: false);
   * `workerConnection` needs `maxRetriesPerRequest: null` for blocking reads.
   */
  constructor(
    private readonly queueConnection: Redis,
    private readonly workerConnection: Redis,
    private readonly prefix: string | undefined,
    private readonly onError: (message: string, err: unknown) => void,
  ) {
    const opts = { connection: queueConnection, prefix, defaultJobOptions: JOB_DEFAULTS };
    this.timers = new Queue<TriggerPayload>(TIMERS_QUEUE, opts);
    this.mail = new Queue<TriggerPayload>(MAIL_QUEUE, {
      ...opts,
      defaultJobOptions: { ...JOB_DEFAULTS, backoff: { type: 'exponential', delay: 10_000 } },
    });
    for (const q of [this.timers, this.mail]) q.on('error', (err) => this.onError(`queue ${q.name}`, err));
  }

  startConsumers(handler: TriggerHandler): void {
    const run = (job: Job<TriggerPayload>): Promise<void> => handler(job.data);
    this.consumers = [TIMERS_QUEUE, MAIL_QUEUE].map((name) => {
      const worker = new Worker<TriggerPayload>(name, run, {
        connection: this.workerConnection,
        prefix: this.prefix,
        lockDuration: 30_000,
        stalledInterval: 30_000,
        maxStalledCount: 1,
      });
      worker.on('error', (err) => this.onError(`consumer ${name}`, err));
      return worker;
    });
  }

  /** Mirrors work due within the horizon into Redis; adding an existing jobId is a no-op. Returns the jobs offered. */
  async reseed(pool: Pool, clock: Clock, cfg: WorkerConfig): Promise<number> {
    const now = clock.now();
    const until = new Date(now.getTime() + cfg.reseedHorizonMs);
    const limit = cfg.batchSize * 10;
    let offered = 0;
    const add = async (
      queue: Queue<TriggerPayload>,
      name: TriggerName,
      id: number,
      jobId: string,
      due: Date,
    ): Promise<void> => {
      await queue.add(name, { subjectId: id, kind: name }, { jobId, delay: delayUntil(due, now) });
      offered += 1;
    };

    const reminders = await pool.query<{
      id: string;
      kind: string;
      appointment_id: string;
      time_version: number;
      due_at: Date;
    }>(
      `SELECT id, kind, appointment_id, time_version, due_at FROM reminders
        WHERE enqueued_at IS NULL AND cancelled_at IS NULL AND skipped_at IS NULL AND due_at <= $1
        ORDER BY due_at LIMIT $2`,
      [until, limit],
    );
    for (const r of reminders.rows) {
      const jobId = jobIds.reminder(r.kind, numberOf(r.appointment_id), r.time_version);
      await add(this.timers, 'reminder', numberOf(r.id), jobId, r.due_at);
    }

    const holds = await pool.query<{ id: string; hold_expires_at: Date }>(
      `SELECT id, hold_expires_at FROM appointments
        WHERE status = 'held' AND hold_kind = 'checkout' AND hold_expires_at <= $1
        ORDER BY hold_expires_at LIMIT $2`,
      [until, limit],
    );
    for (const h of holds.rows) {
      const id = numberOf(h.id);
      await add(this.timers, 'hold-expiry', id, jobIds.holdExpiry(id, h.hold_expires_at), h.hold_expires_at);
    }

    const mails = await pool.query<{ id: string; attempts: number; next_attempt_at: Date }>(
      `SELECT id, attempts, next_attempt_at FROM email_outbox
        WHERE status = 'pending' AND next_attempt_at <= $1 ORDER BY next_attempt_at LIMIT $2`,
      [until, limit],
    );
    for (const m of mails.rows) {
      const id = numberOf(m.id);
      await add(this.mail, 'email-send', id, jobIds.emailSend(id, m.attempts), m.next_attempt_at);
    }
    return offered;
  }

  /**
   * Redis-loss detector: the epoch key lives only in Redis, so its absence on a live connection
   * means the data was wiped (FLUSHALL, failover to an empty node). True when a fresh epoch was
   * written, i.e. the caller must re-seed. An optimisation for latency, not needed for correctness.
   */
  async ensureEpoch(epoch: string): Promise<boolean> {
    return (await this.queueConnection.set(EPOCH_KEY, epoch, 'NX')) === 'OK';
  }

  async close(): Promise<void> {
    await Promise.all(this.consumers.map((w) => w.close()));
    await Promise.all([this.timers.close(), this.mail.close()]);
  }
}
