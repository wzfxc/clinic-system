/** Per-request GraphQL context: actor from the session cookie, fresh loaders, Clock and DB handles. */
import type { Pool } from 'pg';
import type { Clock } from '@clinic/shared';
import type { RequestActor } from '../auth/actor.js';
import { readSessionToken, SessionStore } from '../auth/sessions.js';
import { createLoaders, type Loaders } from './loaders.js';

export interface ResponseLike {
  setHeader(name: string, value: string | string[]): unknown;
}

export interface RequestLike {
  headers: { cookie?: string | undefined };
}

export interface RequestContext {
  actor: RequestActor;
  loaders: Loaders;
  pool: Pool;
  clock: Clock;
  sessions: SessionStore;
  res: ResponseLike | undefined;
  sessionToken: string | undefined;
}

export interface ContextDeps {
  pool: Pool;
  clock: Clock;
}

/** Builds the context for one HTTP request. Loaders are never shared between requests. */
export async function buildContext(
  deps: ContextDeps,
  req: RequestLike | undefined,
  res: ResponseLike | undefined,
): Promise<RequestContext> {
  const sessions = new SessionStore(deps.pool, deps.clock);
  const sessionToken = readSessionToken(req?.headers.cookie);
  return {
    actor: await sessions.resolveActor(sessionToken),
    loaders: createLoaders(deps.pool),
    pool: deps.pool,
    clock: deps.clock,
    sessions,
    res,
    sessionToken,
  };
}
