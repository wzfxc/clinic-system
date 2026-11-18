/**
 * Opaque server-side sessions (docs/analysis/06 section 1). The cookie carries a random token;
 * Postgres stores only its sha-256, so a database leak yields no usable session. Expiry comes from the Clock.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import type { Clock } from '@clinic/shared';
import type { RequestActor } from './actor.js';

export const SESSION_COOKIE = 'session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_BYTES = 32;

/** Minimal query surface shared by Pool and PoolClient, so register can reuse a transaction. */
export type Queryable = Pick<Pool, 'query'>;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Pulls the session token out of a raw Cookie header. */
export function readSessionToken(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === SESSION_COOKIE && value.length > 0) return value.join('=');
  }
  return undefined;
}

export class SessionStore {
  constructor(
    private readonly pool: Pool,
    private readonly clock: Clock,
  ) {}

  /** Creates a session and returns the raw token (only its hash is stored). */
  async create(db: Queryable, userId: number): Promise<string> {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const now = this.clock.now();
    await db.query(
      `INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)`,
      [hashToken(token), userId, now, new Date(now.getTime() + SESSION_TTL_MS)],
    );
    return token;
  }

  async revoke(token: string): Promise<void> {
    await this.pool.query(`UPDATE sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL`, [
      hashToken(token),
      this.clock.now(),
    ]);
  }

  /** Maps a token to the actor it belongs to; an unknown, revoked or expired token is `anon`. */
  async resolveActor(token: string | undefined): Promise<RequestActor> {
    if (!token) return { role: 'anon' };
    const { rows } = await this.pool.query<SessionActorRow>(
      `SELECT u.id::int AS user_id, u.role, u.clinic_id::int AS clinic_id,
              p.id::int AS patient_id, d.id::int AS doctor_id
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN patients p ON p.user_id = u.id
         LEFT JOIN doctors d ON d.user_id = u.id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2`,
      [hashToken(token), this.clock.now()],
    );
    const row = rows[0];
    return row ? toActor(row) : { role: 'anon' };
  }
}

interface SessionActorRow {
  user_id: number;
  role: string;
  clinic_id: number | null;
  patient_id: number | null;
  doctor_id: number | null;
}

function toActor(row: SessionActorRow): RequestActor {
  switch (row.role) {
    case 'patient':
      return row.patient_id === null
        ? { role: 'anon' }
        : { role: 'patient', userId: row.user_id, patientId: row.patient_id };
    case 'doctor':
      return row.doctor_id === null
        ? { role: 'anon' }
        : { role: 'doctor', userId: row.user_id, doctorId: row.doctor_id };
    case 'receptionist':
      return row.clinic_id === null
        ? { role: 'anon' }
        : { role: 'receptionist', userId: row.user_id, clinicId: row.clinic_id };
    case 'manager':
      return { role: 'manager', userId: row.user_id };
    default:
      return { role: 'anon' };
  }
}
