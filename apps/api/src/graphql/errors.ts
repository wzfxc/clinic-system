/**
 * The single place where errors become GraphQL responses (docs/analysis/06 section 7).
 * Registry codes pass through; anything else becomes INTERNAL with a generic message.
 */
import { Logger } from '@nestjs/common';
import { GraphQLError, type GraphQLFormattedError } from 'graphql';
import { BookingError, ERROR_CODES, isErrorCode } from '@clinic/shared';

const logger = new Logger('GraphQL');

export function formatGraphQLError(formatted: GraphQLFormattedError, error: unknown): GraphQLFormattedError {
  const original = error instanceof GraphQLError ? (error.originalError ?? error) : error;
  if (original instanceof BookingError) {
    return { message: original.message, extensions: { code: original.code, ...original.details } };
  }
  const code = formatted.extensions?.['code'];
  if (typeof code === 'string' && isErrorCode(code)) return formatted;
  logger.error('Unhandled GraphQL error', original instanceof Error ? original.stack : String(original));
  return { message: 'Unexpected error', extensions: { code: ERROR_CODES.INTERNAL } };
}
