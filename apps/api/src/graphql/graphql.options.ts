/**
 * Apollo configuration shared by the app and the tests. Introspection and the landing page are off in
 * production; depth limit and error formatting apply on every transport (docs/analysis/06 section 5, 7).
 */
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { GraphQLError, Kind, NoSchemaIntrospectionCustomRule, parse } from 'graphql';
import type { Pool } from 'pg';
import type { Clock } from '@clinic/shared';
import { ERROR_CODES } from '@clinic/shared';
import { readSessionToken, SessionStore } from '../auth/sessions.js';
import { buildContext } from './context.js';
import { formatGraphQLError } from './errors.js';
import { assertStructuralLimits, createLimitsPlugin } from './limits.js';

export interface GraphqlOptionsDeps {
  pool: Pool;
  clock: Clock;
  production: boolean;
}

interface WsRequestLike {
  headers: { cookie?: string | undefined };
}

interface HttpOrWsContext {
  req?: WsRequestLike;
  res?: { setHeader: (name: string, value: string | string[]) => unknown };
  extra?: unknown;
}

/** The upgrade request of a graphql-ws connection (`extra` is `unknown` in the library's types). */
function upgradeRequest(ctx: { extra?: unknown }): WsRequestLike {
  const request = (ctx.extra as { request?: WsRequestLike } | null)?.request;
  return request ?? { headers: {} };
}

/** Over WebSocket only subscriptions are served; queries and mutations stay on HTTP where all limits apply. */
function checkWsOperation(query: string | undefined): readonly GraphQLError[] | undefined {
  try {
    const document = parse(query ?? '');
    const allSubscriptions = document.definitions.every(
      (def) => def.kind !== Kind.OPERATION_DEFINITION || def.operation === 'subscription',
    );
    if (!allSubscriptions) {
      return [new GraphQLError('Only subscriptions are served over WebSocket', { extensions: { code: ERROR_CODES.BAD_REQUEST } })];
    }
    assertStructuralLimits(document);
    return undefined;
  } catch (err: unknown) {
    return [err instanceof GraphQLError ? err : new GraphQLError('Invalid operation', { extensions: { code: ERROR_CODES.GRAPHQL_PARSE_FAILED } })];
  }
}

export function buildGraphqlOptions(deps: GraphqlOptionsDeps): ApolloDriverConfig {
  return {
    driver: ApolloDriver,
    autoSchemaFile: true,
    path: '/graphql',
    sortSchema: true,
    introspection: !deps.production,
    validationRules: deps.production ? [NoSchemaIntrospectionCustomRule] : [],
    plugins: [createLimitsPlugin()],
    subscriptions: {
      'graphql-ws': {
        // connection_init: no valid session, no connection (closes with 4403).
        onConnect: async (ctx: { extra: unknown }) => {
          const sessions = new SessionStore(deps.pool, deps.clock);
          const actor = await sessions.resolveActor(readSessionToken(upgradeRequest(ctx).headers.cookie));
          return actor.role !== 'anon';
        },
        onSubscribe: (_ctx: unknown, _id: string, payload: { query?: string }) => checkWsOperation(payload.query),
      },
    },
    // HTTP calls this with { req, res }; graphql-ws calls it with its connection context (cookie from the upgrade request).
    context: (arg: HttpOrWsContext) =>
      arg.req ? buildContext(deps, arg.req, arg.res) : buildContext(deps, upgradeRequest(arg), undefined),
    formatError: formatGraphQLError,
  };
}
