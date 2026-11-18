/**
 * Demo seed (docs/analysis/00-decisions.md, seed section of 01): 3 clinics, 40 doctors, 15 services,
 * 20000 patients, about 150000 appointments over 180 past days and 30 future days.
 * One transaction, idempotent (skipped when clinics already exist), deterministic (fixed RNG seed and clock).
 */
import type { PoolClient } from 'pg';
import { DateTime } from 'luxon';
import { FixedClock } from '../clock.js';
import { CLINICS, SERVICES, buildDoctors } from './catalog.js';
import { type AppointmentRow, type SeedIds, generateAppointments } from './appointments.js';
import { createRng } from './rng.js';
import { hashPassword } from './password.js';

export const RNG_SEED = 20261118;
export const DEFAULT_SEED_NOW = '2026-11-18T12:00:00.000Z';
export const PAST_DAYS = 180;
export const FUTURE_DAYS = 30;
export const PATIENT_COUNT = 20000;
export const DEMO_PASSWORD = 'demo-password';
const INSERT_CHUNK = 10000;

export interface SeedReport {
  skipped: boolean;
  appointments: number;
  timingsMs: Record<string, number>;
}

/** Local dates (YYYY-MM-DD) from PAST_DAYS before `now` to FUTURE_DAYS after it. */
export function seedDates(now: Date): string[] {
  const today = DateTime.fromJSDate(now, { zone: 'UTC' });
  const dates: string[] = [];
  for (let offset = -PAST_DAYS; offset <= FUTURE_DAYS; offset += 1) {
    dates.push(today.plus({ days: offset }).toISODate() ?? '');
  }
  return dates;
}

async function timed<T>(timings: Record<string, number>, label: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await work();
  timings[label] = Math.round(performance.now() - started);
  return result;
}

