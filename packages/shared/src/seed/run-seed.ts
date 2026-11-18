/** Entry point for the one-shot seed service (`node dist/seed/run-seed.js`). */
import { Pool } from 'pg';
import { loadEnv } from '../env.js';
import { runSeed } from './seed.js';

async function main(): Promise<void> {
  const { DATABASE_URL } = loadEnv();
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const client = await pool.connect();
    try {
      const started = performance.now();
      const report = await runSeed(client, process.env['SEED_NOW'] ?? new Date().toISOString());
      const totalMs = Math.round(performance.now() - started);
      if (report.skipped) {
        console.log('seed skipped: clinics already exist');
      } else {
        console.log(`seed done: ${report.appointments} appointments in ${totalMs} ms`);
      }
      console.log(JSON.stringify(report.timingsMs));
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
