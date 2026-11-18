import type { CodegenConfig } from '@graphql-codegen/cli';

// Types come ONLY from the schema emitted by the API (packages/shared/schema.graphql).
const config: CodegenConfig = {
  schema: '../../packages/shared/schema.graphql',
  documents: ['src/graphql/**/*.graphql'],
  generates: {
    './src/graphql/generated/index.ts': {
      plugins: ['typescript', 'typescript-operations', 'typed-document-node'],
      config: { enumsAsTypes: true, useTypeImports: true, scalars: { DateTime: 'string' } },
    },
  },
};

export default config;
