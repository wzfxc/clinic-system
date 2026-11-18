/**
 * Waitlist cascade (docs/analysis/05, sections 3, 3a, 4; 00-decisions D4, R5). A freed time is offered
 * to the first eligible entry as a `held` appointment (`hold_kind = 'waitlist_offer'`) in the same
 * transaction that freed it, so the grid never shows the time as free. Each attempt runs inside its own
 * SAVEPOINT: a limit or constraint failure of one candidate skips that candidate and nothing else.
 */
import { randomUUID } from 'node:crypto';
import type { Clock } from '../clock.js';
import {
  MIN_LEAD_HOURS,
  PREP_BUFFER_MINUTES,
  WAITLIST_MAX_MISSED_OFFERS,
  WAITLIST_OFFER_TTL_MINUTES,
  WAITLIST_PAGE_SIZE,
} from '../rules.js';
import { APPOINTMENT_COLUMNS, toAppointment, type Appointment, type AppointmentRow } from './appointment.js';
import { advisoryLock } from './hold.js';
import type { FreedInterval } from './hooks.js';
import { onlineBookingBlockedUntil } from './online-block.js';
import { isWithinBookingWindow } from './slots.js';
import { loadClinicService, type ClinicService } from './slots-repo.js';
import { HOUR_MS, localDateOf, MINUTE_MS } from './time.js';
import { numberOf, pgErrorOf, type Tx } from './tx.js';

export const WAITLIST_OFFER_TEMPLATE = 'waitlist_offer';

/** Errors that mean "this candidate cannot have the time"; anything else aborts the whole transaction. */
const SKIPPABLE_SQLSTATES: ReadonlySet<string> = new Set(['CL001', 'CL002', '23P01', '23505', '23514', '23503']);
const SAVEPOINT = 'waitlist_offer_sp';

/** An offer must still be acceptable at its deadline, so the slot needs the booking lead time plus the offer TTL. */
const MIN_OFFER_LEAD_MS = MIN_LEAD_HOURS * HOUR_MS + WAITLIST_OFFER_TTL_MINUTES * MINUTE_MS;

interface CandidateRow {
  id: string;
  patient_id: string;
  service_id: string;
  priority: number;
  created_text: string;
}

interface Cursor {
  priority: number;
  createdText: string;
  id: number;
}

interface Candidate {
  entryId: number;
  patientId: number;
  serviceId: number;
}

async function loadPage(
  tx: Tx,
  interval: FreedInterval,
  localDate: string,
  chainId: string,
  cursor: Cursor | null,
): Promise<CandidateRow[]> {
  const { rows } = await tx.query<CandidateRow>(
    `SELECT e.id, e.patient_id, e.service_id, e.priority, e.created_at::text AS created_text
       FROM waitlist_entries e
      WHERE e.status = 'waiting' AND e.doctor_id = $1 AND e.clinic_id = $2
        AND e.date_from <= $3::date AND e.date_to >= $3::date
        AND e.patient_id <> $4
        AND NOT EXISTS (SELECT 1 FROM waitlist_offers o WHERE o.entry_id = e.id AND o.chain_id = $5)
        AND ($6::text IS NULL OR (-e.priority, e.created_at, e.id) > (-$7::int, $6::timestamptz, $8::bigint))
      ORDER BY e.priority DESC, e.created_at, e.id
      LIMIT ${WAITLIST_PAGE_SIZE}
        FOR UPDATE OF e SKIP LOCKED`,
    [
      interval.doctorId,
      interval.clinicId,
      localDate,
      interval.patientId,
      chainId,
      cursor?.createdText ?? null,
      cursor?.priority ?? null,
      cursor?.id ?? null,
    ],
  );
  return rows;
}

