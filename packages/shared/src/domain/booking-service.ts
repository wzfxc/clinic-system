/**
 * Booking entry points for api and worker: each call is one transaction with the injected
 * Clock, retried on 40P01/40001, with constraint failures translated to registry codes.
 * No framework dependencies.
 */
import type { Pool } from 'pg';
import type { Clock } from '../clock.js';
import { translateDbError, type Appointment } from './appointment.js';
import { confirmAppointment, type ConfirmInput } from './confirm.js';
import { holdAppointment, type HoldInput } from './hold.js';
import type { FreeSlot } from './slots.js';
import { loadFreeSlots, type FreeSlotsRequest } from './slots-repo.js';
import { BookingError, pgErrorOf, runInTransaction, type Tx } from './tx.js';

export class BookingService {
  constructor(
    private readonly pool: Pool,
    private readonly clock: Clock,
  ) {}

  freeSlots(request: FreeSlotsRequest): Promise<FreeSlot[]> {
    return this.run((tx, clock) => loadFreeSlots(tx, clock, request));
  }

  hold(input: HoldInput): Promise<Appointment> {
    return this.run((tx, clock) => holdAppointment(tx, clock, input));
  }

  /** Returns the appointment; a stored or fresh refusal is thrown as BookingError after COMMIT. */
  async confirm(input: ConfirmInput): Promise<Appointment> {
    const outcome = await this.run((tx, clock) => confirmAppointment(tx, clock, input));
    if (!outcome.ok) throw outcome.error;
    return outcome.appointment;
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
