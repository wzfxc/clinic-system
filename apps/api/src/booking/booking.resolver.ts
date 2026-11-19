/**
 * Booking and waitlist mutations, wired to BookingService and WaitlistService (docs/analysis/06 section 3).
 * Patients act on their own objects only; anything of someone else's is NOT_FOUND, the same as a missing id.
 * Domain functions enforce the rules again, so this layer only decides who may call and what they may name.
 */
import { Args, Context, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { ERROR_CODES, isValidIsoDate, type Appointment, type AuthActor } from '@clinic/shared';
import type { RequestContext } from '../graphql/context.js';
import { isBookingError } from '../graphql/errors.js';
import { graphQLError, requireAuthActor, requirePatient } from '../graphql/guards.js';
import { AppointmentModel } from '../graphql/models.js';
import { findAppointment } from '../appointments/appointment.queries.js';
import {
  AppointmentEventModel,
  HoldSlotInput,
  InAppReminderModel,
  JoinWaitlistInput,
  SickLeaveResultModel,
  UpsertScheduleExceptionInput,
  UpsertScheduleTemplateInput,
  WaitlistEntryModel,
  WaitlistOfferModel,
} from './booking.models.js';

const STAFF_STATUSES = ['checked_in', 'no_show', 'completed'] as const;
type StaffStatus = (typeof STAFF_STATUSES)[number];
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

function isStaffStatus(value: string): value is StaffStatus {
  return (STAFF_STATUSES as readonly string[]).includes(value);
}

function validateIdempotencyKey(key: string): string {
  if (key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw graphQLError(ERROR_CODES.VALIDATION_FAILED, 'idempotencyKey must be 1 to 128 characters');
  }
  return key;
}

function validateDate(value: string, field: string): string {
  if (!isValidIsoDate(value)) {
    throw graphQLError(ERROR_CODES.VALIDATION_FAILED, `${field} must be a valid YYYY-MM-DD calendar date`);
  }
  return value;
}

/** A foreign appointment is reported as NOT_FOUND, the same as a missing one (docs/analysis/06 section 2). */
async function asNotFoundWhenForeign<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (isBookingError(err) && (err.code === ERROR_CODES.FORBIDDEN || err.code === ERROR_CODES.NOT_FOUND)) {
      throw graphQLError(ERROR_CODES.NOT_FOUND, 'appointment not found');
    }
    throw err;
  }
}

@Resolver()
export class BookingResolver {
  @Query(() => [WaitlistOfferModel], { description: 'Pending and recent waitlist offers for the signed-in patient.' })
  async myWaitlistOffers(@Context() ctx: RequestContext): Promise<WaitlistOfferModel[]> {
    const actor = requirePatient(ctx);
    const { rows } = await ctx.pool.query<WaitlistOfferModel>(
      `SELECT o.id::int AS id, o.entry_id::int AS "entryId", o.appointment_id::int AS "appointmentId",
              a.clinic_id::int AS "clinicId", a.doctor_id::int AS "doctorId", a.service_id::int AS "serviceId",
              a.starts_at AS "startsAt", a.ends_at AS "endsAt", o.expires_at AS "expiresAt", o.status::text AS status
         FROM waitlist_offers o
         JOIN waitlist_entries e ON e.id = o.entry_id
         JOIN appointments a ON a.id = o.appointment_id
        WHERE e.patient_id = $1
        ORDER BY o.id DESC LIMIT 20`,
      [actor.patientId],
    );
    return rows;
  }

  @Query(() => [WaitlistEntryModel], { description: 'Active waitlist entries for the signed-in patient.' })
  async myWaitlistEntries(@Context() ctx: RequestContext): Promise<WaitlistEntryModel[]> {
    const actor = requirePatient(ctx);
    const { rows } = await ctx.pool.query<WaitlistEntryModel>(
      `SELECT id::int AS id, clinic_id::int AS "clinicId", doctor_id::int AS "doctorId",
              service_id::int AS "serviceId", date_from::text AS "dateFrom", date_to::text AS "dateTo",
              priority::int AS priority, status::text AS status
         FROM waitlist_entries
        WHERE patient_id = $1 AND status IN ('waiting', 'offered')
        ORDER BY id DESC LIMIT 20`,
      [actor.patientId],
    );
    return rows;
  }

