import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { CLOCK, loadEnv, type Clock } from '@clinic/shared';
import { Pool } from 'pg';
import { DEFAULT_CONFIG } from './config.js';
import { SmtpMailer } from './mailer.js';
import { WorkerRuntime } from './runtime.js';

/** Wires the runtime to the environment; all logic lives in plain modules so tests can drive it directly. */
@Injectable()
export class WorkerService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerService.name);
  private pool?: Pool;
  private mailer?: SmtpMailer;
  private runtime?: WorkerRuntime;

  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  async onModuleInit(): Promise<void> {
    const env = loadEnv();
    const config = DEFAULT_CONFIG;
    this.pool = new Pool({ connectionString: env.DATABASE_URL });
    this.mailer = new SmtpMailer({ host: env.SMTP_HOST, port: env.SMTP_PORT, timeoutMs: config.smtpTimeoutMs });
    const workerId = `worker-${randomUUID()}`;
    this.runtime = new WorkerRuntime({
      pool: this.pool,
      clock: this.clock,
      mailer: this.mailer,
      workerId,
      config,
      onError: (message, err) => this.logger.error(`${message}: ${err instanceof Error ? err.message : String(err)}`),
    });
    await this.runtime.start();
    this.logger.log(`${workerId} started`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.runtime?.stop();
    this.mailer?.close();
    await this.pool?.end();
  }
}
