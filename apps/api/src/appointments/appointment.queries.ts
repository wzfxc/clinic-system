/**
 * Appointment reads. The actor's scope is part of the SQL (docs/analysis/06 section 2, layer 4), so rows
 * outside it never leave Postgres. A manager has no access to records (Q5) and gets an empty result.
 */
import type { Pool } from 'pg';
import type { AuthActor } from '@clinic/shared';
import {
  APPOINTMENT_COLUMNS,
  BookingError,
  isValidIsoDate,
  toAppointment,
  type Appointment,
  type AppointmentRow,
} from '@clinic/shared';

export interface AppointmentFilter {
  patientId?: number | undefined;
  doctorId?: number | undefined;
  clinicId?: number | undefined;
  date?: string | undefined;
  dateFrom?: string | undefined;
  dateTo?: string | undefined;
  status?: string | undefined;
}

const VALID_STATUSES = new Set(['held', 'booked', 'checked_in', 'completed', 'no_show', 'cancelled']);

/** SQL condition that restricts appointments to what the actor may see; pushes its parameter. */
export function scopeCondition(actor: AuthActor, params: unknown[]): string {
  switch (actor.role) {
    case 'patient':
      params.push(actor.patientId);
      return `patient_id = $${params.length}`;
    case 'receptionist':
      params.push(actor.clinicId);
      return `clinic_id = $${params.length}`;
    case 'doctor':
      params.push(actor.doctorId);
      return `doctor_id = $${params.length}`;
  }
}

function filterConditions(filter: AppointmentFilter, params: unknown[]): string[] {
  const conditions: string[] = [];
  const add = (column: string, value: number | undefined): void => {
    if (value === undefined) return;
    params.push(value);
    conditions.push(`${column} = $${params.length}`);
  };
  add('patient_id', filter.patientId);
  add('doctor_id', filter.doctorId);
  add('clinic_id', filter.clinicId);
  if (filter.date !== undefined && filter.date !== '') {
    if (!isValidIsoDate(filter.date)) throw new BookingError('VALIDATION_FAILED', 'date must be YYYY-MM-DD');
    params.push(filter.date);
    conditions.push(`local_date = $${params.length}::date`);
  }
  if (filter.dateFrom !== undefined && filter.dateFrom !== '') {
    if (!isValidIsoDate(filter.dateFrom)) throw new BookingError('VALIDATION_FAILED', 'dateFrom must be YYYY-MM-DD');
    params.push(filter.dateFrom);
    conditions.push(`local_date >= $${params.length}::date`);
  }
  if (filter.dateTo !== undefined && filter.dateTo !== '') {
    if (!isValidIsoDate(filter.dateTo)) throw new BookingError('VALIDATION_FAILED', 'dateTo must be YYYY-MM-DD');
    params.push(filter.dateTo);
    conditions.push(`local_date <= $${params.length}::date`);
  }
  if (filter.status !== undefined && filter.status !== '') {
    if (!VALID_STATUSES.has(filter.status)) throw new BookingError('VALIDATION_FAILED', 'invalid status filter');
    params.push(filter.status);
    conditions.push(`status = $${params.length}::appointment_status`);
  }
  return conditions;
}

/** Visible appointments: the filter is intersected with the scope, never replaces it. */
export async function listAppointments(
  pool: Pool,
  actor: AuthActor,
  filter: AppointmentFilter,
  first: number,
  order: 'asc' | 'desc' = 'asc',
): Promise<Appointment[]> {
  const params: unknown[] = [];
  const conditions = [scopeCondition(actor, params), ...filterConditions(filter, params)];
  params.push(first);
  const dir = order === 'desc' ? 'DESC' : 'ASC';
  const { rows } = await pool.query<AppointmentRow>(
    `SELECT ${APPOINTMENT_COLUMNS} FROM appointments
      WHERE ${conditions.join(' AND ')}
      ORDER BY starts_at ${dir}, id ${dir} LIMIT $${params.length}`,
    params,
  );
  return rows.map(toAppointment);
}

/** One appointment by id, visible to the actor, or null. Other people's ids look like missing ones. */
export async function findAppointment(pool: Pool, actor: AuthActor, id: number): Promise<Appointment | null> {
  const params: unknown[] = [id];
  const scope = scopeCondition(actor, params);
  const { rows } = await pool.query<AppointmentRow>(
    `SELECT ${APPOINTMENT_COLUMNS} FROM appointments WHERE id = $1 AND ${scope}`,
    params,
  );
  const row = rows[0];
  return row ? toAppointment(row) : null;
}
