/** Waitlist entry points for api and worker: one transaction per call, retried on 40P01/40001. */
import type { Pool } from 'pg';
import type { Clock } from '../clock.js';
import { translateDbError, type Appointment } from './appointment.js';
import { BookingError, pgErrorOf, runInTransaction, type Tx } from './tx.js';
import { closeOffer } from './waitlist-cascade.js';
import {
  acceptOffer,
  declineOffer,
  joinWaitlist,
  leaveWaitlist,
  type AcceptInput,
  type DeclineInput,
  type JoinInput,
  type LeaveInput,
} from './waitlist.js';

const OFFER_SWEEP_BATCH = 50;

export class WaitlistService {
  constructor(
    private readonly pool: Pool,
    private readonly clock: Clock,
  ) {}

  join(input: JoinInput): Promise<number> {
    return this.run((tx, clock) => joinWaitlist(tx, clock, input));
  }

  leave(input: LeaveInput): Promise<void> {
    return this.run((tx, clock) => leaveWaitlist(tx, clock, input));
  }

  /** The appointment; a stored or fresh refusal is thrown after COMMIT, as for an ordinary confirmation. */
  async accept(input: AcceptInput): Promise<Appointment> {
    const outcome = await this.run((tx, clock) => acceptOffer(tx, clock, input));
    if (!outcome.ok) throw outcome.error;
    return outcome.appointment;
  }

  decline(input: DeclineInput): Promise<void> {
    return this.run((tx, clock) => declineOffer(tx, clock, input));
  }

  /** Passes every overdue offer to the next candidate; safe in several copies at once. Returns how many it closed. */
  async processDueOffers(limit: number = OFFER_SWEEP_BATCH): Promise<number> {
    let closed = 0;
    for (;;) {
      const due = await this.pool.query<{ id: string }>(
        `SELECT id FROM waitlist_offers WHERE status = 'pending' AND expires_at <= $1 ORDER BY expires_at, id LIMIT $2`,
        [this.clock.now(), limit],
      );
      let handled = 0;
      for (const row of due.rows) {
        try {
          const done = await this.run((tx, clock) =>
            closeOffer(tx, clock, Number(row.id), 'expired', { skipLocked: true, onlyDue: true }),
          );
          if (done) handled += 1;
        } catch (err) {
          // A deadlock victim is retried by the next sweep; one busy offer must not stop the rest.
          if (!(err instanceof BookingError && err.code === 'CONFLICT_RETRY')) throw err;
        }
      }
      closed += handled;
      if (handled === 0 || due.rows.length < limit) return closed;
    }
  }

  private async run<T>(fn: (tx: Tx, clock: Clock) => Promise<T>): Promise<T> {
    try {
      return await runInTransaction(this.pool, this.clock, fn);
    } catch (err) {
      const retryable = ['40P01', '40001'].includes(pgErrorOf(err).code ?? '');
      throw translateDbError(err) ?? (retryable ? new BookingError('CONFLICT_RETRY') : err);
    }
  }
}
