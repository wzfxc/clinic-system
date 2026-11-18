import { Args, Context, Int, Query, Resolver } from '@nestjs/graphql';
import type { RequestContext } from '../graphql/context.js';
import { requireAuthActor } from '../graphql/guards.js';
import { ClinicModel, DoctorModel, ServiceModel } from '../graphql/models.js';
import { CityFreeSlotModel } from './free-slots.models.js';
import { findCityFreeSlots, type CityFreeSlot } from './free-slots.queries.js';

@Resolver()
export class FreeSlotsResolver {
  @Query(() => [ClinicModel], { description: 'All clinics in the network.' })
  async clinics(@Context() ctx: RequestContext): Promise<ClinicModel[]> {
    const { rows } = await ctx.pool.query<ClinicModel>(
      `SELECT id::int AS id, city, name, timezone, trim(currency) AS currency FROM clinics ORDER BY id`,
    );
    return rows;
  }

  @Query(() => [ServiceModel], { description: 'All services offered across the network.' })
  async services(@Context() ctx: RequestContext): Promise<ServiceModel[]> {
    const { rows } = await ctx.pool.query<ServiceModel>(
      `SELECT id::int AS id, name, duration_minutes AS "durationMinutes", uses_ultrasound_room AS "usesUltrasoundRoom"
         FROM services ORDER BY id`,
    );
    return rows;
  }

  @Query(() => [DoctorModel], { description: 'Doctors, optionally filtered by clinic.' })
  async doctors(
    @Context() ctx: RequestContext,
    @Args('clinicId', { type: () => Int, nullable: true }) clinicId?: number,
  ): Promise<DoctorModel[]> {
    const { rows } = await ctx.pool.query<DoctorModel>(
      `SELECT d.id::int AS id, d.specialty FROM doctors d
        WHERE ($1::bigint IS NULL OR EXISTS (
          SELECT 1 FROM doctor_clinics dc WHERE dc.doctor_id = d.id AND dc.clinic_id = $1
        ))
        ORDER BY d.id`,
      [clinicId ?? null],
    );
    return rows;
  }

  @Query(() => [CityFreeSlotModel], {
    description: 'Free slots of a service across the doctors of a city for the next 14 days (clinic-local grid, R2 visibility).',
  })
  async findFreeSlots(
    @Context() ctx: RequestContext,
    @Args('city', { type: () => String }) city: string,
    @Args('serviceId', { type: () => Int }) serviceId: number,
  ): Promise<CityFreeSlot[]> {
    requireAuthActor(ctx);
    return findCityFreeSlots(ctx.pool, ctx.clock, city, serviceId);
  }
}
