/**
 * Integration-test support: one throw-away database per test file (so files can
 * run in parallel), migrated with the real migrations, wiped between tests.
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client, Pool, type PoolClient } from 'pg';

const DEFAULT_URL = 'postgres://clinic:clinic@localhost:5432/clinic';
const POOL_SIZE = 25;
const ADMIN_SHUTDOWN = '57P01';

/** Runs `fn` on a dedicated admin connection that is always closed afterwards. */
async function withAdmin<T>(url: string, fn: (admin: Client) => Promise<T>): Promise<T> {
  const admin = new Client({ connectionString: url });
  await admin.connect();
  try {
    return await fn(admin);
  } finally {
    await admin.end();
  }
}

export interface TestDb {
  pool: Pool;
  /** Removes all rows and restarts identities; triggers do not fire on TRUNCATE. */
  reset(): Promise<void>;
  /** Runs `fn` in its own transaction with the injected clock set, as the app does. */
  inTx<T>(clock: Date, fn: (client: PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export async function createTestDb(): Promise<TestDb> {
  const baseUrl = process.env.DATABASE_URL ?? DEFAULT_URL;
  const name = `clinic_test_${randomUUID().replace(/-/g, '')}`;

  const adminUrl = withDatabase(baseUrl, 'postgres');
  await withAdmin(adminUrl, (admin) => admin.query(`CREATE DATABASE ${name}`));

  const pool = new Pool({ connectionString: withDatabase(baseUrl, name), max: POOL_SIZE });
  // 57P01 = admin_shutdown: expected when the database is dropped under idle clients.
  pool.on('error', (err: Error & { code?: string }) => {
    if (err.code === ADMIN_SHUTDOWN) return;
    console.error('[test-db] unexpected pool error', err);
  });
  await migrate(drizzle(pool), { migrationsFolder: path.resolve(import.meta.dirname, '../../drizzle') });

  return {
    pool,
    async reset() {
      const { rows } = await pool.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE '\\_\\_%' AND tablename <> 'appointment_status_transitions'`,
      );
      const list = rows.map((r) => `"${r.tablename}"`).join(', ');
      await pool.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
    },
    async inTx(clock, fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.clock_now', $1, true)`, [clock.toISOString()]);
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
      await withAdmin(adminUrl, (admin) => admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    },
  };
}
