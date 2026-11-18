import { Args, Context, Int, Query, Resolver } from '@nestjs/graphql';
import type { RequestContext } from '../graphql/context.js';
import { requireAuthActor } from '../graphql/guards.js';
import { CityFreeSlotModel } from './free-slots.models.js';
import { findCityFreeSlots, type CityFreeSlot } from './free-slots.queries.js';

@Resolver()
export class FreeSlotsResolver {
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
