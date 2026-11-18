import 'reflect-metadata';
import path from 'node:path';
import { NestFactory } from '@nestjs/core';
import { loadEnv } from '@clinic/shared';
import { AppModule } from './app.module.js';
import { parseAllowedOrigins } from './graphql/graphql.options.js';

try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../../../.env'));
} catch {
  // In Docker or CI environment variables are already set.
}

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: [...parseAllowedOrigins(process.env['ALLOWED_ORIGINS'])],
    credentials: true,
  });
  app.enableShutdownHooks();
  await app.listen(env.API_PORT, '0.0.0.0');
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
