/**
 * Reschedule in place (docs/analysis/03 "Перенос", Q3): one UPDATE of the same row, so the three
 * exclusion constraints and the daily-visit index judge the new time atomically and a refusal leaves
 * the old booking and its history untouched. Lock order: patient, doctor, ultrasound room, then the
 * appointment row. `time_version` is the optimistic token: a stale one is a CONFLICT.
 * A refused UPDATE aborts the transaction; the caller rolls back (runInTransaction does).
 */
import type { Clock } from '../clock.js';
import { PREP_BUFFER_MINUTES } from '../rules.js';
import { assertCanManageBooking, type AuthActor } from './actor.js';
import {
  APPOINTMENT_COLUMNS,
  applyActor,
  loadAppointment,
  lockPatient,
  toAppointment,
  type Appointment,
  type AppointmentRow,
} from './appointment.js';
import { freedIntervalOf, isLateCancellation } from './cancel.js';
import { advisoryLock, assertSlotAllowed, reapExpiredCheckoutHolds } from './hold.js';
import { DEFAULT_HOOKS, type DomainHooks } from './hooks.js';
import { loadClinicService } from './slots-repo.js';
import { MINUTE_MS } from './time.js';
import { BookingError, type Tx } from './tx.js';

export interface RescheduleInput {
  appointmentId: number;
  /** The `timeVersion` the caller last saw. */
  expectedVersion: number;
  newStartsAt: Date;
  actor: AuthActor;
}

export interface RescheduleResult {
  appointment: Appointment;
  /** True when the visit was moved at most 24 hours before its old start (a strike). */
  late: boolean;
}

export async function rescheduleAppointment(
  tx: Tx,
  clock: Clock,
  input: RescheduleInput,
  hooks: DomainHooks = DEFAULT_HOOKS,
): Promise<RescheduleResult> {
  const now = clock.now();
  await applyActor(tx, input.actor);
  const preview = await loadAppointment(tx, input.appointmentId);
  assertCanManageBooking(input.actor, preview);

  await lockPatient(tx, preview.patientId);
  const service = await loadClinicService(tx, preview.clinicId, preview.serviceId);
  if (service === null) throw new BookingError('SERVICE_NOT_PROVIDED');
  await advisoryLock(tx, `doctor:${preview.doctorId}`);
  if (service.usesUltrasoundRoom) await advisoryLock(tx, `room:${preview.clinicId}`);

  const current = await loadAppointment(tx, input.appointmentId, true);
  if (current.status !== 'booked' || current.startsAt <= now) {
    throw new BookingError('INVALID_STATUS_TRANSITION', `cannot reschedule a ${current.status} appointment`);
  }
  if (current.timeVersion !== input.expectedVersion) {
    throw new BookingError('CONFLICT', 'the appointment was changed by someone else', {
      currentVersion: current.timeVersion,
    });
  }
  if (input.newStartsAt.getTime() === current.startsAt.getTime()) {
    throw new BookingError('VALIDATION_FAILED', 'the new time equals the current time');
  }

  await assertSlotAllowed(tx, now, { ...current, startsAt: input.newStartsAt }, service);
  const endsAt = new Date(input.newStartsAt.getTime() + service.durationMinutes * MINUTE_MS);
  const blockedUntil = new Date(endsAt.getTime() + PREP_BUFFER_MINUTES * MINUTE_MS);
  await reapExpiredCheckoutHolds(tx, clock, {
    doctorId: current.doctorId,
    clinicId: current.clinicId,
    usesUltrasoundRoom: current.usesUltrasoundRoom,
    range: { start: input.newStartsAt, end: blockedUntil },
  });

  const { rows } = await tx.query<AppointmentRow>(
    `UPDATE appointments
        SET starts_at = $3, ends_at = $4, blocked_until = $5, time_version = time_version + 1, updated_at = $6
      WHERE id = $1 AND time_version = $2 AND status = 'booked'
      RETURNING ${APPOINTMENT_COLUMNS}`,
    [current.id, input.expectedVersion, input.newStartsAt, endsAt, blockedUntil, now],
  );
  const row = rows[0];
  if (!row) throw new BookingError('CONFLICT'); // unreachable under the row lock
  await hooks.onSlotsFreed(tx, [freedIntervalOf(current, 'rescheduled')], clock);
  return { appointment: toAppointment(row), late: isLateCancellation(current.startsAt, now) };
}
