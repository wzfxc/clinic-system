/** GraphQL inputs and results for booking and waitlist mutations. Authorisation lives in the resolver and the domain. */
import { Field, InputType, Int, ObjectType } from '@nestjs/graphql';

@InputType('HoldSlotInput')
export class HoldSlotInput {
  @Field(() => Int)
  doctorId!: number;

  @Field(() => Int)
  clinicId!: number;

  @Field(() => Int)
  serviceId!: number;

  @Field(() => Date)
  startsAt!: Date;
}

@InputType('JoinWaitlistInput')
export class JoinWaitlistInput {
  @Field(() => Int)
  doctorId!: number;

  @Field(() => Int)
  clinicId!: number;

  @Field(() => Int)
  serviceId!: number;

  /** Clinic calendar dates, YYYY-MM-DD. */
  @Field(() => String)
  dateFrom!: string;

  @Field(() => String)
  dateTo!: string;
}

@ObjectType('SickLeavePayload')
export class SickLeaveResultModel {
  /** False when the day was already closed: nothing was cancelled or queued. */
  @Field(() => Boolean)
  applied!: boolean;

  @Field(() => [Int])
  cancelledAppointmentIds!: number[];
}
