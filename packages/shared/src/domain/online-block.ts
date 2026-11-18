/**
 * Online booking block, computed from history (00-decisions D5). Postgres is the source of truth:
 * the strikes are the `is_strike` rows the appointments history trigger writes (a no-show, or a
 * cancellation or reschedule at most 24 hours before the start), so there is nothing to keep in
 * sync. `patients.online_booking_blocked_until` is not read.
 */
import { BLOCK_DAYS, STRIKE_WINDOW_DAYS, STRIKES_TO_BLOCK } from '../rules.js';
import { DAY_MS } from './time.js';
import { numberOf, type Tx } from './tx.js';

/**
 * The end of the block if online booking is closed at `now`, otherwise null.
 * Two or more strikes in `[now - 90 days, now]` close it for 30 days from the latest strike.
 * The block ends exactly 30 days after that strike (the end instant itself is open again).
 */
export async function onlineBookingBlockedUntil(tx: Tx, now: Date, patientId: number): Promise<Date | null> {
  const windowStart = new Date(now.getTime() - STRIKE_WINDOW_DAYS * DAY_MS);
  const { rows } = await tx.query<{ strikes: string; last_strike_at: Date | null }>(
    `SELECT count(*) AS strikes, max(occurred_at) AS last_strike_at
       FROM appointment_events
      WHERE patient_id = $1 AND is_strike AND occurred_at >= $2 AND occurred_at <= $3`,
    [patientId, windowStart, now],
  );
  const row = rows[0];
  if (!row?.last_strike_at || numberOf(row.strikes) < STRIKES_TO_BLOCK) return null;
  const until = new Date(row.last_strike_at.getTime() + BLOCK_DAYS * DAY_MS);
  return until > now ? until : null;
}
