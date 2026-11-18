/**
 * Waitlist against a real Postgres (docs/analysis/05 tests; acceptance 8, invariant 7): the cascade in the
 * cancelling transaction, expiry through the sweeper, the grid never showing an offered time, one seat
 * never offered twice, leaving during an offer, sick-leave priority.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FixedClock } from '../clock.js';
import { createTestDb, type TestDb } from '../db/test-db.js';
import { seedDoctor, seedPatient, seedWorld, type World } from '../db/test-fixtures.js';
import { WAITLIST_OFFER_TTL_MINUTES } from '../rules.js';
import type { Appointment } from './appointment.js';
import { BookingService } from './booking-service.js';
import { MINUTE_MS, zonedInstant } from './time.js';
import { BookingError } from './tx.js';
import { createWaitlistHooks } from './waitlist.js';
import { WaitlistService } from './waitlist-service.js';

/** 11:00 in Kyiv on Monday 1 June 2026. */
const NOW = new Date('2026-06-01T08:00:00Z');
const OFFER_MS = WAITLIST_OFFER_TTL_MINUTES * MINUTE_MS;

let db: TestDb;
let svc: BookingService;
let wl: WaitlistService;
const clock = new FixedClock(NOW);

beforeAll(async () => {
  db = await createTestDb();
  svc = new BookingService(db.pool, clock, createWaitlistHooks());
  wl = new WaitlistService(db.pool, clock);
}, 60_000);
afterAll(async () => {
  await db.close();
});
beforeEach(async () => {
  clock.set(NOW);
  await db.reset();
});

const SLOT_DATE = '2026-06-05';
const slotAt = zonedInstant('Europe/Kyiv', SLOT_DATE, '10:00');

interface Setup {
  w: World;
  doctorId: number;
}

async function setup(): Promise<Setup> {
  const w = await seedWorld(db.pool);
  return { w, doctorId: await seedDoctor(db.pool, w) };
}

async function book(s: Setup, patientId: number, startsAt: Date): Promise<Appointment> {
  const held = await svc.hold({
    patientId,
    doctorId: s.doctorId,
    clinicId: s.w.clinicId,
    serviceId: s.w.serviceId,
    startsAt,
    channel: 'online',
  });
  return svc.confirm({ appointmentId: held.id, patientId, idempotencyKey: randomUUID() });
}

async function join(s: Setup, patientId: number, dateFrom = '2026-06-04', dateTo = '2026-06-10'): Promise<number> {
  return wl.join({
    patientId,
    doctorId: s.doctorId,
    clinicId: s.w.clinicId,
    serviceId: s.w.serviceId,
    dateFrom,
    dateTo,
    channel: 'online',
  });
}

const cancel = (appointment: Appointment) =>
  svc.cancel({
    appointmentId: appointment.id,
    actor: { role: 'patient', userId: 1000 + appointment.patientId, patientId: appointment.patientId },
    reason: 'plans changed',
  });

/** The patient holding a live offer for the slot, or null. */
async function offeredTo(startsAt: Date): Promise<number | null> {
  const { rows } = await db.pool.query<{ patient_id: string }>(
    `SELECT patient_id FROM appointments WHERE starts_at = $1 AND status = 'held' AND hold_kind = 'waitlist_offer'`,
    [startsAt],
  );
  if (rows.length > 1) throw new Error('one seat offered to several patients');
  return rows[0] ? Number(rows[0].patient_id) : null;
}

const slotIsFree = async (s: Setup): Promise<boolean> =>
  (await svc.freeSlots({ clinicId: s.w.clinicId, serviceId: s.w.serviceId, doctorId: s.doctorId, days: 14 })).some(
    (f) => f.startAt.getTime() === slotAt.getTime(),
  );

const offerIdOf = async (patientId: number): Promise<number> => {
  const { rows } = await db.pool.query<{ id: string }>(
    `SELECT o.id FROM waitlist_offers o JOIN waitlist_entries e ON e.id = o.entry_id
      WHERE e.patient_id = $1 AND o.status = 'pending'`,
    [patientId],
  );
  if (!rows[0]) throw new Error(`no pending offer for ${patientId}`);
  return Number(rows[0].id);
};

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (err) {
    return err instanceof BookingError ? err.code : `RAW:${String(err)}`;
  }
}

