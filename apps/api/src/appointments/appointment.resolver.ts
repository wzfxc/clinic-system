/**
 * Appointment reads and their relations. Relations go through per-request DataLoaders (a fixed number of
 * SQL statements per list). Visibility is decided by the scoped SQL in appointment.queries.ts.
 */
import { Args, Context, Field, Int, InputType, Parent, Query, ResolveField, Resolver } from '@nestjs/graphql';
import { ERROR_CODES, type Appointment } from '@clinic/shared';
import type { RequestContext } from '../graphql/context.js';
import { graphQLError, pageSize, requireAuthActor, requirePatient } from '../graphql/guards.js';
import { AppointmentModel, ClinicModel, DoctorModel, PatientModel, ServiceModel } from '../graphql/models.js';
import { findAppointment, listAppointments } from './appointment.queries.js';

@InputType('AppointmentFilter')
export class AppointmentFilterInput {
  @Field(() => Int, { nullable: true })
  patientId?: number;

  @Field(() => Int, { nullable: true })
  doctorId?: number;

  @Field(() => Int, { nullable: true })
  clinicId?: number;
}

@Resolver(() => AppointmentModel)
export class AppointmentResolver {
  @Query(() => [AppointmentModel], { description: 'The signed-in patient\'s own appointments.' })
  async myAppointments(
    @Context() ctx: RequestContext,
    @Args('first', { type: () => Int, nullable: true }) first?: number,
  ): Promise<Appointment[]> {
    const actor = requirePatient(ctx);
    return listAppointments(ctx.pool, actor, {}, pageSize(first));
  }

  @Query(() => [AppointmentModel], { description: 'Appointments visible to the actor, filtered within that scope.' })
  async appointments(
    @Context() ctx: RequestContext,
    @Args('filter', { type: () => AppointmentFilterInput, nullable: true }) filter?: AppointmentFilterInput,
    @Args('first', { type: () => Int, nullable: true }) first?: number,
  ): Promise<Appointment[]> {
    const actor = requireAuthActor(ctx);
    return listAppointments(ctx.pool, actor, filter ?? {}, pageSize(first));
  }

  /** Someone else's id gets the same NOT_FOUND as a missing one, so existence is not disclosed. */
  @Query(() => AppointmentModel, { nullable: true })
  async appointment(@Context() ctx: RequestContext, @Args('id', { type: () => Int }) id: number): Promise<Appointment> {
    const actor = requireAuthActor(ctx);
    const found = await findAppointment(ctx.pool, actor, id);
    if (!found) throw graphQLError(ERROR_CODES.NOT_FOUND, 'appointment not found');
    return found;
  }

  @ResolveField(() => DoctorModel)
  doctor(@Parent() appointment: Appointment, @Context() ctx: RequestContext): Promise<DoctorModel | null> {
    return ctx.loaders.doctors.load(appointment.doctorId);
  }

  @ResolveField(() => ClinicModel)
  clinic(@Parent() appointment: Appointment, @Context() ctx: RequestContext): Promise<ClinicModel | null> {
    return ctx.loaders.clinics.load(appointment.clinicId);
  }

  @ResolveField(() => ServiceModel)
  service(@Parent() appointment: Appointment, @Context() ctx: RequestContext): Promise<ServiceModel | null> {
    return ctx.loaders.services.load(appointment.serviceId);
  }

  @ResolveField(() => PatientModel)
  patient(@Parent() appointment: Appointment, @Context() ctx: RequestContext): Promise<PatientModel | null> {
    return ctx.loaders.patients.load(appointment.patientId);
  }
}
