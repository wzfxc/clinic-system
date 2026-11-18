/**
 * Stage 9 acceptance: findFreeSlots and managerReport on the full demo seed (about 147k appointments), each under 300 ms.
 * Timings are printed. Run with DATABASE_URL pointing at a scratch Postgres server; the test creates its own database.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { GraphQLModule } from '@nestjs/graphql';
import type { ApolloDriverConfig } from '@nestjs/apollo';
import type { INestApplication } from '@nestjs/common';
import { FixedClock } from '@clinic/shared';
import { runSeed, DEMO_PASSWORD } from '@clinic/shared/seed';
import { createTestDb, type TestDb } from '@clinic/shared/testing';
import { AuthResolver } from '../auth/auth.resolver.js';
import { buildGraphqlOptions } from '../graphql/graphql.options.js';
import { FreeSlotsResolver } from '../slots/free-slots.resolver.js';
import { ReportResolver } from './report.resolver.js';

const SEED_NOW = '2026-11-18T12:00:00.000Z';
const BUDGET_MS = 300;
const RUNS = 3;
const SETUP_TIMEOUT_MS = 240_000;

interface GqlResponse {
  data?: Record<string, unknown> | null;
  errors?: { extensions?: { code?: string } }[];
}

let db: TestDb;
let app: INestApplication;
let url: string;

async function gql(query: string, cookie?: string): Promise<{ body: GqlResponse; ms: number; cookie: string }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers['cookie'] = cookie;
  const started = performance.now();
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ query }) });
  const body = (await res.json()) as GqlResponse;
  return { body, ms: Math.round(performance.now() - started), cookie: (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '' };
}

async function login(email: string): Promise<string> {
  const { body, cookie } = await gql(`mutation { login(email: "${email}", password: "${DEMO_PASSWORD}") { role } }`);
  expect(body.errors).toBeUndefined();
  return cookie;
}

async function timed(query: string, cookie: string): Promise<number[]> {
  const times: number[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    const { body, ms } = await gql(query, cookie);
    expect(body.errors).toBeUndefined();
    times.push(ms);
  }
  return times;
}

beforeAll(async () => {
  db = await createTestDb();
  const client = await db.pool.connect();
  try {
    await runSeed(client, SEED_NOW);
  } finally {
    client.release();
  }
  await db.pool.query('ANALYZE');
  const moduleRef = await Test.createTestingModule({
    imports: [
      GraphQLModule.forRoot<ApolloDriverConfig>(
        buildGraphqlOptions({ pool: db.pool, clock: new FixedClock(new Date(SEED_NOW)), production: false }),
      ),
    ],
    providers: [AuthResolver, FreeSlotsResolver, ReportResolver],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  url = `${await app.getUrl()}/graphql`;
}, SETUP_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
  await db?.close();
});

const REPORT = `{ managerReport { fromDate toDate
  totals { loadPercent noShowShare lateCancelShare acceptedOffers completed cancelled lateCancelled }
  doctors { doctorId loadPercent } revenue { serviceName currency revenueMinor } } }`;
const FREE_SLOTS = (service: number): string =>
  `{ findFreeSlots(city: "Kyiv", serviceId: ${service}) { clinicId doctorId startAt localDate localTime } }`;

describe('stage 9: report and free slots on the seed', () => {
  it('managerReport answers under 300 ms with sane numbers', async () => {
    const cookie = await login('manager@clinic.local');
    const times = await timed(REPORT, cookie);
    console.log(`[perf] managerReport ms: ${times.join(', ')}`);
    expect(Math.max(...times)).toBeLessThan(BUDGET_MS);
    const { body } = await gql(REPORT, cookie);
    const report = body.data?.['managerReport'] as {
      totals: { loadPercent: number; noShowShare: number; lateCancelShare: number };
      doctors: unknown[];
      revenue: unknown[];
    };
    expect(report.doctors).toHaveLength(40);
    expect(report.revenue.length).toBeGreaterThan(0);
    expect(report.totals.loadPercent).toBeGreaterThan(20);
    expect(report.totals.noShowShare).toBeGreaterThan(0);
    expect(report.totals.lateCancelShare).toBeGreaterThan(0);
  });

  it('managerReport is manager only', async () => {
    expect((await gql(REPORT)).body.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
    for (const email of ['reception1@clinic.local', 'doctor1@clinic.local', 'patient1@clinic.local']) {
      const { body } = await gql(REPORT, await login(email));
      expect(body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
    }
  });

  it('findFreeSlots answers under 300 ms and returns free slots in the next 14 days', async () => {
    const cookie = await login('patient1@clinic.local');
    const { rows } = await db.pool.query<{ id: string }>("SELECT id FROM services WHERE name = 'General consultation'");
    const service = Number(rows[0]?.id);
    const times = await timed(FREE_SLOTS(service), cookie);
    console.log(`[perf] findFreeSlots ms: ${times.join(', ')}`);
    expect(Math.max(...times)).toBeLessThan(BUDGET_MS);
    const { body } = await gql(FREE_SLOTS(service), cookie);
    const slots = body.data?.['findFreeSlots'] as { startAt: string; localDate: string }[];
    expect(slots.length).toBeGreaterThan(0);
    const last = new Date(SEED_NOW).getTime() + 15 * 24 * 3_600_000;
    expect(slots.every((s) => new Date(s.startAt).getTime() <= last)).toBe(true);
  });

  it('findFreeSlots requires a signed-in non-manager', async () => {
    expect((await gql(FREE_SLOTS(1))).body.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
  });
});