async function insertOffer(
  tx: Tx,
  now: Date,
  interval: FreedInterval,
  candidate: Candidate,
  service: ClinicService,
  chainId: string,
): Promise<number> {
  const endsAt = new Date(interval.start.getTime() + service.durationMinutes * MINUTE_MS);
  const blockedUntil = new Date(endsAt.getTime() + PREP_BUFFER_MINUTES * MINUTE_MS);
  const expiresAt = new Date(now.getTime() + WAITLIST_OFFER_TTL_MINUTES * MINUTE_MS);
  const held = await tx.query<{ id: string }>(
    `INSERT INTO appointments
       (clinic_id, doctor_id, patient_id, service_id, status, starts_at, ends_at, blocked_until,
        uses_ultrasound_room, price_minor, currency, hold_kind, hold_expires_at, waitlist_entry_id,
        created_at, updated_at)
     VALUES ($1,$2,$3,$4,'held',$5,$6,$7,$8,$9,$10,'waitlist_offer',$11,$12,$13,$13)
     RETURNING id`,
    [
      interval.clinicId,
      interval.doctorId,
      candidate.patientId,
      candidate.serviceId,
      interval.start,
      endsAt,
      blockedUntil,
      service.usesUltrasoundRoom,
      service.priceMinor,
      service.currency,
      expiresAt,
      candidate.entryId,
      now,
    ],
  );
  const appointmentId = held.rows[0]?.id;
  if (appointmentId === undefined) throw new Error('INSERT ... RETURNING produced no row');
  const offer = await tx.query<{ id: string }>(
    `INSERT INTO waitlist_offers (entry_id, appointment_id, chain_id, status, created_at, expires_at)
     VALUES ($1,$2,$3,'pending',$4,$5) RETURNING id`,
    [candidate.entryId, appointmentId, chainId, now, expiresAt],
  );
  const offerId = numberOf(offer.rows[0]?.id ?? 0);
  await tx.query(`UPDATE waitlist_entries SET status = 'offered' WHERE id = $1`, [candidate.entryId]);
  await queueWaitlistMail(tx, now, {
    dedupeKey: `${WAITLIST_OFFER_TEMPLATE}:${offerId}`,
    template: WAITLIST_OFFER_TEMPLATE,
    patientId: candidate.patientId,
    payload: {
      offerId,
      startsAt: interval.start.toISOString(),
      expiresAt: expiresAt.toISOString(),
      timezone: service.timezone,
    },
  });
  return offerId;
}

export interface WaitlistMail {
  dedupeKey: string;
  template: string;
  patientId: number;
  payload: Readonly<Record<string, unknown>>;
}