describe('waitlist cascade (acceptance 8)', () => {
  it('passes the time A -> B -> C on silence, never showing it free, and C accepts', async () => {
    const s = await setup();
    const owner = await seedPatient(db.pool, 0);
    const [a, b, c] = [await seedPatient(db.pool, 1), await seedPatient(db.pool, 2), await seedPatient(db.pool, 3)];
    const visit = await book(s, owner, slotAt);
    for (const p of [a, b, c]) {
      await join(s, p);
      clock.advance(1000); // distinct created_at, queue order A, B, C
    }

    // A reader polls the grid for the whole duration of the cancel; it must never see the slot.
    let stop = false;
    let sawFree = false;
    const reader = (async () => {
      while (!stop) if (await slotIsFree(s)) sawFree = true;
    })();
    await cancel(visit);
    stop = true;
    await reader;

    expect(sawFree).toBe(false);
    expect(await offeredTo(slotAt)).toBe(a);
    expect(await slotIsFree(s)).toBe(false);

    clock.advance(OFFER_MS);
    expect(await slotIsFree(s)).toBe(false); // expired but not yet swept: still held (R2)
    expect(await wl.processDueOffers()).toBe(1);
    expect(await offeredTo(slotAt)).toBe(b);
    expect(await slotIsFree(s)).toBe(false);

    clock.advance(OFFER_MS);
    await wl.processDueOffers();
    expect(await offeredTo(slotAt)).toBe(c);

    const booked = await wl.accept({ offerId: await offerIdOf(c), patientId: c, idempotencyKey: randomUUID() });
    expect(booked.status).toBe('booked');
    expect(booked.patientId).toBe(c);
    const { rows } = await db.pool.query<{ status: string; missed_offers: number }>(
      `SELECT status, missed_offers FROM waitlist_entries WHERE patient_id = $1`,
      [a],
    );
    expect(rows[0]).toEqual({ status: 'waiting', missed_offers: 1 });
    const mail = await db.pool.query(`SELECT 1 FROM email_outbox WHERE template = 'waitlist_confirmed'`);
    expect(mail.rowCount).toBe(1);
  });

  it('rejects acceptance after the deadline even before the sweeper ran, and replays with the same key', async () => {
    const s = await setup();
    const [owner, a] = [await seedPatient(db.pool, 0), await seedPatient(db.pool, 1)];
    const visit = await book(s, owner, slotAt);
    await join(s, a);
    await cancel(visit);
    const offerId = await offerIdOf(a);

    const key = randomUUID();
    const first = await wl.accept({ offerId, patientId: a, idempotencyKey: key });
    const again = await wl.accept({ offerId, patientId: a, idempotencyKey: key });
    expect(again.id).toBe(first.id);

    await db.reset();
    clock.set(NOW);
    const s2 = await setup();
    const [o2, a2] = [await seedPatient(db.pool, 0), await seedPatient(db.pool, 1)];
    const v2 = await book(s2, o2, slotAt);
    await join(s2, a2);
    await cancel(v2);
    clock.advance(OFFER_MS);
    expect(await codeOf(wl.accept({ offerId: await offerIdOf(a2), patientId: a2, idempotencyKey: randomUUID() }))).toBe(
      'OFFER_EXPIRED',
    );
  });

  it('refuses another patient the offer', async () => {
    const s = await setup();
    const [owner, a, other] = [await seedPatient(db.pool, 0), await seedPatient(db.pool, 1), await seedPatient(db.pool, 2)];
    const visit = await book(s, owner, slotAt);
    await join(s, a);
    await cancel(visit);
    expect(
      await codeOf(wl.accept({ offerId: await offerIdOf(a), patientId: other, idempotencyKey: randomUUID() })),
    ).toBe('OFFER_NOT_FOUND');
  });

  it('offers one seat to one patient even with concurrent sweepers', async () => {
    const s = await setup();
    const owner = await seedPatient(db.pool, 0);
    const queue = [await seedPatient(db.pool, 1), await seedPatient(db.pool, 2), await seedPatient(db.pool, 3)];
    const visit = await book(s, owner, slotAt);
    for (const p of queue) {
      await join(s, p);
      clock.advance(1000);
    }
    await cancel(visit);
    clock.advance(OFFER_MS);
    await Promise.all([wl.processDueOffers(), wl.processDueOffers(), wl.processDueOffers()]);

    expect(await offeredTo(slotAt)).toBe(queue[1]); // exactly one step along the queue, one live held row
    const mails = await db.pool.query(`SELECT 1 FROM email_outbox WHERE template = 'waitlist_offer'`);
    expect(mails.rowCount).toBe(2);
  });

  it('passes the time on when the candidate leaves the list during the offer', async () => {
    const s = await setup();
    const [owner, a, b] = [await seedPatient(db.pool, 0), await seedPatient(db.pool, 1), await seedPatient(db.pool, 2)];
    const visit = await book(s, owner, slotAt);
    const entryA = await join(s, a);
    clock.advance(1000);
    await join(s, b);
    await cancel(visit);
    expect(await offeredTo(slotAt)).toBe(a);

    await wl.leave({ entryId: entryA, patientId: a });
    expect(await offeredTo(slotAt)).toBe(b);
    const { rows } = await db.pool.query<{ status: string }>(`SELECT status FROM waitlist_entries WHERE id = $1`, [entryA]);
    expect(rows[0]?.status).toBe('cancelled');
    expect(await slotIsFree(s)).toBe(false);
  });

  it('frees the slot when the last candidate declines', async () => {
    const s = await setup();
    const [owner, a] = [await seedPatient(db.pool, 0), await seedPatient(db.pool, 1)];
    const visit = await book(s, owner, slotAt);
    await join(s, a);
    await cancel(visit);
    await wl.decline({ offerId: await offerIdOf(a), patientId: a });
    expect(await offeredTo(slotAt)).toBeNull();
    expect(await slotIsFree(s)).toBe(true);
  });

  it('skips a candidate who hits the future-visit limit and keeps the cancellation', async () => {
    const s = await setup();
    const [owner, a, b] = [await seedPatient(db.pool, 0), await seedPatient(db.pool, 1), await seedPatient(db.pool, 2)];
    const visit = await book(s, owner, slotAt);
    await join(s, a);
    clock.advance(1000);
    await join(s, b);
    for (const day of ['2026-06-08', '2026-06-09', '2026-06-10']) {
      await book(s, a, zonedInstant('Europe/Kyiv', day, '12:00'));
    }
    await cancel(visit);
    expect(await offeredTo(slotAt)).toBe(b);
    const { rows } = await db.pool.query<{ status: string }>(`SELECT status FROM appointments WHERE id = $1`, [visit.id]);
    expect(rows[0]?.status).toBe('cancelled');
  });

  it('gives sick-leave patients priority over an earlier ordinary entry', async () => {
    const s = await setup();
    const [sick, early, owner] = [await seedPatient(db.pool, 1), await seedPatient(db.pool, 2), await seedPatient(db.pool, 3)];
    await book(s, sick, zonedInstant('Europe/Kyiv', '2026-06-03', '10:00'));
    const visit = await book(s, owner, slotAt);
    await join(s, early, '2026-06-04', '2026-06-10');
    clock.advance(1000);

    const actor = { role: 'receptionist' as const, userId: 900, clinicId: s.w.clinicId };
    const args = { doctorId: s.doctorId, clinicId: s.w.clinicId, date: '2026-06-03', actor };
    expect((await svc.markSickLeave(args)).applied).toBe(true);
    expect((await svc.markSickLeave(args)).applied).toBe(false);
    const entries = await db.pool.query(`SELECT 1 FROM waitlist_entries WHERE patient_id = $1`, [sick]);
    expect(entries.rowCount).toBe(1);

    await cancel(visit);
    expect(await offeredTo(slotAt)).toBe(sick);
  });
});
