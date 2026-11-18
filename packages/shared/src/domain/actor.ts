/**
 * Who is acting, and what they may touch (docs/analysis/06 sections 2-3, 00-decisions D5).
 * Permissions are checked in the domain functions against this value, not only in a guard,
 * so the worker and any other caller get the same rules. Every shape carries `userId` and
 * `role`, which is what `applyActor` writes for the history trigger.
 */
import { BookingError } from './tx.js';

export type AuthActor =
  | { role: 'patient'; userId: number; patientId: number }
  | { role: 'receptionist'; userId: number; clinicId: number }
  | { role: 'doctor'; userId: number; doctorId: number };

/** The columns of an appointment that decide who may act on it. */
export interface AppointmentScope {
  patientId: number;
  clinicId: number;
  doctorId: number;
}

/** The actor owns the appointment: the patient themselves, the doctor who sees them, or the registrar of its clinic. */
export function ownsAppointment(actor: AuthActor, appointment: AppointmentScope): boolean {
  switch (actor.role) {
    case 'patient':
      return actor.patientId === appointment.patientId;
    case 'receptionist':
      return actor.clinicId === appointment.clinicId;
    case 'doctor':
      return actor.doctorId === appointment.doctorId;
  }
}

/** Cancel and reschedule: a patient their own, a registrar their clinic's. Doctors do neither. */
export function assertCanManageBooking(actor: AuthActor, appointment: AppointmentScope): void {
  if (actor.role === 'doctor' || !ownsAppointment(actor, appointment)) {
    throw new BookingError('FORBIDDEN', 'not allowed to change this appointment');
  }
}