  @Query(() => [InAppReminderModel], { description: 'In-app 24h and 2h visit reminders for the signed-in patient.' })
  async myReminders(@Context() ctx: RequestContext): Promise<InAppReminderModel[]> {
    const actor = requirePatient(ctx);
    const { rows } = await ctx.pool.query<InAppReminderModel>(
      `SELECT r.id::int AS id, r.appointment_id::int AS "appointmentId", r.kind::text AS kind,
              r.due_at AS "dueAt", a.starts_at AS "startsAt", a.clinic_id::int AS "clinicId", a.doctor_id::int AS "doctorId"
         FROM reminders r
         JOIN appointments a ON a.id = r.appointment_id
        WHERE a.patient_id = $1 AND r.cancelled_at IS NULL AND r.skipped_at IS NULL AND a.status <> 'cancelled'
        ORDER BY r.due_at DESC LIMIT 20`,
      [actor.patientId],
    );
    return rows;
  }

  @Query(() => [AppointmentEventModel], { description: 'Audit history of a visible appointment.' })
  async appointmentHistory(
    @Context() ctx: RequestContext,
    @Args('appointmentId', { type: () => Int }) appointmentId: number,
  ): Promise<AppointmentEventModel[]> {
    const actor = requireAuthActor(ctx);
    const found = await findAppointment(ctx.pool, actor, appointmentId);
    if (!found) throw graphQLError(ERROR_CODES.NOT_FOUND, 'appointment not found');
    const { rows } = await ctx.pool.query<AppointmentEventModel>(
      `SELECT id::int AS id, appointment_id::int AS "appointmentId", kind::text AS kind,
              from_status::text AS "fromStatus", to_status::text AS "toStatus", actor_role AS "actorRole",
              is_late AS "isLate", is_strike AS "isStrike", reason, occurred_at AS "occurredAt"
         FROM appointment_events
        WHERE appointment_id = $1
        ORDER BY occurred_at, id`,
      [appointmentId],
    );
    return rows;
  }

  @Mutation(() => AppointmentModel, { description: 'Places a 10-minute checkout hold for the signed-in patient.' })
  async holdSlot(
    @Context() ctx: RequestContext,
    @Args('input', { type: () => HoldSlotInput }) input: HoldSlotInput,
  ): Promise<Appointment> {
    if (ctx.actor.role === 'receptionist') {
      if (input.patientId === undefined) {
        throw graphQLError(ERROR_CODES.VALIDATION_FAILED, 'patientId is required for registrar booking');
      }
      if (input.clinicId !== ctx.actor.clinicId) {
        throw graphQLError(ERROR_CODES.FORBIDDEN, 'not allowed for this clinic');
      }
      return ctx.booking.hold({
        patientId: input.patientId,
        doctorId: input.doctorId,
        clinicId: input.clinicId,
        serviceId: input.serviceId,
        startsAt: input.startsAt,
        channel: 'front_desk',
        actor: ctx.actor,
      });
    }
    const actor = requirePatient(ctx);
    return ctx.booking.hold({
      patientId: actor.patientId,
      doctorId: input.doctorId,
      clinicId: input.clinicId,
      serviceId: input.serviceId,
      startsAt: input.startsAt,
      channel: 'online',
      actor,
    });
  }

