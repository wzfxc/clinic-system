/**
 * Status transitions made by staff (docs/analysis/03 "Статуси: хто що може"). The DB trigger
 * guards the graph (CL002); this function adds who may do it and the time conditions:
 *   booked -> checked_in   registrar of the clinic, on the day of the visit
 *   booked -> no_show      registrar of the clinic or the doctor, once the visit has started
 *   checked_in -> no_show  the doctor (Q8), once the visit has started
 *   booked|checked_in -> completed   the doctor, once the visit has started (00-decisions D5)
 */
import type { Clock } from '../clock.js';
import type { AuthActor } from './actor.js';
import {
  APPOINTMENT_COLUMNS,
  applyActor,
  lockAppointment,
  toAppointment,
  type Appointment,
  type AppointmentRow,
  type AppointmentStatus,
} from './appointment.js';
import { loadClinicService } from './slots-repo.js';
import { localDateOf } from './time.js';
import { BookingError, type Tx } from './tx.js';

export type StaffTargetStatus = 'checked_in' | 'no_show' | 'completed';

export interface ChangeStatusInput {
  appointmentId: number;
  to: StaffTargetStatus;
  actor: AuthActor;
}

const forbidden = (): BookingError => new BookingError('FORBIDDEN', 'not allowed to change this appointment');

/** Ownership check that needs only the target, so it can run before any lock is taken. */
function assertMayTarget(actor: AuthActor, to: StaffTargetStatus, a: Appointment): void {
  if (actor.role === 'patient') throw forbidden();
  if (actor.role === 'receptionist') {
    if (to === 'completed' || actor.clinicId !== a.clinicId) throw forbidden();
    return;
  }
  if (to === 'checked_in' || actor.doctorId !== a.doctorId) throw forbidden();
}

const invalid = (from: AppointmentStatus, to: StaffTargetStatus): BookingError =>
  new BookingError('INVALID_STATUS_TRANSITION', `${from} -> ${to} is not allowed now`);

async function assertTransitionAllowed(
  tx: Tx,
  now: Date,
  actor: AuthActor,
  to: StaffTargetStatus,
  a: Appointment,
): Promise<void> {
  const from = a.status;
  if (to === 'checked_in') {
    if (from !== 'booked') throw invalid(from, to);
    const service = await loadClinicService(tx, a.clinicId, a.serviceId);
    if (service === null) throw new BookingError('SERVICE_NOT_PROVIDED');
    if (localDateOf(now, service.timezone) !== a.localDate) throw invalid(from, to);
    return;
  }
  if (from !== 'booked' && from !== 'checked_in') throw invalid(from, to);
  if (a.startsAt > now) throw invalid(from, to);
  if (to === 'no_show' && from === 'checked_in' && actor.role !== 'doctor') throw forbidden();
}

export async function changeAppointmentStatus(tx: Tx, clock: Clock, input: ChangeStatusInput): Promise<Appointment> {
  const now = clock.now();
  await applyActor(tx, input.actor);
  const current = await lockAppointment(tx, input.appointmentId, (a) => assertMayTarget(input.actor, input.to, a));
  await assertTransitionAllowed(tx, now, input.actor, input.to, current);

  const { rows } = await tx.query<AppointmentRow>(
    `UPDATE appointments SET status = $2, updated_at = $3
      WHERE id = $1 AND status = $4
      RETURNING ${APPOINTMENT_COLUMNS}`,
    [current.id, input.to, now, current.status],
  );
  const row = rows[0];
  if (!row) throw invalid(current.status, input.to); // unreachable under the row lock
  return toAppointment(row);
}
