/**
 * Per-account login throttling in Postgres (table login_attempts), time from the Clock.
 * Keyed by normalized email whether or not the account exists, so the lock reveals nothing about accounts.
 * After MAX_FAILURES failures inside FAILURE_WINDOW_MS the account is locked for LOCK_MS; success clears the counter.
 */
import type { Pool } from 'pg';
import type { Clock } from '@clinic/shared';

export const MAX_FAILURES = 5;
export const MAX_IP_LOGIN_FAILURES = 20;
export const MAX_IP_REGISTRATIONS = 25;
export const FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const LOCK_MS = 15 * 60 * 1000;
const MAX_KEY_LENGTH = 254;

export class LoginThrottle {
  constructor(
    private readonly pool: Pool,
    private readonly clock: Clock,
  ) {}

  private key(raw: string): string {
    return raw.slice(0, MAX_KEY_LENGTH);
  }

  async isLocked(rawKey: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ locked: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM login_attempts WHERE email = $1 AND locked_until > $2) AS locked`,
      [this.key(rawKey), this.clock.now()],
    );
    return rows[0]?.locked === true;
  }

  /** One atomic upsert: restarts the window when it has expired, locks at the threshold. */
  async recordFailure(rawKey: string, threshold: number = MAX_FAILURES): Promise<void> {
    const now = this.clock.now();
    await this.pool.query(
      `INSERT INTO login_attempts (email, failures, window_started_at, locked_until)
       VALUES ($1, 1, $2, NULL)
       ON CONFLICT (email) DO UPDATE SET
         failures = CASE WHEN login_attempts.window_started_at + make_interval(secs => $3) <= $2
                         THEN 1 ELSE login_attempts.failures + 1 END,
         window_started_at = CASE WHEN login_attempts.window_started_at + make_interval(secs => $3) <= $2
                                  THEN $2 ELSE login_attempts.window_started_at END,
         locked_until = CASE
           WHEN (CASE WHEN login_attempts.window_started_at + make_interval(secs => $3) <= $2
                      THEN 1 ELSE login_attempts.failures + 1 END) >= $4
           THEN $2::timestamptz + make_interval(secs => $5) ELSE NULL END`,
      [this.key(rawKey), now, FAILURE_WINDOW_MS / 1000, threshold, LOCK_MS / 1000],
    );
  }

  async clear(rawKey: string): Promise<void> {
    await this.pool.query(`DELETE FROM login_attempts WHERE email = $1`, [this.key(rawKey)]);
  }
}
