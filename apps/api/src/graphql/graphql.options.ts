/**
 * Apollo configuration shared by the app and the tests. Introspection and the landing page are off in
 * production; depth limit and error formatting apply on every transport (docs/analysis/06 section 5, 7).
 */
import { ApolloDriver, type ApolloDriverConfig } from '@nestjs/apollo';
import { NoSchemaIntrospectionCustomRule } from 'graphql';
import type { Pool } from 'pg';
import type { Clock } from '@clinic/shared';
import { buildContext } from './context.js';
import { formatGraphQLError } from './errors.js';
import { createLimitsPlugin } from './limits.js';

export interface GraphqlOptionsDeps {
  pool: Pool;
  clock: Clock;
  production: boolean;
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
    context: ({ req, res }: { req: { headers: { cookie?: string | undefined } }; res: { setHeader: (n: string, v: string | string[]) => unknown } }) =>
      buildContext(deps, req, res),
    formatError: formatGraphQLError,
  };
}