async function insertUser(client: PoolClient, email: string, role: string, passwordHash: string, clinicId: number | null, now: Date): Promise<number> {
  const { rows } = await client.query<{ id: number }>(
    'INSERT INTO users (email, role, password_hash, clinic_id, created_at) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [email, role, passwordHash, clinicId, now],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error(`user insert returned no id for ${email}`);
  return id;
}

async function insertCatalog(client: PoolClient): Promise<Pick<SeedIds, 'clinicIds' | 'serviceIds'>> {
  const clinicIds: number[] = [];
  for (const clinic of CLINICS) {
    const { rows } = await client.query<{ id: number }>(
      'INSERT INTO clinics (city, name, timezone, currency) VALUES ($1, $2, $3, $4) RETURNING id',
      [clinic.city, clinic.name, clinic.timezone, clinic.currency],
    );
    clinicIds.push(rows[0]?.id ?? 0);
  }
  const serviceIds: number[] = [];
  for (const service of SERVICES) {
    const { rows } = await client.query<{ id: number }>(
      'INSERT INTO services (name, duration_minutes, uses_ultrasound_room) VALUES ($1, $2, $3) RETURNING id',
      [service.name, service.durationMinutes, service.usesUltrasoundRoom],
    );
    serviceIds.push(rows[0]?.id ?? 0);
  }
  const priceRows = CLINICS.flatMap((clinic, c) =>
    SERVICES.map((service, s) => [clinicIds[c], serviceIds[s], Math.round(service.durationMinutes * 1000 * clinic.priceFactor)]),
  );
  await client.query(
    `INSERT INTO clinic_services (clinic_id, service_id, price_minor)
     SELECT * FROM unnest($1::bigint[], $2::bigint[], $3::bigint[])`,
    [priceRows.map((r) => r[0]), priceRows.map((r) => r[1]), priceRows.map((r) => r[2])],
  );
  return { clinicIds, serviceIds };
}

async function insertDoctors(
  client: PoolClient,
  catalog: Pick<SeedIds, 'clinicIds' | 'serviceIds'>,
  doctors: ReturnType<typeof buildDoctors>,
  passwordHash: string,
  now: Date,
): Promise<number[]> {
  const doctorIds: number[] = [];
  for (const doctor of doctors) {
    const userId = await insertUser(client, `doctor${doctor.index + 1}@clinic.local`, 'doctor', passwordHash, null, now);
    const { rows } = await client.query<{ id: number }>(
      'INSERT INTO doctors (user_id, specialty) VALUES ($1, $2) RETURNING id',
      [userId, doctor.specialty],
    );
    const doctorId = rows[0]?.id ?? 0;
    doctorIds.push(doctorId);
    const clinicId = catalog.clinicIds[doctor.clinicIndex] ?? 0;
    await client.query('INSERT INTO doctor_clinics (doctor_id, clinic_id) VALUES ($1, $2)', [doctorId, clinicId]);
    const serviceIds = doctor.serviceIndexes.map((i) => catalog.serviceIds[i] ?? 0);
    await client.query(
      'INSERT INTO doctor_services (doctor_id, service_id) SELECT $1, * FROM unnest($2::bigint[])',
      [doctorId, serviceIds],
    );
    for (const [weekday, shift] of doctor.templates) {
      await client.query(
        `INSERT INTO schedule_templates (doctor_id, clinic_id, weekday, work_start, work_end, break_start, break_end)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [doctorId, clinicId, weekday, shift.start, shift.end, shift.breakStart ?? null, shift.breakEnd ?? null],
      );
    }
    for (const [date, shift] of doctor.exceptions) {
      await client.query(
        `INSERT INTO schedule_exceptions (doctor_id, clinic_id, on_date, kind, reason, work_start, work_end, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          doctorId,
          clinicId,
          date,
          shift === null ? 'day_off' : 'extra_day',
          doctor.exceptionReasons.get(date) ?? 'other',
          shift?.start ?? null,
          shift?.end ?? null,
          now,
        ],
      );
    }
  }
  return doctorIds;
}

async function insertPatients(client: PoolClient, passwordHash: string, now: Date): Promise<number[]> {
  const emails = Array.from({ length: PATIENT_COUNT }, (_, i) => `patient${i + 1}@clinic.local`);
  await client.query(
    `INSERT INTO users (email, role, password_hash, created_at)
     SELECT e, 'patient', $2, $3 FROM unnest($1::text[]) AS e`,
    [emails, passwordHash, now],
  );
  const { rows } = await client.query<{ id: number }>(
    `INSERT INTO patients (user_id, full_name, email)
     SELECT u.id, 'Patient ' || u.id, u.email FROM users u WHERE u.role = 'patient' ORDER BY u.id RETURNING id`,
  );
  return rows.map((r) => r.id);
}

/**
 * Row triggers that would make the bulk load row-by-row slow. The seed supplies what they derive itself
 * (local_date from the clinic zone, the 3-future limit by construction, history events in the same statement);
 * exclusion, unique, check and foreign-key constraints stay enforced throughout.
 */
const BULK_LOAD_TRIGGERS = ['appointments_a_local_date', 'appointments_b_patient_limit', 'appointments_history'] as const;

async function setBulkTriggers(client: PoolClient, enabled: boolean): Promise<void> {
  for (const trigger of BULK_LOAD_TRIGGERS) {
    await client.query(`ALTER TABLE appointments ${enabled ? 'ENABLE' : 'DISABLE'} TRIGGER ${trigger}`);
  }
}

interface DeferredIndex {
  drop: string;
  create: string;
}

/**
 * Secondary indexes and exclusion / unique constraints are dropped for the load and rebuilt in bulk afterwards
 * (a gist build is far cheaper than 150k incremental inserts). Re-adding validates every row, so the invariants
 * still hold when the seed commits; a violation aborts the whole transaction.
 */
async function deferredIndexes(client: PoolClient, table: string): Promise<DeferredIndex[]> {
  const constraints = await client.query<{ conname: string; def: string }>(
    `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conrelid = $1::regclass AND contype IN ('x', 'u')`,
    [table],
  );
  const indexes = await client.query<{ indexname: string; indexdef: string }>(
    `SELECT indexname, indexdef FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = $1 AND indexname NOT LIKE '%\_pkey'
       AND indexname NOT IN (SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass)`,
    [table],
  );
  return [
    ...constraints.rows.map((c) => ({
      drop: `ALTER TABLE ${table} DROP CONSTRAINT "${c.conname}"`,
      create: `ALTER TABLE ${table} ADD CONSTRAINT "${c.conname}" ${c.def}`,
    })),
    ...indexes.rows.map((i) => ({ drop: `DROP INDEX "${i.indexname}"`, create: i.indexdef })),
  ];
}

async function insertAppointments(client: PoolClient, rows: AppointmentRow[]): Promise<void> {
  const deferred = [...(await deferredIndexes(client, 'appointments')), ...(await deferredIndexes(client, 'appointment_events'))];
  await setBulkTriggers(client, false);
  for (const index of deferred) await client.query(index.drop);
  for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
    await insertChunk(client, rows.slice(start, start + INSERT_CHUNK));
  }
  for (const index of deferred) await client.query(index.create);
  await setBulkTriggers(client, true);
}

