import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { PG_POOL, REDIS } from './database.module.js';

export interface ReadyReport {
  status: 'ok';
  postgres: 'up';
  redis: 'up' | 'down';
}

@Controller()
export class HealthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get('health')
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Postgres обовʼязковий; Redis лише інформативний: його втрата не робить api неготовим. */
  @Get('ready')
  async ready(): Promise<ReadyReport> {
    try {
      await this.pool.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable', postgres: 'down' });
    }
    return { status: 'ok', postgres: 'up', redis: await this.redisState() };
  }

  private async redisState(): Promise<'up' | 'down'> {
    try {
      if (this.redis.status === 'wait') await this.redis.connect();
      await this.redis.ping();
      return 'up';
    } catch {
      return 'down';
    }
  }
}
