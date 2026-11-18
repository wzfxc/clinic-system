import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { loadEnv } from './env.js';

for (const rel of ['../../.env', '../../../.env']) {
  try {
    process.loadEnvFile(path.resolve(import.meta.dirname, rel));
    break;
  } catch {
    // Environment variables may already be provided.
  }
}

async function main(): Promise<void> {
  const { DATABASE_URL } = loadEnv();
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    await migrate(drizzle(pool), { migrationsFolder: path.resolve(import.meta.dirname, '../drizzle') });
    console.log('migrations applied');
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
