/** Appointment record, shared SQL fragments and database-error translation for the booking flow. */
import type { appointmentStatus } from '../db/schema.js';
import { BookingError, numberOf, pgErrorOf, type Tx } from './tx.js';

export type AppointmentStatus = (typeof appointmentStatus.enumValues)[number];
export type HoldKind = 'checkout' | 'waitlist_offer';

/** `online` is a patient booking through the app; `front_desk` is a registrar acting by phone. */
export type BookingChannel = 'online' | 'front_desk';

/** Written to app.actor_id / app.actor_role so the history trigger records who acted. */
export interface Actor {
  userId: number;
  role: string;
}

export interface Appointment {
  id: number;
  clinicId: number;
  doctorId: number;
  patientId: number;
  serviceId: number;
  status: AppointmentStatus;
  startsAt: Date;
  endsAt: Date;
  blockedUntil: Date;
  localDate: string;
  usesUltrasoundRoom: boolean;
  priceMinor: number;
  currency: string;
  holdKind: HoldKind | null;
  holdExpiresAt: Date | null;
}

export const APPOINTMENT_COLUMNS = `id, clinic_id, doctor_id, patient_id, service_id, status, starts_at, ends_at,
  blocked_until, local_date::text AS local_date, uses_ultrasound_room, price_minor, currency, hold_kind, hold_expires_at`;

export interface AppointmentRow {
  id: string;
  clinic_id: string;
  doctor_id: string;
  patient_id: string;
  service_id: string;
  status: AppointmentStatus;
  starts_at: Date;
  ends_at: Date;
  blocked_until: Date;
  local_date: string;
  uses_ultrasound_room: boolean;
  price_minor: string;
  currency: string;
  hold_kind: HoldKind | null;
  hold_expires_at: Date | null;
}

export function toAppointment(row: AppointmentRow): Appointment {
  return {
    id: numberOf(row.id),
    clinicId: numberOf(row.clinic_id),
    doctorId: numberOf(row.doctor_id),
    patientId: numberOf(row.patient_id),
    serviceId: numberOf(row.service_id),
    status: row.status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    blockedUntil: row.blocked_until,
    localDate: row.local_date,
    usesUltrasoundRoom: row.uses_ultrasound_room,
    priceMinor: numberOf(row.price_minor),
    currency: row.currency,
    holdKind: row.hold_kind,
    holdExpiresAt: row.hold_expires_at,
  };
}

export async function applyActor(tx: Tx, actor: Actor | undefined): Promise<void> {
  if (actor === undefined) return;
  await tx.query(`SELECT set_config('app.actor_id', $1, true), set_config('app.actor_role', $2, true)`, [
    String(actor.userId),
    actor.role,
  ]);
}

export interface LockedPatient {
  id: number;
  onlineBookingBlockedUntil: Date | null;
}

/** First lock of every booking transaction (lock order: patient, doctor, ultrasound room). */
export async function lockPatient(tx: Tx, patientId: number): Promise<LockedPatient> {
  const { rows } = await tx.query<{ id: string; online_booking_blocked_until: Date | null }>(
    `SELECT id, online_booking_blocked_until FROM patients WHERE id = $1 FOR UPDATE`,
    [patientId],
  );
  const row = rows[0];
  if (!row) throw new BookingError('NOT_FOUND', `patient ${patientId} not found`);
  return { id: numberOf(row.id), onlineBookingBlockedUntil: row.online_booking_blocked_until };
}

const CONSTRAINT_TO_CODE: Readonly<Record<string, BookingError['code']>> = {
  appt_doctor_no_overlap: 'SLOT_TAKEN',
  appt_ultrasound_no_overlap: 'ROOM_TAKEN',
  appt_patient_no_overlap: 'PATIENT_TIME_CONFLICT',
  appt_patient_doctor_day_uq: 'DOCTOR_DAILY_LIMIT',
};

/** Maps the constraint and trigger failures that mean "business rule said no" to registry codes. */
export function translateDbError(err: unknown): BookingError | null {
  if (err instanceof BookingError) return err;
  const { code, constraint } = pgErrorOf(err);
  if (code === 'CL001') return new BookingError('PATIENT_LIMIT_EXCEEDED');
  if ((code === '23P01' || code === '23505') && constraint !== undefined) {
    const mapped = CONSTRAINT_TO_CODE[constraint];
    if (mapped !== undefined) return new BookingError(mapped);
  }
  return null;
}
