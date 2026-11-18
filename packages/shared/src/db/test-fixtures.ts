/** Seed helpers for integration tests that need a clinic, doctors, patients and raw appointments. */
import type { Pool, PoolClient } from 'pg';
import { PREP_BUFFER_MINUTES } from '../rules.js';

const MINUTE_MS = 60_000;

export interface World {
  clinicId: number;
  /** 30-minute consultation. */
  serviceId: number;
  /** 30-minute service that needs the clinic's ultrasound room. */
  uziServiceId: number;
  timezone: string;
}

export async function insertId(pool: Pool, text: string, values: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(text, values);
  const row = rows[0];
  if (!row) throw new Error('no row returned');
  return Number(row.id);
}

export async function seedWorld(pool: Pool, timezone = 'Europe/Kyiv'): Promise<World> {
  const currency = timezone === 'Europe/Warsaw' ? 'PLN' : 'UAH';
  const clinicId = await insertId(
    pool,
    `INSERT INTO clinics (city, name, timezone, currency) VALUES ('City','Clinic',$1,$2) RETURNING id`,
    [timezone, currency],
  );
  const serviceId = await insertId(
    pool,
    `INSERT INTO services (name, duration_minutes, uses_ultrasound_room) VALUES ('Consult',30,false) RETURNING id`,
  );
  const uziServiceId = await insertId(
    pool,
    `INSERT INTO services (name, duration_minutes, uses_ultrasound_room) VALUES ('Ultrasound',30,true) RETURNING id`,
  );
  for (const sid of [serviceId, uziServiceId]) {
    await pool.query(`INSERT INTO clinic_services (clinic_id, service_id, price_minor) VALUES ($1,$2,50000)`, [
      clinicId,
      sid,
    ]);
  }
  return { clinicId, serviceId, uziServiceId, timezone };
}

export interface DoctorOptions {
  workStart?: string;
  workEnd?: string;
  breakStart?: string;
  breakEnd?: string;
  /** ISO weekdays with a template; default all seven. */
  weekdays?: readonly number[];
  /** Extra services (besides the world's two) the doctor performs. */
  extraServiceIds?: readonly number[];
}

export async function seedDoctor(pool: Pool, w: World, options: DoctorOptions = {}): Promise<number> {
  const doctorId = await insertId(pool, `INSERT INTO doctors (specialty) VALUES ('general') RETURNING id`);
  await pool.query(`INSERT INTO doctor_clinics (doctor_id, clinic_id) VALUES ($1,$2)`, [doctorId, w.clinicId]);
  for (const sid of [w.serviceId, w.uziServiceId, ...(options.extraServiceIds ?? [])]) {
    await pool.query(`INSERT INTO doctor_services (doctor_id, service_id) VALUES ($1,$2)`, [doctorId, sid]);
  }
  for (const weekday of options.weekdays ?? [1, 2, 3, 4, 5, 6, 7]) {
    await pool.query(
      `INSERT INTO schedule_templates (doctor_id, clinic_id, weekday, work_start, work_end, break_start, break_end)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        doctorId,
        w.clinicId,
        weekday,
        options.workStart ?? '09:00',
        options.workEnd ?? '17:00',
        options.breakStart ?? null,
        options.breakEnd ?? null,
      ],
    );
  }
  return doctorId;
}

export const seedPatient = (pool: Pool, n: number): Promise<number> =>
  insertId(pool, `INSERT INTO patients (full_name) VALUES ($1) RETURNING id`, [`Patient ${n}`]);

export interface RawAppointment {
  w: World;
  doctorId: number;
  patientId: number;
  startsAt: Date;
  status?: 'held' | 'booked' | 'cancelled';
  holdKind?: 'checkout' | 'waitlist_offer';
  holdExpiresAt?: Date;
  ultrasound?: boolean;
  createdAt: Date;
}

/** Inserts a 30-minute appointment directly (no service layer); needs `app.clock_now` set on `client`. */
export async function insertRawAppointment(client: PoolClient, a: RawAppointment): Promise<void> {
  const status = a.status ?? 'booked';
  const endsAt = new Date(a.startsAt.getTime() + 30 * MINUTE_MS);
  const blockedUntil = new Date(endsAt.getTime() + PREP_BUFFER_MINUTES * MINUTE_MS);
  const isHeld = status === 'held';
  await client.query(
    `INSERT INTO appointments
       (clinic_id, doctor_id, patient_id, service_id, status, starts_at, ends_at, blocked_until,
        uses_ultrasound_room, price_minor, currency, hold_kind, hold_expires_at, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,50000,'UAH',$10,$11,$12,$12)`,
    [
      a.w.clinicId,
      a.doctorId,
      a.patientId,
      a.ultrasound ? a.w.uziServiceId : a.w.serviceId,
      status,
      a.startsAt,
      endsAt,
      blockedUntil,
      a.ultrasound ?? false,
      isHeld ? (a.holdKind ?? 'checkout') : null,
      isHeld ? (a.holdExpiresAt ?? null) : null,
      a.createdAt,
    ],
  );
}
