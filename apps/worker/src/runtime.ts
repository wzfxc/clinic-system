import type { Pool } from 'pg';
import type { Clock } from '@clinic/shared';
import type { WorkerConfig } from './config.js';
import type { Mailer } from './mailer.js';
import { sweepOnce } from './sweeper.js';

export interface RuntimeDeps {
  pool: Pool;
  clock: Clock;
  mailer: Mailer;
  workerId: string;
  config: WorkerConfig;
  onError: (message: string, err: unknown) => void;
}

/** Start/stop wrapper around the periodic sweeper; a failed pass is reported and the next one still runs. */
export class WorkerRuntime {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<unknown> = Promise.resolve();
  private stopped = false;

  constructor(private readonly deps: RuntimeDeps) {}

  async start(): Promise<void> {
    await sweepOnce(this.deps);
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    await this.running;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = sweepOnce(this.deps)
        .catch((err: unknown) => this.deps.onError('sweep failed', err))
        .finally(() => this.schedule());
    }, this.deps.config.sweepIntervalMs);
  }
}
