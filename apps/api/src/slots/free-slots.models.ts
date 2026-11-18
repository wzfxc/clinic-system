import { Field, Int, ObjectType } from '@nestjs/graphql';

@ObjectType('CityFreeSlot')
export class CityFreeSlotModel {
  @Field(() => Int)
  clinicId!: number;

  @Field(() => Int)
  doctorId!: number;

  @Field(() => Date)
  startAt!: Date;

  @Field(() => Date)
  endAt!: Date;

  /** Clinic-local date and time, so the client needs no zone maths. */
  @Field(() => String)
  localDate!: string;

  @Field(() => String)
  localTime!: string;

  @Field(() => Int)
  utcOffsetMinutes!: number;
}
