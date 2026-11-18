/**
 * Subscription slotsChanged(clinicId). Permission is checked when the subscription starts and again on every
 * event against the session as it is now, so a revoked session stops receiving at once.
 */
import { Args, Context, Field, Int, ObjectType, Resolver, Subscription } from '@nestjs/graphql';
import { ERROR_CODES } from '@clinic/shared';
import type { RequestActor } from '../auth/actor.js';
import type { RequestContext } from '../graphql/context.js';
import { graphQLError } from '../graphql/guards.js';
import { SlotsEvents, type SlotsChangedEvent } from './slots-events.service.js';

@ObjectType('SlotsChanged')
export class SlotsChangedModel {
  @Field(() => Int)
  clinicId!: number;

  @Field(() => Int)
  doctorId!: number;

  @Field(() => Date)
  startsAt!: Date;
}

/** Patients and doctors see any clinic's slots; a registrar only their own clinic; anonymous and managers none. */
export function canSeeSlots(actor: RequestActor, clinicId: number): boolean {
  switch (actor.role) {
    case 'patient':
    case 'doctor':
      return true;
    case 'receptionist':
      return actor.clinicId === clinicId;
    default:
      return false;
  }
}

async function isDeliverable(event: SlotsChangedEvent, clinicId: number, ctx: RequestContext): Promise<boolean> {
  if (event.clinicId !== clinicId) return false;
  const actor = await ctx.sessions.resolveActor(ctx.sessionToken);
  return canSeeSlots(actor, clinicId);
}

@Resolver()
export class SlotsResolver {
  constructor(private readonly events: SlotsEvents) {}

  @Subscription(() => SlotsChangedModel, {
    name: 'slotsChanged',
    description: 'Free-slot changes of a clinic. Carries no patient or appointment ids; refetch the slot grid.',
    filter: (payload: SlotsChangedEvent, args: { clinicId: number }, ctx: RequestContext) =>
      isDeliverable(payload, args.clinicId, ctx),
    resolve: (payload: SlotsChangedEvent) => payload,
  })
  slotsChanged(
    @Context() ctx: RequestContext,
    @Args('clinicId', { type: () => Int }) clinicId: number,
  ): AsyncIterableIterator<SlotsChangedEvent> {
    if (ctx.actor.role === 'anon') throw graphQLError(ERROR_CODES.UNAUTHENTICATED, 'sign in required');
    if (!canSeeSlots(ctx.actor, clinicId)) throw graphQLError(ERROR_CODES.FORBIDDEN, 'not allowed for this clinic');
    return this.events.iterator();
  }
}
