/**
 * Login hardening over HTTP: constant-work login, one auth root field per request, root-field cap,
 * and per-account throttling driven by the injected Clock.
 */
import 'reflect-metadata';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { GraphQLModule } from '@nestjs/graphql';
import type { ApolloDriverConfig } from '@nestjs/apollo';
import type { INestApplication } from '@nestjs/common';
import { FixedClock } from '@clinic/shared';
import { createTestDb, type TestDb } from '@clinic/shared/testing';
import { buildGraphqlOptions } from '../graphql/graphql.options.js';
import { AuthResolver } from './auth.resolver.js';
import { FAILURE_WINDOW_MS, LOCK_MS, MAX_FAILURES } from './login-throttle.js';
import * as password from './password.js';

vi.mock('./password.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./password.js')>();
  return { ...actual, verifyPassword: vi.fn(actual.verifyPassword) };
});

interface GqlResponse {
  data?: Record<string, unknown> | null;
  errors?: { message: string; extensions?: { code?: string } }[];
}

const NOW = new Date('2026-06-01T08:00:00Z');
const PASSWORD = 'correct-horse-battery';

let db: TestDb;
let clock: FixedClock;
let app: INestApplication;
let url: string;

async function gql(query: string): Promise<GqlResponse> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return (await res.json()) as GqlResponse;
}

const codeOf = (res: GqlResponse): string | undefined => res.errors?.[0]?.extensions?.code;
const login = (email: string, pw: string): Promise<GqlResponse> =>
  gql(`mutation { login(email: "${email}", password: "${pw}") { role } }`);

beforeAll(async () => {
  db = await createTestDb();
  clock = new FixedClock(NOW);
  const moduleRef = await Test.createTestingModule({
    imports: [GraphQLModule.forRoot<ApolloDriverConfig>(buildGraphqlOptions({ pool: db.pool, clock, production: false }))],
    providers: [AuthResolver],
  }).compile();
  app = moduleRef.createNestApplication({ logger: false });
  await app.listen(0, '127.0.0.1');
  url = `${await app.getUrl()}/graphql`;
});

afterAll(async () => {
  await app?.close();
  await db?.close();
});

beforeEach(async () => {
  await db.reset();
  clock.set(NOW);
  vi.mocked(password.verifyPassword).mockClear();
  const res = await gql(
    `mutation { register(input: {email: "user@example.test", password: "${PASSWORD}", fullName: "U"}) { role } }`,
  );
  expect(res.errors).toBeUndefined();
});

describe('login timing', () => {
  it('verifies a password hash even when the email is unknown', async () => {
    const res = await login('nobody@example.test', 'whatever-password');
    expect(codeOf(res)).toBe('INVALID_CREDENTIALS');
    expect(password.verifyPassword).toHaveBeenCalledTimes(1);
  });
});

describe('operation shape limits', () => {
  it('rejects more than one login or register root field, aliases included', async () => {
    const res = await gql(
      `mutation { a: login(email: "x@example.test", password: "p") { role } b: login(email: "y@example.test", password: "p") { role } }`,
    );
    expect(codeOf(res)).toBe('BAD_REQUEST');
    const mixed = await gql(
      `mutation { a: login(email: "x@example.test", password: "p") { role } b: register(input: {email: "z@example.test", password: "${PASSWORD}", fullName: "Z"}) { role } }`,
    );
    expect(codeOf(mixed)).toBe('BAD_REQUEST');
    expect(password.verifyPassword).not.toHaveBeenCalled();
  });

  it('caps the number of root fields including aliases', async () => {
    const many = Array.from({ length: 11 }, (_, i) => `a${i}: me { userId }`).join(' ');
    expect(codeOf(await gql(`{ ${many} }`))).toBe('QUERY_TOO_COMPLEX');
  });
});

describe('login throttling', () => {
  async function failMax(email: string): Promise<void> {
    for (let i = 0; i < MAX_FAILURES; i += 1) {
      expect(codeOf(await login(email, 'wrong-password'))).toBe('INVALID_CREDENTIALS');
    }
  }

  it('locks the account after repeated failures, even for the right password, then unlocks by the Clock', async () => {
    await failMax('user@example.test');
    expect(codeOf(await login('user@example.test', PASSWORD))).toBe('RATE_LIMITED');
    clock.advance(LOCK_MS + 1000);
    expect((await login('user@example.test', PASSWORD)).errors).toBeUndefined();
  });

  it('throttles unknown emails the same way, so the lock does not reveal whether an account exists', async () => {
    await failMax('ghost@example.test');
    expect(codeOf(await login('ghost@example.test', 'wrong-password'))).toBe('RATE_LIMITED');
  });

  it('starts a fresh window once the failure window has passed, and success clears the counter', async () => {
    for (let i = 0; i < MAX_FAILURES - 1; i += 1) await login('user@example.test', 'wrong-password');
    clock.advance(FAILURE_WINDOW_MS + 1000);
    await login('user@example.test', 'wrong-password');
    expect((await login('user@example.test', PASSWORD)).errors).toBeUndefined();
    const { rows } = await db.pool.query(`SELECT 1 FROM login_attempts WHERE email = 'user@example.test'`);
    expect(rows).toHaveLength(0);
  });
});
