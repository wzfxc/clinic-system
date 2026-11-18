import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { Clock } from '@clinic/shared';
import { createWsOnConnect, isAllowedWsOrigin, parseAllowedOrigins, type GraphqlOptionsDeps } from './graphql.options.js';

const ALLOWED = ['http://localhost:3000', 'https://app.example.test'];

/** Only the origin branch is exercised: a rejected origin returns before any database access. */
const UNUSED_DEPS = { pool: {} as unknown as Pool, clock: {} as unknown as Clock };

function connectContext(origin: string | undefined): { extra: unknown } {
  return { extra: { request: { headers: { origin, cookie: undefined } } } };
}

describe('parseAllowedOrigins', () => {
  it('falls back to the dev default when ALLOWED_ORIGINS is unset', () => {
    expect(parseAllowedOrigins(undefined)).toEqual(['http://localhost:3000']);
  });

  it('splits a comma-separated list and trims blanks', () => {
    expect(parseAllowedOrigins(' https://a.test , https://b.test,')).toEqual(['https://a.test', 'https://b.test']);
  });
});

describe('isAllowedWsOrigin', () => {
  it('accepts an allowlisted Origin and rejects any other', () => {
    expect(isAllowedWsOrigin('http://localhost:3000', true, ALLOWED)).toBe(true);
    expect(isAllowedWsOrigin('https://evil.example', false, ALLOWED)).toBe(false);
  });

  it('accepts a missing Origin only outside production', () => {
    expect(isAllowedWsOrigin(undefined, false, ALLOWED)).toBe(true);
    expect(isAllowedWsOrigin(undefined, true, ALLOWED)).toBe(false);
  });
});

describe('graphql-ws onConnect origin check', () => {
  const onConnect = createWsOnConnect({ ...UNUSED_DEPS, production: true } as GraphqlOptionsDeps, ALLOWED);

  it('rejects a connection from a non-allowlisted Origin before any session lookup', async () => {
    expect(await onConnect(connectContext('https://evil.example'))).toBe(false);
  });

  it('rejects a connection with no Origin in production', async () => {
    expect(await onConnect(connectContext(undefined))).toBe(false);
  });
});
