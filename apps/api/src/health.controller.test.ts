import { ServiceUnavailableException } from '@nestjs/common';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';
import { HealthController } from './health.controller.js';

function build(opts: { pgFails?: boolean; redisFails?: boolean }): HealthController {
  const pool = { query: vi.fn(async () => (opts.pgFails ? Promise.reject(new Error('down')) : { rows: [] })) };
  const redis = { status: 'ready', ping: vi.fn(async () => (opts.redisFails ? Promise.reject(new Error('down')) : 'PONG')) };
  return new HealthController(pool as unknown as Pool, redis as unknown as Redis);
}

describe('HealthController', () => {
  it('health always returns ok', () => {
    expect(build({}).health()).toEqual({ status: 'ok' });
  });

  it('ready reports ok when postgres and redis are up', async () => {
    await expect(build({}).ready()).resolves.toEqual({ status: 'ok', postgres: 'up', redis: 'up' });
  });

  it('ready stays ok when redis is lost', async () => {
    await expect(build({ redisFails: true }).ready()).resolves.toEqual({ status: 'ok', postgres: 'up', redis: 'down' });
  });

  it('ready fails with 503 when postgres is down', async () => {
    await expect(build({ pgFails: true }).ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
