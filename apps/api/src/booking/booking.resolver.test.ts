import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { GraphQLError } from 'graphql';
import { BookingError, ERROR_CODES } from '@clinic/shared';
import type { RequestContext } from '../graphql/context.js';
import { BookingResolver } from './booking.resolver.js';

const STAFF_ACTOR = { role: 'receptionist', userId: 1, clinicId: 1 } as const;

function contextWithChangeStatus(changeStatus: (input: unknown) => Promise<unknown>): RequestContext {
  return { actor: STAFF_ACTOR, booking: { changeStatus } } as unknown as RequestContext;
}

async function errorOf(promise: Promise<unknown>): Promise<GraphQLError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof GraphQLError) return err;
    throw err;
  }
  throw new Error('expected rejection');
}

describe('BookingResolver.changeAppointmentStatus', () => {
  it('reports a foreign appointment as NOT_FOUND with the same message as a missing one', async () => {
    const foreign = contextWithChangeStatus(() =>
      Promise.reject(new BookingError(ERROR_CODES.FORBIDDEN, 'not your clinic')),
    );
    const missing = contextWithChangeStatus(() =>
      Promise.reject(new BookingError(ERROR_CODES.NOT_FOUND, 'no such appointment')),
    );
    const resolver = new BookingResolver();

    const foreignErr = await errorOf(resolver.changeAppointmentStatus(foreign, 42, 'checked_in'));
    const missingErr = await errorOf(resolver.changeAppointmentStatus(missing, 42, 'checked_in'));

    expect(foreignErr.message).toBe('appointment not found');
    expect(foreignErr.message).toBe(missingErr.message);
    expect(foreignErr.extensions).toEqual(missingErr.extensions);
    expect(foreignErr.extensions).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });
});