/** Outbox row in the caller's transaction; a patient without an email gets a `dead` row, as for sick leave. */
export async function queueWaitlistMail(tx: Tx, now: Date, mail: WaitlistMail): Promise<void> {
  await tx.query(
    `INSERT INTO email_outbox
       (dedupe_key, to_address, patient_id, template, payload, status, last_error, next_attempt_at, created_at)
     SELECT $1, p.email, p.id, $2, $3::jsonb,
            CASE WHEN p.email IS NULL THEN 'dead'::email_status ELSE 'pending'::email_status END,
            CASE WHEN p.email IS NULL THEN 'no_email' END, $4, $4
       FROM patients p WHERE p.id = $5
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [mail.dedupeKey, mail.template, JSON.stringify(mail.payload), now, mail.patientId],
  );
}

/** Eligibility that the page query cannot express; limits and overlaps are left to the DB constraints. */
async function isEligible(
  tx: Tx,
  now: Date,
  interval: FreedInterval,
  candidate: Candidate,
  service: ClinicService,
): Promise<boolean> {
  const blockedUntil = new Date(interval.start.getTime() + (service.durationMinutes + PREP_BUFFER_MINUTES) * MINUTE_MS);
  if (blockedUntil > interval.end) return false; // the service does not fit into the freed time
  if (interval.start.getTime() < now.getTime() + MIN_OFFER_LEAD_MS) return false;
  if (!isWithinBookingWindow(now, service.timezone, interval.start)) return false;
  return (await onlineBookingBlockedUntil(tx, now, candidate.patientId)) === null;
}

async function tryOffer(
  tx: Tx,
  now: Date,
  interval: FreedInterval,
  candidate: Candidate,
  chainId: string,
): Promise<number | null> {
  const service = await loadClinicService(tx, interval.clinicId, candidate.serviceId);
  if (service === null || !(await isEligible(tx, now, interval, candidate, service))) return null;
  if (service.usesUltrasoundRoom) await advisoryLock(tx, `room:${interval.clinicId}`);
  await tx.query(`SAVEPOINT ${SAVEPOINT}`);
  try {
    const offerId = await insertOffer(tx, now, interval, candidate, service, chainId);
    await tx.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    return offerId;
  } catch (err) {
    const code = pgErrorOf(err).code;
    if (code === undefined || !SKIPPABLE_SQLSTATES.has(code)) throw err;
    await tx.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
    await tx.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    return null;
  }
}

/**
 * Offers a freed time to the first eligible waiting entry, page by page, in the caller's transaction.
 * Returns the new offer id, or null when nobody could take it (the time stays free).
 */
export async function releaseSlot(
  tx: Tx,
  clock: Clock,
  interval: FreedInterval,
  chainId: string = randomUUID(),
): Promise<number | null> {
  const now = clock.now();
  const clinic = await tx.query<{ timezone: string }>(`SELECT timezone FROM clinics WHERE id = $1`, [
    interval.clinicId,
  ]);
  const timezone = clinic.rows[0]?.timezone;
  if (timezone === undefined) return null;
  const localDate = localDateOf(interval.start, timezone);

  await advisoryLock(tx, `doctor:${interval.doctorId}`);
  let cursor: Cursor | null = null;
  for (;;) {
    const page = await loadPage(tx, interval, localDate, chainId, cursor);
    for (const row of page) {
      const candidate = {
        entryId: numberOf(row.id),
        patientId: numberOf(row.patient_id),
        serviceId: numberOf(row.service_id),
      };
      const offerId = await tryOffer(tx, now, interval, candidate, chainId);
      if (offerId !== null) return offerId;
    }
    const last = page[page.length - 1];
    if (page.length < WAITLIST_PAGE_SIZE || last === undefined) return null;
    cursor = { priority: last.priority, createdText: last.created_text, id: numberOf(last.id) };
  }
}

export type OfferClosure = 'expired' | 'declined' | 'left';

export interface CloseOfferOptions {
  /** The sweeper skips offers someone else is working on; a patient's own action waits for the lock. */
  skipLocked: boolean;
  /** The sweeper closes only offers whose deadline has passed. */
  onlyDue: boolean;
}

const CANCEL_REASON: Readonly<Record<OfferClosure, string>> = {
  expired: 'offer_expired',
  declined: 'offer_declined',
  left: 'offer_declined',
};

async function updateEntryAfterClosure(tx: Tx, entryId: number, closure: OfferClosure): Promise<void> {
  if (closure === 'left') {
    await tx.query(`UPDATE waitlist_entries SET status = 'cancelled' WHERE id = $1`, [entryId]);
  } else if (closure === 'declined') {
    await tx.query(`UPDATE waitlist_entries SET status = 'waiting' WHERE id = $1`, [entryId]);
  } else {
    await tx.query(
      `UPDATE waitlist_entries
          SET missed_offers = missed_offers + 1,
              status = CASE WHEN missed_offers + 1 >= $2 THEN 'expired'::waitlist_entry_status
                            ELSE 'waiting'::waitlist_entry_status END
        WHERE id = $1`,
      [entryId, WAITLIST_MAX_MISSED_OFFERS],
    );
  }
}

/**
 * Ends a pending offer and hands the time to the next candidate in the same transaction: the held row
 * is cancelled and, if someone is next, a new held row takes its place before COMMIT.
 * Returns false when the offer is not pending (already handled) or is locked by someone else.
 */
export async function closeOffer(
  tx: Tx,
  clock: Clock,
  offerId: number,
  closure: OfferClosure,
  options: CloseOfferOptions,
): Promise<boolean> {
  const now = clock.now();
  const { rows } = await tx.query<{ entry_id: string; appointment_id: string; chain_id: string }>(
    `SELECT entry_id, appointment_id, chain_id FROM waitlist_offers
      WHERE id = $1 AND status = 'pending' AND (NOT $3::boolean OR expires_at <= $2)
        FOR UPDATE${options.skipLocked ? ' SKIP LOCKED' : ''}`,
    [offerId, now, options.onlyDue],
  );
  const offer = rows[0];
  if (!offer) return false;

  const cancelled = await tx.query<AppointmentRow>(
    `UPDATE appointments
        SET status = 'cancelled', cancel_reason = $2, hold_kind = NULL, hold_expires_at = NULL, updated_at = $3
      WHERE id = $1 AND status = 'held'
      RETURNING ${APPOINTMENT_COLUMNS}`,
    [offer.appointment_id, CANCEL_REASON[closure], now],
  );
  const row = cancelled.rows[0];
  const held: Appointment | undefined = row ? toAppointment(row) : undefined;
  await tx.query(`UPDATE waitlist_offers SET status = $2::waitlist_offer_status, resolved_at = $3 WHERE id = $1`, [
    offerId,
    closure === 'expired' ? 'expired' : 'declined',
    now,
  ]);
  await updateEntryAfterClosure(tx, numberOf(offer.entry_id), closure);
  if (held) {
    await releaseSlot(
      tx,
      clock,
      {
        doctorId: held.doctorId,
        clinicId: held.clinicId,
        serviceId: held.serviceId,
        patientId: held.patientId,
        usesUltrasoundRoom: held.usesUltrasoundRoom,
        start: held.startsAt,
        end: held.blockedUntil,
        reason: 'cancelled',
      },
      offer.chain_id,
    );
  }
  return true;
}
