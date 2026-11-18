/**
 * Per-request DataLoaders: one `WHERE id = ANY($1)` per entity type per tick, so a list of N appointments
 * costs a fixed number of SQL statements (docs/analysis/06 section 6). Created in buildContext, never shared.
 */
import DataLoader from 'dataloader';
import type { Pool } from 'pg';

export interface ClinicRow {
  id: number;
  city: string;
  name: string;
  timezone: string;
  currency: string;
}

export interface ServiceRow {
  id: number;
  name: string;
  durationMinutes: number;
  usesUltrasoundRoom: boolean;
}

export interface DoctorRow {
  id: number;
  specialty: string;
}

export interface PatientRow {
  id: number;
  fullName: string;
  phone: string | null;
  email: string | null;
}

export interface Loaders {
  clinics: DataLoader<number, ClinicRow | null>;
  services: DataLoader<number, ServiceRow | null>;
  doctors: DataLoader<number, DoctorRow | null>;
  patients: DataLoader<number, PatientRow | null>;
}

function byId<T extends { id: number }>(pool: Pool, sql: string): DataLoader<number, T | null> {
  return new DataLoader<number, T | null>(async (ids) => {
    const { rows } = await pool.query<T>(sql, [[...ids]]);
    const byKey = new Map(rows.map((row) => [row.id, row]));
    return ids.map((id) => byKey.get(id) ?? null);
  });
}

export function createLoaders(pool: Pool): Loaders {
  return {
    clinics: byId<ClinicRow>(
      pool,
      `SELECT id::int AS id, city, name, timezone, currency FROM clinics WHERE id = ANY($1::bigint[])`,
    ),
    services: byId<ServiceRow>(
      pool,
      `SELECT id::int AS id, name, duration_minutes AS "durationMinutes",
              uses_ultrasound_room AS "usesUltrasoundRoom"
         FROM services WHERE id = ANY($1::bigint[])`,
    ),
    doctors: byId<DoctorRow>(
      pool,
      `SELECT id::int AS id, specialty FROM doctors WHERE id = ANY($1::bigint[])`,
    ),
    patients: byId<PatientRow>(
      pool,
      `SELECT id::int AS id, full_name AS "fullName", phone, email
         FROM patients WHERE id = ANY($1::bigint[])`,
    ),
  };
}
