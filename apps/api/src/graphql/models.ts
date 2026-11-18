/** Code-first GraphQL object types. They are the schema source; clients get their types from codegen. */
import { Field, Int, ObjectType } from '@nestjs/graphql';

@ObjectType('Clinic')
export class ClinicModel {
  @Field(() => Int)
  id!: number;

  @Field(() => String)
  city!: string;

  @Field(() => String)
  name!: string;

  @Field(() => String)
  timezone!: string;

  @Field(() => String)
  currency!: string;
}

@ObjectType('Service')
export class ServiceModel {
  @Field(() => Int)
  id!: number;

  @Field(() => String)
  name!: string;

  @Field(() => Int)
  durationMinutes!: number;

  @Field(() => Boolean)
  usesUltrasoundRoom!: boolean;
}

@ObjectType('Doctor')
export class DoctorModel {
  @Field(() => Int)
  id!: number;

  @Field(() => String)
  specialty!: string;
}

/** Personal data: only returned to the patient themselves, a doctor of the visit, or the registrar of its clinic. */
@ObjectType('Patient')
export class PatientModel {
  @Field(() => Int)
  id!: number;

  @Field(() => String)
  fullName!: string;

  @Field(() => String, { nullable: true })
  phone!: string | null;

  @Field(() => String, { nullable: true })
  email!: string | null;
}

@ObjectType('Appointment')
export class AppointmentModel {
  @Field(() => Int)
  id!: number;

  @Field(() => String)
  status!: string;

  @Field(() => Date)
  startsAt!: Date;

  @Field(() => Date)
  endsAt!: Date;

  @Field(() => String)
  localDate!: string;

  @Field(() => Int)
  priceMinor!: number;

  @Field(() => String)
  currency!: string;

  @Field(() => Int)
  timeVersion!: number;
}

@ObjectType('Me')
export class MeModel {
  @Field(() => Int)
  userId!: number;

  @Field(() => String)
  role!: string;
}
