/**
 * Booking and waitlist mutations, wired to BookingService and WaitlistService (docs/analysis/06 section 3).
 * Patients act on their own objects only; anything of someone else's is NOT_FOUND, the same as a missing id.
 * Domain functions enforce the rules again, so this layer only decides who may call and what they may name.
 */
import { Args, Context, Int, Mutation, Resolver } from '@nestjs/graphql';
import { ERROR_CODES, type Appointment, type AuthActor } from '@clinic/shared';
import type { RequestContext } from '../graphql/context.js';
import { isBookingError } from '../graphql/errors.js';
import { graphQLError, requireAuthActor, requirePatient } from '../graphql/guards.js';
import { AppointmentModel } from '../graphql/models.js';
import { HoldSlotInput, JoinWaitlistInput, SickLeaveResultModel } from './booking.models.js';

const STAFF_STATUSES = ['checked_in', 'no_show', 'completed'] as const;
type StaffStatus = (typeof STAFF_STATUSES)[number];
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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
  if (!DATE_PATTERN.test(value)) {
    throw graphQLError(ERROR_CODES.VALIDATION_FAILED, `${field} must be YYYY-MM-DD`);
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
  @Mutation(() => AppointmentModel, { description: 'Places a 15-minute checkout hold for the signed-in patient.' })
  async holdSlot(
    @Context() ctx: RequestContext,
    @Args('input', { type: () => HoldSlotInput }) input: HoldSlotInput,
  ): Promise<Appointment> {
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
}