/** One statement per chunk: the rows, their `created` events, and `cancelled` / `no_show` events (late = within 24h, R1). */
async function insertChunk(client: PoolClient, chunk: AppointmentRow[]): Promise<void> {
  const col = <K extends keyof AppointmentRow>(key: K): AppointmentRow[K][] => chunk.map((r) => r[key]);
  await client.query(
    `WITH ins AS (
       INSERT INTO appointments (clinic_id, doctor_id, patient_id, service_id, status, starts_at, ends_at, blocked_until,
         local_date, uses_ultrasound_room, price_minor, currency, cancel_reason, created_at, updated_at, time_version)
       SELECT clinic_id, doctor_id, patient_id, service_id, status::appointment_status, starts_at, ends_at, blocked_until,
         local_date::date, uses_ultrasound_room, price_minor, currency, cancel_reason, created_at,
         coalesce(cancelled_at, created_at), 1
       FROM unnest($1::bigint[], $2::bigint[], $3::bigint[], $4::bigint[], $5::text[], $6::timestamptz[], $7::timestamptz[],
         $8::timestamptz[], $9::text[], $10::boolean[], $11::bigint[], $12::text[], $13::text[], $14::timestamptz[],
         $15::timestamptz[])
         AS t(clinic_id, doctor_id, patient_id, service_id, status, starts_at, ends_at, blocked_until,
              local_date, uses_ultrasound_room, price_minor, currency, cancel_reason, created_at, cancelled_at)
       RETURNING id, patient_id, status, starts_at, ends_at, created_at, updated_at, cancel_reason
     ), created AS (
       INSERT INTO appointment_events (appointment_id, patient_id, kind, to_status, new_starts_at, occurred_at)
       SELECT id, patient_id, 'created', status, starts_at, created_at FROM ins
     )
     INSERT INTO appointment_events (appointment_id, patient_id, kind, from_status, to_status, old_starts_at,
                                     is_late, is_strike, reason, occurred_at)
     SELECT id, patient_id, status::text::appointment_event_kind, 'booked', status, starts_at,
            status = 'cancelled' AND starts_at - updated_at <= interval '24 hours',
            status = 'no_show' OR (status = 'cancelled' AND starts_at - updated_at <= interval '24 hours'),
            cancel_reason, CASE WHEN status = 'cancelled' THEN updated_at ELSE ends_at END
     FROM ins WHERE status IN ('cancelled', 'no_show')`,
    [
      col('clinicId'), col('doctorId'), col('patientId'), col('serviceId'), col('status'),
      col('startsAt'), col('endsAt'), col('blockedUntil'), col('localDate'), col('usesUltrasoundRoom'),
      col('priceMinor'), col('currency'), col('cancelReason'), col('createdAt'), col('cancelledAt'),
    ],
  );
}

/** Seeds the database inside the caller's transaction-less client; the whole seed is one transaction. */
export async function runSeed(client: PoolClient, nowIso: string = process.env['SEED_NOW'] ?? DEFAULT_SEED_NOW): Promise<SeedReport> {
  const timings: Record<string, number> = {};
  const clock = new FixedClock(new Date(nowIso));
  const now = clock.now();
  await client.query('BEGIN');
  try {
    const existing = await client.query<{ count: string }>('SELECT count(*) FROM clinics');
    if (Number(existing.rows[0]?.count ?? 0) > 0) {
      await client.query('ROLLBACK');
      return { skipped: true, appointments: 0, timingsMs: timings };
    }
    const passwordHash = await hashPassword(DEMO_PASSWORD);
    const rng = createRng(RNG_SEED);
    const dates = seedDates(now);
    const doctorsPlan = buildDoctors(rng, dates);
    const manager = await insertUser(client, 'manager@clinic.local', 'manager', passwordHash, null, now);
    await client.query(
      "SELECT set_config('app.actor_id', $1, true), set_config('app.actor_role', 'manager', true), set_config('app.clock_now', $2, true)",
      [String(manager), now.toISOString()],
    );
    const catalog = await timed(timings, 'catalog', () => insertCatalog(client));
    for (const [index, clinicId] of catalog.clinicIds.entries()) {
      await insertUser(client, `reception${index + 1}@clinic.local`, 'receptionist', passwordHash, clinicId, now);
    }
    const doctorIds = await timed(timings, 'doctors', () => insertDoctors(client, catalog, doctorsPlan, passwordHash, now));
    const patientIds = await timed(timings, 'patients', () => insertPatients(client, passwordHash, now));
    const ids: SeedIds = { ...catalog, doctorIds, patientIds };
    const rows = await timed(timings, 'generate', async () =>
      generateAppointments({ rng, ids, doctors: doctorsPlan, now, dates }),
    );
    await timed(timings, 'appointments', () => insertAppointments(client, rows));
    await client.query('COMMIT');
    return { skipped: false, appointments: rows.length, timingsMs: timings };
  } catch (error: unknown) {
    await client.query('ROLLBACK');
    throw error;
  }
}
