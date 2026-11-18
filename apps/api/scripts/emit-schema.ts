import 'reflect-metadata';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { GraphQLSchemaBuilderModule, GraphQLSchemaFactory } from '@nestjs/graphql';
import { printSchema } from 'graphql';
import { AuthResolver } from '../src/auth/auth.resolver.js';
import { AppointmentResolver } from '../src/appointments/appointment.resolver.js';

/**
 * Prints the code-first schema without starting a server or connecting to anything; the input for graphql-codegen.
 * Run through `schema:emit` (tsc, so decorator metadata is emitted), with the package directory as cwd.
 */
async function main(): Promise<void> {
  const app = await NestFactory.create(GraphQLSchemaBuilderModule, { logger: false });
  await app.init();
  const schema = await app.get(GraphQLSchemaFactory).create([AuthResolver, AppointmentResolver]);
  const target = path.resolve(process.cwd(), '../../packages/shared/schema.graphql');
  writeFileSync(target, `${printSchema(schema)}\n`, 'utf8');
  await app.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
