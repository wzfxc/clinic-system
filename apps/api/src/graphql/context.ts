/** Per-request GraphQL context: actor from the session cookie, fresh loaders, Clock and DB handles. */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { BookingService, createWaitlistHooks, WaitlistService, type Clock } from '@clinic/shared';
import type { RequestActor } from '../auth/actor.js';
import { readSessionToken, SessionStore } from '../auth/sessions.js';
import { createLoaders, type Loaders } from './loaders.js';

export interface ResponseLike {
  setHeader(name: string, value: string | string[]): unknown;
}

export interface RequestLike {
  headers: {
    cookie?: string | undefined;
    'user-agent'?: string | undefined;
    'x-forwarded-for'?: string | undefined;
  };
  socket?: { remoteAddress?: string | undefined } | undefined;
}

export interface RequestContext {
  actor: RequestActor;
  loaders: Loaders;
  pool: Pool;
  clock: Clock;
  booking: BookingService;
  waitlist: WaitlistService;
  sessions: SessionStore;
  res: ResponseLike | undefined;
  sessionToken: string | undefined;
  clientIp: string;
  deviceKey: string | undefined;
}

export interface ContextDeps {
  pool: Pool;
  clock: Clock;
}

const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Extracts the peer IP; X-Forwarded-For is ignored unless TRUST_PROXY=true (prevents spoofing). */
export function resolveClientIp(req: RequestLike | undefined): string {
  if (process.env['TRUST_PROXY'] === 'true') {
    const forwarded = req?.headers['x-forwarded-for']?.split(',')[0]?.trim();
    if (forwarded) return forwarded;
  }
  return req?.socket?.remoteAddress ?? '127.0.0.1';
}

export function resolveDeviceKey(req: RequestLike | undefined, clientIp: string): string | undefined {
  const ua = req?.headers['user-agent']?.trim() ?? '';
  if (LOOPBACK_IPS.has(clientIp) && (ua === '' || ua === 'node')) return undefined;
  return createHash('sha256').update(`${clientIp}|${ua}`).digest('hex').slice(0, 16);
}

/** Builds the context for one HTTP request. Loaders are never shared between requests. */
export async function buildContext(
  deps: ContextDeps,
  req: RequestLike | undefined,
  res: ResponseLike | undefined,
): Promise<RequestContext> {
  const sessions = new SessionStore(deps.pool, deps.clock);
  const sessionToken = readSessionToken(req?.headers.cookie);
  const clientIp = resolveClientIp(req);
  const deviceKey = resolveDeviceKey(req, clientIp);
  return {
    actor: await sessions.resolveActor(sessionToken),
    loaders: createLoaders(deps.pool),
    pool: deps.pool,
    clock: deps.clock,
    booking: new BookingService(deps.pool, deps.clock, createWaitlistHooks()),
    waitlist: new WaitlistService(deps.pool, deps.clock),
    sessions,
    res,
    sessionToken,
    clientIp,
    deviceKey,
  };
}
