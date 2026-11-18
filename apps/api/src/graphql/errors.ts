/**
 * The single place where errors become GraphQL responses (docs/analysis/06 section 7).
 * Registry codes pass through; anything else becomes INTERNAL with a generic message.
 */
import { Logger } from '@nestjs/common';
import type { GraphQLFormattedError } from 'graphql';
import { ERROR_CODES, isErrorCode, type BookingError } from '@clinic/shared';

const logger = new Logger('GraphQL');

/**
 * Structural check instead of instanceof: the class may be loaded twice (built dist and TS source
 * through the workspace test entry points), and instanceof then fails and turns a domain error into INTERNAL.
 */
export function isBookingError(value: unknown): value is BookingError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { name?: unknown }).name === 'BookingError' &&
    typeof (value as { code?: unknown }).code === 'string' &&
    isErrorCode((value as { code: string }).code)
  );
}

/** Follows `originalError` structurally; `instanceof GraphQLError` fails when graphql is loaded twice. */
function unwrap(error: unknown): unknown {
  if (typeof error === 'object' && error !== null && 'originalError' in error) {
    const inner = (error as { originalError?: unknown }).originalError;
    if (inner !== undefined && inner !== null) return inner;
  }
  return error;
}

export function formatGraphQLError(formatted: GraphQLFormattedError, error: unknown): GraphQLFormattedError {
  const original = unwrap(error);
  if (isBookingError(original)) {
    return { message: original.message, extensions: { code: original.code, ...original.details } };
  }
  const code = formatted.extensions?.['code'];
  if (typeof code === 'string' && isErrorCode(code)) return formatted;
  logger.error('Unhandled GraphQL error', original instanceof Error ? original.stack : String(original));
  return { message: 'Unexpected error', extensions: { code: ERROR_CODES.INTERNAL } };
}
