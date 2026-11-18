/** GraphQL shapes of the manager report; numbers are computed in report.queries.ts. */
import { Field, Float, Int, ObjectType } from '@nestjs/graphql';

@ObjectType('ReportMetrics')
export class ReportMetricsModel {
  @Field(() => Int)
  scheduledMinutes!: number;

  @Field(() => Int)
  bookedMinutes!: number;

  @Field(() => Float, { description: 'Booked minutes over scheduled minutes, 0 to 100.' })
  loadPercent!: number;

  @Field(() => Int)
  completed!: number;

  @Field(() => Int)
  noShow!: number;

  @Field(() => Float, { description: 'no_show / (completed + no_show), 0 to 1.' })
  noShowShare!: number;

  @Field(() => Int, { description: 'User-side cancellations (system reasons excluded).' })
  cancelled!: number;

  @Field(() => Int)
  lateCancelled!: number;

  @Field(() => Float, { description: 'Late cancellations (24 h or less before start) over cancellations, 0 to 1.' })
  lateCancelShare!: number;

  @Field(() => Int)
  acceptedOffers!: number;
}

@ObjectType('DoctorReport')
export class DoctorReportModel extends ReportMetricsModel {
  @Field(() => Int)
  doctorId!: number;

  @Field(() => Int)
  clinicId!: number;
}

@ObjectType('ServiceRevenue')
export class ServiceRevenueModel {
  @Field(() => Int)
  serviceId!: number;

  @Field(() => String)
  serviceName!: string;

  @Field(() => String)
  currency!: string;

  @Field(() => Float, { description: 'Minor currency units (kopecks, groszy) of completed appointments.' })
  revenueMinor!: number;

  @Field(() => Int)
  appointments!: number;
}

@ObjectType('Report')
export class ReportModel {
  @Field(() => String)
  fromDate!: string;

  @Field(() => String)
  toDate!: string;

  @Field(() => ReportMetricsModel)
  totals!: ReportMetricsModel;

  @Field(() => [DoctorReportModel])
  doctors!: DoctorReportModel[];

  @Field(() => [ServiceRevenueModel])
  revenue!: ServiceRevenueModel[];
}
