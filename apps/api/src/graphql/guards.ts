/**
 * Resolver-level checks (docs/analysis/06 section 2). Each resolver calls one of these first; a failure is a
 * registry code in extensions, so the client can translate it.
 */
import { GraphQLError } from 'graphql';
import { ERROR_CODES, type AuthActor } from '@clinic/shared';
import type { RequestContext } from './context.js';

export function graphQLError(code: (typeof ERROR_CODES)[keyof typeof ERROR_CODES], message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code } });
}

/** Any signed-in actor with a patient, doctor or registrar role. Anonymous gets UNAUTHENTICATED; a manager FORBIDDEN. */
export function requireAuthActor(ctx: RequestContext): AuthActor {
  switch (ctx.actor.role) {
    case 'anon':
      throw graphQLError(ERROR_CODES.UNAUTHENTICATED, 'sign in required');
    case 'manager':
      throw graphQLError(ERROR_CODES.FORBIDDEN, 'role not allowed');
    default:
      return ctx.actor;
  }
}

export function requirePatient(ctx: RequestContext): Extract<AuthActor, { role: 'patient' }> {
  const actor = requireAuthActor(ctx);
  if (actor.role !== 'patient') throw graphQLError(ERROR_CODES.FORBIDDEN, 'patients only');
  return actor;
}

/** Page size: default 50, at most 100; out of range is rejected, not clamped (docs/analysis/06 section 5). */
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

export function pageSize(first: number | undefined): number {
  if (first === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(first) || first < 1 || first > MAX_PAGE_SIZE) {
    throw new GraphQLError(`first must be between 1 and ${MAX_PAGE_SIZE}`, {
      extensions: { code: ERROR_CODES.VALIDATION_FAILED, field: 'first' },
    });
  }
  return first;
}
