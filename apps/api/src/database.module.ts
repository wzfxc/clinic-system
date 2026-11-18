import { Global, Inject, Injectable, Module, OnApplicationShutdown } from '@nestjs/common';
import { CLOCK, loadEnv, SystemClock } from '@clinic/shared';
import { Pool } from 'pg';
import { Redis } from 'ioredis';

export const PG_POOL = Symbol('PG_POOL');
export const REDIS = Symbol('REDIS');

@Injectable()
class ConnectionsShutdown implements OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    this.redis.disconnect();
    await this.pool.end();
  }
}

@Global()
@Module({
  providers: [
    { provide: CLOCK, useClass: SystemClock },
    { provide: PG_POOL, useFactory: () => new Pool({ connectionString: loadEnv().DATABASE_URL }) },
    // Redis лише тригер: lazyConnect + без ретраїв команд, щоб його втрата не блокувала api.
    {
      provide: REDIS,
      useFactory: () =>
        new Redis(loadEnv().REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1, enableOfflineQueue: false }),
    },
    ConnectionsShutdown,
  ],
  exports: [PG_POOL, REDIS, CLOCK],
})
export class DatabaseModule {}
