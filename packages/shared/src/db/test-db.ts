/**
 * Integration-test support: one throw-away database per test file (so files can
 * run in parallel), migrated with the real migrations, wiped between tests.
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Client, Pool, type PoolClient } from 'pg';
import { hashPassword } from '../seed/password.js';
import { DEMO_PASSWORD, runSeed } from '../seed/seed.js';

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

export const E2E_PATIENT_EMAILS = [
  'e2e-p1@clinic.local',
  'e2e-p2@clinic.local',
  'e2e-waiter1@clinic.local',
  'e2e-waiter2@clinic.local',
] as const;

/** Ensures migrations, seed catalog and clean e2e test patients exist in the target Postgres database. */
export async function prepareE2ePatients(databaseUrl?: string): Promise<void> {
  const url = databaseUrl ?? process.env['DATABASE_URL'] ?? DEFAULT_URL;
  const pool = new Pool({ connectionString: url, max: 2 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: path.resolve(import.meta.dirname, '../../drizzle') });
    const client = await pool.connect();
    try {
      await runSeed(client, process.env['SEED_NOW'] ?? new Date().toISOString());
      const now = new Date();
      const hash = await hashPassword(DEMO_PASSWORD);
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.clock_now', $1, true)`, [now.toISOString()]);
      const patientIds: number[] = [];
      for (const [idx, email] of E2E_PATIENT_EMAILS.entries()) {
        const u = await client.query<{ id: string }>(
          `INSERT INTO users (email, role, password_hash, created_at)
           VALUES ($1, 'patient', $2, $3)
           ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
           RETURNING id`,
          [email, hash, now],
        );
        const userId = Number(u.rows[0]?.id ?? 0);
        const phone = `+38050999000${idx + 1}`;
        const p = await client.query<{ id: string }>(
          `INSERT INTO patients (user_id, full_name, phone, email)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email, phone = EXCLUDED.phone
           RETURNING id`,
          [userId, `E2E ${email}`, phone, email],
        );
        patientIds.push(Number(p.rows[0]?.id ?? 0));
      }
      await client.query(`UPDATE patients SET phone = '+38050' || lpad(id::text, 7, '0') WHERE phone IS NULL`);
      await client.query(`DELETE FROM login_attempts WHERE email = ANY($1::text[])`, [[...E2E_PATIENT_EMAILS]]);
      await client.query(
        `UPDATE waitlist_offers
            SET status = 'expired', resolved_at = $2
          WHERE status = 'pending' AND entry_id IN (
            SELECT id FROM waitlist_entries WHERE patient_id = ANY($1::bigint[])
          )`,
        [patientIds, now],
      );
      await client.query(
        `UPDATE waitlist_entries
            SET status = 'cancelled'
          WHERE patient_id = ANY($1::bigint[]) AND status IN ('waiting', 'offered')`,
        [patientIds],
      );
      await client.query(
        `UPDATE appointments
            SET status = 'cancelled', cancel_reason = 'hold_expired',
                hold_kind = NULL, hold_expires_at = NULL, updated_at = $2
          WHERE patient_id = ANY($1::bigint[]) AND status <> 'cancelled'`,
        [patientIds, now],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

/** Fast-forwards a checkout hold past its 10-minute TTL and fires the Postgres change notification. */
export async function expireCheckoutHoldForTest(appointmentId: number, databaseUrl?: string): Promise<void> {
  const url = databaseUrl ?? process.env['DATABASE_URL'] ?? DEFAULT_URL;
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const now = new Date();
    const expiredAt = new Date(now.getTime() - 60_000);
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.clock_now', $1, true)`, [now.toISOString()]);
    await client.query(
      `UPDATE appointments SET hold_expires_at = $2, updated_at = $3 WHERE id = $1 AND status = 'held'`,
      [appointmentId, expiredAt, now],
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}