  @Mutation(() => AppointmentModel)
  async confirmAppointment(
    @Context() ctx: RequestContext,
    @Args('appointmentId', { type: () => Int }) appointmentId: number,
    @Args('idempotencyKey', { type: () => String }) idempotencyKey: string,
  ): Promise<Appointment> {
    if (ctx.actor.role === 'receptionist') {
      const { rows } = await ctx.pool.query<{ patient_id: number; clinic_id: number }>(
        `SELECT patient_id::int AS patient_id, clinic_id::int AS clinic_id FROM appointments WHERE id = $1`,
        [appointmentId],
      );
      const appt = rows[0];
      if (!appt || appt.clinic_id !== ctx.actor.clinicId) {
        throw graphQLError(ERROR_CODES.HOLD_NOT_FOUND, 'hold not found');
      }
      return ctx.booking.confirm({
        appointmentId,
        patientId: appt.patient_id,
        idempotencyKey: validateIdempotencyKey(idempotencyKey),
        actor: ctx.actor,
      });
    }
    const actor = requirePatient(ctx);
    return ctx.booking.confirm({
      appointmentId,
      patientId: actor.patientId,
      idempotencyKey: validateIdempotencyKey(idempotencyKey),
      actor,
    });
  }

  @Mutation(() => AppointmentModel, { description: 'Cancels a booked or held visit. Patient: own; registrar: own clinic.' })
  async cancelAppointment(
    @Context() ctx: RequestContext,
    @Args('appointmentId', { type: () => Int }) appointmentId: number,
    @Args('reason', { type: () => String }) reason: string,
  ): Promise<Appointment> {
    const actor: AuthActor = requireAuthActor(ctx);
    const result = await asNotFoundWhenForeign(() => ctx.booking.cancel({ appointmentId, actor, reason }));
    return result.appointment;
  }

  @Mutation(() => AppointmentModel)
  async rescheduleAppointment(
    @Context() ctx: RequestContext,
    @Args('appointmentId', { type: () => Int }) appointmentId: number,
    @Args('expectedVersion', { type: () => Int }) expectedVersion: number,
    @Args('newStartsAt', { type: () => Date }) newStartsAt: Date,
  ): Promise<Appointment> {
    const actor: AuthActor = requireAuthActor(ctx);
    const result = await asNotFoundWhenForeign(() =>
      ctx.booking.reschedule({ appointmentId, expectedVersion, newStartsAt, actor }),
    );
    return result.appointment;
  }

  @Mutation(() => Int, { description: 'Joins the waitlist; returns the entry id.' })
  joinWaitlist(
    @Context() ctx: RequestContext,
    @Args('input', { type: () => JoinWaitlistInput }) input: JoinWaitlistInput,
  ): Promise<number> {
    const actor = requirePatient(ctx);
    return ctx.waitlist.join({
      patientId: actor.patientId,
      doctorId: input.doctorId,
      clinicId: input.clinicId,
      serviceId: input.serviceId,
      dateFrom: validateDate(input.dateFrom, 'dateFrom'),
      dateTo: validateDate(input.dateTo, 'dateTo'),
      channel: 'online',
      actor,
    });
  }

  @Mutation(() => Boolean)
  async leaveWaitlist(
    @Context() ctx: RequestContext,
    @Args('entryId', { type: () => Int }) entryId: number,
  ): Promise<boolean> {
    const actor = requirePatient(ctx);
    await ctx.waitlist.leave({ entryId, patientId: actor.patientId });
    return true;
  }

  @Mutation(() => AppointmentModel)
  async acceptOffer(
    @Context() ctx: RequestContext,
    @Args('offerId', { type: () => Int }) offerId: number,
    @Args('idempotencyKey', { type: () => String }) idempotencyKey: string,
  ): Promise<Appointment> {
    const actor = requirePatient(ctx);
    return ctx.waitlist.accept({
      offerId,
      patientId: actor.patientId,
      idempotencyKey: validateIdempotencyKey(idempotencyKey),
      actor,
    });
  }

  @Mutation(() => Boolean)
  async declineOffer(
    @Context() ctx: RequestContext,
    @Args('offerId', { type: () => Int }) offerId: number,
  ): Promise<boolean> {
    const actor = requirePatient(ctx);
    await ctx.waitlist.decline({ offerId, patientId: actor.patientId });
    return true;
  }

