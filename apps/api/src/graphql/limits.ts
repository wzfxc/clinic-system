/**
 * Query depth limit, enforced in Apollo's didResolveOperation so it runs before any resolver.
 * Fragments are expanded (a fragment spread counts at the depth where it is used).
 */
import { Kind, GraphQLError, type DocumentNode, type FragmentDefinitionNode, type SelectionSetNode } from 'graphql';
import type { ApolloServerPlugin } from '@apollo/server';
import { getComplexity, simpleEstimator } from 'graphql-query-complexity';
import { ERROR_CODES } from '@clinic/shared';

export const MAX_QUERY_DEPTH = 10;
/** Every field costs 1; the budget bounds total breadth (aliases, repeated fields, wide selections). */
export const MAX_QUERY_COMPLEXITY = 500;
/** Upper bound on selections visited while expanding fragments, so repeated spreads cannot blow up. */
const MAX_SELECTION_VISITS = 10_000;

export function queryDepth(document: DocumentNode): number {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const def of document.definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def);
  }
  let max = 0;
  let visits = 0;

  const visit = (set: SelectionSetNode, depth: number, spreading: ReadonlySet<string>): void => {
    for (const selection of set.selections) {
      visits += 1;
      if (visits > MAX_SELECTION_VISITS) {
        throw new GraphQLError('Query is too complex', { extensions: { code: ERROR_CODES.QUERY_TOO_COMPLEX } });
      }
      if (selection.kind === Kind.FIELD) {
        const fieldDepth = depth + 1;
        max = Math.max(max, fieldDepth);
        if (selection.selectionSet) visit(selection.selectionSet, fieldDepth, spreading);
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        visit(selection.selectionSet, depth, spreading);
      } else {
        const name = selection.name.value;
        const fragment = fragments.get(name);
        if (!fragment || spreading.has(name)) continue;
        visit(fragment.selectionSet, depth, new Set([...spreading, name]));
      }
    }
  };

  for (const def of document.definitions) {
    if (def.kind === Kind.OPERATION_DEFINITION) visit(def.selectionSet, 0, new Set());
  }
  return max;
}

/** Limits that need only the document; also applied to operations received over WebSocket. */
export function assertStructuralLimits(document: DocumentNode): void {
  if (queryDepth(document) > MAX_QUERY_DEPTH) {
    throw new GraphQLError('Query is too deep', { extensions: { code: ERROR_CODES.QUERY_TOO_DEEP } });
  }
}

export function createLimitsPlugin(): ApolloServerPlugin {
  return {
    async requestDidStart() {
      return {
        async didResolveOperation({ document, schema, request, operationName }) {
          assertStructuralLimits(document);
          const complexity = getComplexity({
            schema,
            query: document,
            variables: request.variables ?? {},
            ...(operationName ? { operationName } : {}),
            estimators: [simpleEstimator({ defaultComplexity: 1 })],
          });
          if (complexity > MAX_QUERY_COMPLEXITY) {
            throw new GraphQLError('Query is too complex', { extensions: { code: ERROR_CODES.QUERY_TOO_COMPLEX } });
          }
        },
      };
    },
  };
}
