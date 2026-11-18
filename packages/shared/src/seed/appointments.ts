/** Appointment generator: packs each doctor's shift without overlaps, then adds cancelled bookings. Pure, no DB access. */
import { DateTime } from 'luxon';
import { type Rng, between, chance, pick } from './rng.js';
import { CLINICS, type DoctorSeed, SERVICES, type ServiceSeed, type ShiftWindow, priceMinor, shiftFor } from './catalog.js';

export const BUFFER_MINUTES = 5;
export const MAX_FUTURE_PER_PATIENT = 3;
const BOOK_PROBABILITY = 0.85;
const NO_SHOW_PROBABILITY = 0.12;
const CANCELLED_PER_ACTIVE = 0.8;
const PATIENT_ATTEMPTS = 6;
const SLOT_MINUTES = 15;
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;

export type SeedStatus = 'booked' | 'completed' | 'no_show' | 'cancelled';

export interface AppointmentRow {
  clinicId: number;
  doctorId: number;
  patientId: number;
  serviceId: number;
  status: SeedStatus;
  startsAt: Date;
  endsAt: Date;
  blockedUntil: Date;
  localDate: string;
  usesUltrasoundRoom: boolean;
  priceMinor: number;
  currency: string;
  cancelReason: string | null;
  createdAt: Date;
}

/** Database ids of the seeded entities, aligned with the catalog indexes. */
export interface SeedIds {
  clinicIds: number[];
  serviceIds: number[];
  doctorIds: number[];
  patientIds: number[];
}

export interface GenerateInput {
  rng: Rng;
  ids: SeedIds;
  doctors: readonly DoctorSeed[];
  now: Date;
  /** Local dates (YYYY-MM-DD) to generate, in order. */
  dates: readonly string[];
}

/** A booked interval: start to the end of the buffer, in epoch milliseconds. */
interface Interval {
  startMs: number;
  blockedMs: number;
}

interface GenState {
  readonly rng: Rng;
  readonly ids: SeedIds;
  readonly nowMs: number;
  readonly patientIntervals: Map<number, Interval[]>;
  /** `patient|doctor|date` keys of active bookings: one per patient, doctor and local day. */
  readonly patientDays: Set<string>;
  readonly futureCount: Map<number, number>;
  /** `clinic|date` to ultrasound-room intervals. */
  readonly rooms: Map<string, Interval[]>;
  readonly rows: AppointmentRow[];
}

/** Target of one slot: a service in a doctor's day, placed at a fixed instant. */
interface Placement {
  doctor: DoctorSeed;
  service: ServiceSeed;
  date: string;
  interval: Interval;
}

function overlaps(list: readonly Interval[], interval: Interval): boolean {
  return list.some((b) => interval.startMs < b.blockedMs && b.startMs < interval.blockedMs);
}

function minutesOf(hhmm: string): number {
  const [h = '0', m = '0'] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
}

function createdAtFor(rng: Rng, startMs: number, nowMs: number): Date {
  const daysBefore = between(rng, 1, 20);
  return new Date(Math.min(startMs - daysBefore * MS_PER_DAY, nowMs - 60 * MS_PER_MINUTE));
}

function toRow(state: GenState, placement: Placement, patientIndex: number, status: SeedStatus, cancelReason: string | null): AppointmentRow {
  const { doctor, service, interval, date } = placement;
  const clinic = CLINICS[doctor.clinicIndex];
  const serviceId = state.ids.serviceIds[SERVICES.indexOf(service)];
  if (!clinic || serviceId === undefined) throw new Error('catalog index out of range');
  const endMs = interval.blockedMs - BUFFER_MINUTES * MS_PER_MINUTE;
  return {
    clinicId: state.ids.clinicIds[doctor.clinicIndex] ?? 0,
    doctorId: state.ids.doctorIds[doctor.index] ?? 0,
    patientId: state.ids.patientIds[patientIndex] ?? 0,
    serviceId,
    status,
    startsAt: new Date(interval.startMs),
    endsAt: new Date(endMs),
    blockedUntil: new Date(interval.blockedMs),
    localDate: date,
    usesUltrasoundRoom: service.usesUltrasoundRoom,
    priceMinor: priceMinor(clinic, service),
    currency: clinic.currency,
    cancelReason,
    createdAt: createdAtFor(state.rng, interval.startMs, state.nowMs),
  };
}

/** Returns a patient index that may take this slot, or null after a few attempts. */
function findPatient(state: GenState, placement: Placement, future: boolean): number | null {
  const { doctor, date, interval } = placement;
  for (let attempt = 0; attempt < PATIENT_ATTEMPTS; attempt += 1) {
    const patient = between(state.rng, 0, state.ids.patientIds.length - 1);
    if (state.patientDays.has(`${patient}|${doctor.index}|${date}`)) continue;
    if (overlaps(state.patientIntervals.get(patient) ?? [], interval)) continue;
    if (future && (state.futureCount.get(patient) ?? 0) >= MAX_FUTURE_PER_PATIENT) continue;
    return patient;
  }
  return null;
}

function remember(state: GenState, patient: number, placement: Placement, future: boolean): void {
  state.patientDays.add(`${patient}|${placement.doctor.index}|${placement.date}`);
  state.patientIntervals.set(patient, [...(state.patientIntervals.get(patient) ?? []), placement.interval]);
  if (future) state.futureCount.set(patient, (state.futureCount.get(patient) ?? 0) + 1);
}

