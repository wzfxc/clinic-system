import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory } from '@nestjs/graphql';
import { printSchema } from 'graphql';
import { HealthResolver } from '../src/health.resolver.js';

/** Друкує code-first схему без підняття сервера й зʼєднань; вхід для graphql-codegen. */
async function main(): Promise<void> {
  const app = await NestFactory.create(GraphQLSchemaBuilderModule, { logger: false });
  await app.init();
  const schema = await app.get(GraphQLSchemaFactory).create([HealthResolver]);
  const target = path.resolve(import.meta.dirname, '../../../packages/shared/schema.graphql');
  writeFileSync(target, `${printSchema(schema)}\n`, 'utf8');
  await app.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
