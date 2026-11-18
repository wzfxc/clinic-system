/**
 * Waitlist operations (docs/analysis/05, sections 5-7). Lock order: entry or patient first, then the
 * offer row, then the appointment row; the cascade takes the doctor advisory lock after them.
 */
import type { Clock } from '../clock.js';
import { applyActor, lockPatient, type Actor } from './appointment.js';
import { confirmAppointment, type ConfirmOutcome } from './confirm.js';
import { DEFAULT_HOOKS, type DomainHooks } from './hooks.js';
import { onlineBookingBlockedUntil } from './online-block.js';
import { addCalendarDays, localDateOf } from './time.js';
import { BookingError, numberOf, pgErrorOf, type Tx } from './tx.js';
import { closeOffer, queueWaitlistMail, releaseSlot } from './waitlist-cascade.js';

export const WAITLIST_CONFIRMED_TEMPLATE = 'waitlist_confirmed';

/** Hooks that run the waitlist cascade whenever time is freed (sick leave frees time that no longer exists). */
export function createWaitlistHooks(): DomainHooks {
  return {
    ...DEFAULT_HOOKS,
    onSlotsFreed: async (tx, intervals, clock) => {
      for (const interval of intervals) {
        if (interval.reason !== 'sick_leave') await releaseSlot(tx, clock, interval);
      }
    },
  };
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface JoinInput {
  patientId: number;
  doctorId: number;
  clinicId: number;
  serviceId: number;
  /** Clinic calendar dates, YYYY-MM-DD. */
  dateFrom: string;
  dateTo: string;
  channel: 'online' | 'front_desk';
  actor?: Actor;
}

export async function joinWaitlist(tx: Tx, clock: Clock, input: JoinInput): Promise<number> {
  const now = clock.now();
  if (!DATE_PATTERN.test(input.dateFrom) || !DATE_PATTERN.test(input.dateTo) || input.dateFrom > input.dateTo) {
    throw new BookingError('VALIDATION_FAILED', 'invalid date range');
  }
  await applyActor(tx, input.actor);
  await lockPatient(tx, input.patientId);
  const clinic = await tx.query<{ timezone: string }>(`SELECT timezone FROM clinics WHERE id = $1`, [input.clinicId]);
  const timezone = clinic.rows[0]?.timezone;
  if (timezone === undefined) throw new BookingError('NOT_FOUND', 'clinic not found');
  if (input.dateTo < localDateOf(now, timezone)) throw new BookingError('VALIDATION_FAILED', 'the range is in the past');
  if (input.channel === 'online' && (await onlineBookingBlockedUntil(tx, now, input.patientId)) !== null) {
    throw new BookingError('ONLINE_BOOKING_BLOCKED');
  }
  try {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO waitlist_entries (patient_id, doctor_id, clinic_id, service_id, date_from, date_to, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [input.patientId, input.doctorId, input.clinicId, input.serviceId, input.dateFrom, input.dateTo, now],
    );
    return numberOf(rows[0]?.id ?? 0);
  } catch (err) {
    const { code, constraint } = pgErrorOf(err);
    if (code === '23505') throw new BookingError('ALREADY_ON_WAITLIST');
    if (code === '23503' && constraint?.startsWith('waitlist_entries_doctor')) {
      throw new BookingError('SERVICE_NOT_PROVIDED');
    }
    throw err;
  }
}

export interface LeaveInput {
  entryId: number;
  patientId: number;
}

/** Leaving during an offer cancels the offer like a decline and passes the time on. */
export async function leaveWaitlist(tx: Tx, clock: Clock, input: LeaveInput): Promise<void> {
  // Entry first, then patient: the cascade locks in the same order (entry, then the patient trigger).
  const { rows } = await tx.query<{ patient_id: string; status: string }>(
    `SELECT patient_id, status FROM waitlist_entries WHERE id = $1 FOR UPDATE`,
    [input.entryId],
  );
  const entry = rows[0];
  if (!entry || numberOf(entry.patient_id) !== input.patientId) throw new BookingError('NOT_FOUND');
  if (entry.status === 'offered') {
    const offer = await tx.query<{ id: string }>(
      `SELECT id FROM waitlist_offers WHERE entry_id = $1 AND status = 'pending'`,
      [input.entryId],
    );
    const offerId = offer.rows[0]?.id;
    if (offerId !== undefined) {
      await closeOffer(tx, clock, numberOf(offerId), 'left', { skipLocked: false, onlyDue: false });
      return;
    }
  }
  if (entry.status === 'waiting' || entry.status === 'offered') {
    await tx.query(`UPDATE waitlist_entries SET status = 'cancelled' WHERE id = $1`, [input.entryId]);
  }
}

interface OfferRow {
  status: string;
  expires_at: Date;
  appointment_id: string;
  entry_id: string;
  patient_id: string;
  starts_at: Date;
  timezone: string;
}

/** Reads the offer with its owner; a missing or foreign offer is the same OFFER_NOT_FOUND. */
async function loadOwnOffer(tx: Tx, offerId: number, patientId: number, lock: boolean): Promise<OfferRow> {
  const { rows } = await tx.query<OfferRow>(
    `SELECT o.status, o.expires_at, o.appointment_id, o.entry_id, e.patient_id, a.starts_at, c.timezone
       FROM waitlist_offers o
       JOIN waitlist_entries e ON e.id = o.entry_id
       JOIN appointments a ON a.id = o.appointment_id
       JOIN clinics c ON c.id = a.clinic_id
      WHERE o.id = $1${lock ? ' FOR UPDATE OF o' : ''}`,
    [offerId],
  );
  const row = rows[0];
  if (!row || numberOf(row.patient_id) !== patientId) throw new BookingError('OFFER_NOT_FOUND');
  return row;
}

export interface AcceptInput {
  offerId: number;
  patientId: number;
  idempotencyKey: string;
  actor?: Actor;
}

/** Same rules as an ordinary confirmation (limits, hold liveness, idempotency); expiry is judged by the Clock. */
export async function acceptOffer(tx: Tx, clock: Clock, input: AcceptInput): Promise<ConfirmOutcome> {
  const now = clock.now();
  await loadOwnOffer(tx, input.offerId, input.patientId, false);
  await applyActor(tx, input.actor);
  await lockPatient(tx, input.patientId);
  const offer = await loadOwnOffer(tx, input.offerId, input.patientId, true);
  if (offer.status === 'expired' || (offer.status === 'pending' && offer.expires_at <= now)) {
    throw new BookingError('OFFER_EXPIRED');
  }
  if (offer.status === 'declined') throw new BookingError('OFFER_NOT_FOUND');

  const outcome = await confirmAppointment(tx, clock, {
    appointmentId: numberOf(offer.appointment_id),
    patientId: input.patientId,
    idempotencyKey: input.idempotencyKey,
    actor: input.actor,
  });
  if (outcome.ok && offer.status === 'pending') {
    await tx.query(`UPDATE waitlist_offers SET status = 'accepted', resolved_at = $2 WHERE id = $1`, [
      input.offerId,
      now,
    ]);
    await tx.query(`UPDATE waitlist_entries SET status = 'fulfilled' WHERE id = $1`, [offer.entry_id]);
    await queueWaitlistMail(tx, now, {
      dedupeKey: `${WAITLIST_CONFIRMED_TEMPLATE}:${input.offerId}`,
      template: WAITLIST_CONFIRMED_TEMPLATE,
      patientId: input.patientId,
      payload: { offerId: input.offerId, startsAt: offer.starts_at.toISOString(), timezone: offer.timezone },
    });
  }
  return outcome;
}

export interface DeclineInput {
  offerId: number;
  patientId: number;
}

export async function declineOffer(tx: Tx, clock: Clock, input: DeclineInput): Promise<void> {
  await loadOwnOffer(tx, input.offerId, input.patientId, false);
  await lockPatient(tx, input.patientId);
  const offer = await loadOwnOffer(tx, input.offerId, input.patientId, true);
  if (offer.status === 'expired' || (offer.status === 'pending' && offer.expires_at <= clock.now())) {
    throw new BookingError('OFFER_EXPIRED');
  }
  if (offer.status !== 'pending') throw new BookingError('OFFER_NOT_FOUND');
  await closeOffer(tx, clock, input.offerId, 'declined', { skipLocked: false, onlyDue: false });
}

export interface SickLeaveEntry {
  patientId: number;
  serviceId: number;
}

/**
 * Priority entries for patients whose visit sick leave cancelled (05, section 6): a new entry for the
 * doctor and service over the next 14 days (never past the 60-day window), or the existing one raised
 * to priority 1. A repeat finds the same rows and changes nothing.
 */
export async function queuePriorityEntries(
  tx: Tx,
  now: Date,
  clinicId: number,
  doctorId: number,
  sickDate: string,
  timezone: string,
  patients: readonly SickLeaveEntry[],
  sourceIds: readonly number[],
): Promise<void> {
  if (patients.length === 0) return;
  const dateFrom = addCalendarDays(sickDate, 1);
  const horizon = addCalendarDays(localDateOf(now, timezone), 60);
  const planned = addCalendarDays(sickDate, 14);
  const capped = planned < horizon ? planned : horizon;
  const dateTo = capped < dateFrom ? dateFrom : capped;
  for (const [i, p] of patients.entries()) {
    await tx.query(
      `INSERT INTO waitlist_entries
         (patient_id, doctor_id, clinic_id, service_id, date_from, date_to, priority, priority_reason,
          source_appointment_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,1,'sick_leave',$7,$8)
       ON CONFLICT (patient_id, doctor_id, service_id) WHERE status IN ('waiting','offered')
       DO UPDATE SET priority = 1, priority_reason = 'sick_leave'`,
      [p.patientId, doctorId, clinicId, p.serviceId, dateFrom, dateTo, sourceIds[i] ?? null, now],
    );
  }
}
