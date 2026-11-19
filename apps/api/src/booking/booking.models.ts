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

  @Field(() => Int, { nullable: true })
  patientId?: number;
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

@ObjectType('WaitlistOffer')
export class WaitlistOfferModel {
  @Field(() => Int)
  id!: number;

  @Field(() => Int)
  entryId!: number;

  @Field(() => Int)
  appointmentId!: number;

  @Field(() => Int)
  clinicId!: number;

  @Field(() => Int)
  doctorId!: number;

  @Field(() => Int)
  serviceId!: number;

  @Field(() => Date)
  startsAt!: Date;

  @Field(() => Date)
  endsAt!: Date;

  @Field(() => Date)
  expiresAt!: Date;

  @Field(() => String)
  status!: string;
}

@InputType('UpsertScheduleTemplateInput')
export class UpsertScheduleTemplateInput {
  @Field(() => Int)
  doctorId!: number;

  @Field(() => Int)
  clinicId!: number;

  @Field(() => Int)
  weekday!: number;

  @Field(() => String)
  workStart!: string;

  @Field(() => String)
  workEnd!: string;

  @Field(() => String, { nullable: true })
  breakStart?: string;

  @Field(() => String, { nullable: true })
  breakEnd?: string;

  @Field(() => String, { nullable: true })
  effectiveFrom?: string;
}

@InputType('UpsertScheduleExceptionInput')
export class UpsertScheduleExceptionInput {
  @Field(() => Int)
  doctorId!: number;

  @Field(() => Int)
  clinicId!: number;

  @Field(() => String)
  date!: string;

  @Field(() => String)
  kind!: string;

  @Field(() => String)
  reason!: string;

  @Field(() => String, { nullable: true })
  workStart?: string;

  @Field(() => String, { nullable: true })
  workEnd?: string;

  @Field(() => String, { nullable: true })
  breakStart?: string;

  @Field(() => String, { nullable: true })
  breakEnd?: string;
}

@ObjectType('InAppReminder')
export class InAppReminderModel {
  @Field(() => Int)
  id!: number;

  @Field(() => Int)
  appointmentId!: number;

  @Field(() => String)
  kind!: string;

  @Field(() => Date)
  dueAt!: Date;

  @Field(() => Date)
  startsAt!: Date;

  @Field(() => Int)
  clinicId!: number;

  @Field(() => Int)
  doctorId!: number;
}

@ObjectType('AppointmentEvent')
export class AppointmentEventModel {
  @Field(() => Int)
  id!: number;

  @Field(() => Int)
  appointmentId!: number;

  @Field(() => String)
  kind!: string;

  @Field(() => String, { nullable: true })
  fromStatus?: string | null;

  @Field(() => String, { nullable: true })
  toStatus?: string | null;

  @Field(() => String, { nullable: true })
  actorRole?: string | null;

  @Field(() => Boolean)
  isLate!: boolean;

  @Field(() => Boolean)
  isStrike!: boolean;

  @Field(() => String, { nullable: true })
  reason?: string | null;

  @Field(() => Date)
  occurredAt!: Date;
}

@ObjectType('WaitlistEntry')
export class WaitlistEntryModel {
  @Field(() => Int)
  id!: number;

  @Field(() => Int)
  clinicId!: number;

  @Field(() => Int)
  doctorId!: number;

  @Field(() => Int)
  serviceId!: number;

  @Field(() => String)
  dateFrom!: string;

  @Field(() => String)
  dateTo!: string;

  @Field(() => Int)
  priority!: number;

  @Field(() => String)
  status!: string;
}