  @Mutation(() => AppointmentModel, { description: 'Registrar or doctor moves a visit to checked_in, no_show or completed.' })
  async changeAppointmentStatus(
    @Context() ctx: RequestContext,
    @Args('appointmentId', { type: () => Int }) appointmentId: number,
    @Args('to', { type: () => String }) to: string,
  ): Promise<Appointment> {
    const actor = requireAuthActor(ctx);
    if (actor.role === 'patient') throw graphQLError(ERROR_CODES.FORBIDDEN, 'staff only');
    if (!isStaffStatus(to)) throw graphQLError(ERROR_CODES.VALIDATION_FAILED, 'unknown target status');
    return asNotFoundWhenForeign(() => ctx.booking.changeStatus({ appointmentId, to, actor }));
  }

  @Mutation(() => SickLeaveResultModel, { description: 'Registrar marks a doctor sick for a clinic day.' })
  async markSickLeave(
    @Context() ctx: RequestContext,
    @Args('doctorId', { type: () => Int }) doctorId: number,
    @Args('clinicId', { type: () => Int }) clinicId: number,
    @Args('date', { type: () => String }) date: string,
  ): Promise<SickLeaveResultModel> {
    const actor = requireAuthActor(ctx);
    if (actor.role !== 'receptionist') throw graphQLError(ERROR_CODES.FORBIDDEN, 'registrars only');
    return ctx.booking.markSickLeave({ doctorId, clinicId, date: validateDate(date, 'date'), actor });
  }

  @Mutation(() => Boolean, { description: 'Registrar updates a doctor weekly schedule template in their clinic.' })
  async upsertScheduleTemplate(
    @Context() ctx: RequestContext,
    @Args('input', { type: () => UpsertScheduleTemplateInput }) input: UpsertScheduleTemplateInput,
  ): Promise<boolean> {
    const actor = requireAuthActor(ctx);
    if (actor.role !== 'receptionist') throw graphQLError(ERROR_CODES.FORBIDDEN, 'registrars only');
    return ctx.booking.upsertScheduleTemplate({
      doctorId: input.doctorId,
      clinicId: input.clinicId,
      weekday: input.weekday,
      workStart: input.workStart,
      workEnd: input.workEnd,
      breakStart: input.breakStart ?? null,
      breakEnd: input.breakEnd ?? null,
      ...(input.effectiveFrom !== undefined ? { effectiveFrom: input.effectiveFrom } : {}),
      actor,
    });
  }

  @Mutation(() => Boolean, { description: 'Registrar sets a date exception (vacation, sick, extra_day) for a doctor.' })
  async upsertScheduleException(
    @Context() ctx: RequestContext,
    @Args('input', { type: () => UpsertScheduleExceptionInput }) input: UpsertScheduleExceptionInput,
  ): Promise<boolean> {
    const actor = requireAuthActor(ctx);
    if (actor.role !== 'receptionist') throw graphQLError(ERROR_CODES.FORBIDDEN, 'registrars only');
    if (input.kind !== 'day_off' && input.kind !== 'extra_day') {
      throw graphQLError(ERROR_CODES.VALIDATION_FAILED, 'kind must be day_off or extra_day');
    }
    if (input.reason !== 'vacation' && input.reason !== 'sick' && input.reason !== 'other') {
      throw graphQLError(ERROR_CODES.VALIDATION_FAILED, 'reason must be vacation, sick or other');
    }
    return ctx.booking.upsertScheduleException({
      doctorId: input.doctorId,
      clinicId: input.clinicId,
      date: validateDate(input.date, 'date'),
      kind: input.kind,
      reason: input.reason,
      workStart: input.workStart ?? null,
      workEnd: input.workEnd ?? null,
      breakStart: input.breakStart ?? null,
      breakEnd: input.breakEnd ?? null,
      actor,
    });
  }
}