function roomKey(placement: Placement): string {
  return `${placement.doctor.clinicIndex}|${placement.date}`;
}

function roomFree(state: GenState, placement: Placement): boolean {
  return !overlaps(state.rooms.get(roomKey(placement)) ?? [], placement.interval);
}

function rememberRoom(state: GenState, placement: Placement): void {
  const key = roomKey(placement);
  state.rooms.set(key, [...(state.rooms.get(key) ?? []), placement.interval]);
}

/** Tries to book one slot; returns true when an active booking was placed. */
function tryBook(state: GenState, placement: Placement): boolean {
  const { service, interval } = placement;
  if (service.usesUltrasoundRoom && !roomFree(state, placement)) return false;
  const future = interval.startMs >= state.nowMs;
  const patient = findPatient(state, placement, future);
  if (patient === null) return false;
  const status: SeedStatus = future ? 'booked' : chance(state.rng, NO_SHOW_PROBABILITY) ? 'no_show' : 'completed';
  remember(state, patient, placement, future);
  if (service.usesUltrasoundRoom) rememberRoom(state, placement);
  state.rows.push(toRow(state, placement, patient, status, null));
  return true;
}

function servicesOf(doctor: DoctorSeed): ServiceSeed[] {
  return doctor.serviceIndexes.map((i) => SERVICES[i]).filter((s): s is ServiceSeed => s !== undefined);
}

/** Starts are on the 15-minute grid, so the cursor rounds up after each buffer. */
function nextSlotAfter(minute: number): number {
  return Math.ceil(minute / SLOT_MINUTES) * SLOT_MINUTES;
}

/** Packs one doctor's shift from the start, slot by slot, and returns the number of active bookings made. */
function packShift(state: GenState, doctor: DoctorSeed, date: string, shift: ShiftWindow, base: DateTime): number {
  const endMin = minutesOf(shift.end);
  const breakStart = shift.breakStart ? minutesOf(shift.breakStart) : null;
  const breakEnd = shift.breakEnd ? minutesOf(shift.breakEnd) : null;
  const services = servicesOf(doctor);
  let cursor = minutesOf(shift.start);
  let booked = 0;
  while (cursor + SLOT_MINUTES <= endMin) {
    if (breakStart !== null && breakEnd !== null && cursor >= breakStart && cursor < breakEnd) {
      cursor = breakEnd;
      continue;
    }
    const limit = breakStart !== null && cursor < breakStart ? breakStart : endMin;
    const fits = services.filter((s) => s.durationMinutes <= limit - cursor);
    if (fits.length === 0 || !chance(state.rng, BOOK_PROBABILITY)) {
      cursor += SLOT_MINUTES;
      continue;
    }
    const service = pick(state.rng, fits);
    const startMs = base.plus({ minutes: cursor }).toMillis();
    const interval: Interval = { startMs, blockedMs: startMs + (service.durationMinutes + BUFFER_MINUTES) * MS_PER_MINUTE };
    if (!tryBook(state, { doctor, service, date, interval })) {
      cursor += SLOT_MINUTES;
      continue;
    }
    booked += 1;
    cursor = nextSlotAfter(cursor + service.durationMinutes + BUFFER_MINUTES);
  }
  return booked;
}

/** Cancelled bookings neither occupy time nor count toward limits, so they are placed freely in the day. */
function addCancelled(state: GenState, doctor: DoctorSeed, date: string, shift: ShiftWindow, base: DateTime, count: number): void {
  const services = servicesOf(doctor);
  const startMin = minutesOf(shift.start);
  const slots = Math.floor((minutesOf(shift.end) - startMin - SLOT_MINUTES) / SLOT_MINUTES);
  for (let n = 0; n < count; n += 1) {
    const service = pick(state.rng, services);
    const startMs = base.plus({ minutes: startMin + SLOT_MINUTES * between(state.rng, 0, slots) }).toMillis();
    const interval: Interval = { startMs, blockedMs: startMs + (service.durationMinutes + BUFFER_MINUTES) * MS_PER_MINUTE };
    const patient = between(state.rng, 0, state.ids.patientIds.length - 1);
    state.rows.push(toRow(state, { doctor, service, date, interval }, patient, 'cancelled', 'patient'));
  }
}

/** Generates every appointment row for the window. */
export function generateAppointments(input: GenerateInput): AppointmentRow[] {
  const state: GenState = {
    rng: input.rng,
    ids: input.ids,
    nowMs: input.now.getTime(),
    patientIntervals: new Map(),
    patientDays: new Set(),
    futureCount: new Map(),
    rooms: new Map(),
    rows: [],
  };
  for (const date of input.dates) {
    for (const doctor of input.doctors) {
      const shift = shiftFor(doctor, date);
      if (shift === null) continue;
      const zone = CLINICS[doctor.clinicIndex]?.timezone ?? 'UTC';
      const base = DateTime.fromISO(`${date}T00:00`, { zone });
      const booked = packShift(state, doctor, date, shift, base);
      addCancelled(state, doctor, date, shift, base, Math.round(booked * CANCELLED_PER_ACTIVE));
    }
  }
  return state.rows;
}
