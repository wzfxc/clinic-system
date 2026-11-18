/** Manager-only report over the last 90 clinic-local days (docs/analysis/06: others get FORBIDDEN, anonymous UNAUTHENTICATED). */
import { Args, Context, Query, Resolver } from '@nestjs/graphql';
import { ERROR_CODES, isValidIsoDate } from '@clinic/shared';
import type { RequestContext } from '../graphql/context.js';
import { graphQLError } from '../graphql/guards.js';
import { ReportModel } from './report.models.js';
import { loadReport, type ReportData } from './report.queries.js';

export const REPORT_DAYS = 90;
const MS_PER_DAY = 86_400_000;

@Resolver()
export class ReportResolver {
  @Query(() => ReportModel, { description: 'Manager report over the 90 complete days before today (Clock, UTC date).' })
  async managerReport(
    @Context() ctx: RequestContext,
    @Args('fromDate', { type: () => String, nullable: true }) fromDate?: string,
    @Args('toDate', { type: () => String, nullable: true }) toDate?: string,
  ): Promise<ReportData> {
    if (ctx.actor.role === 'anon') throw graphQLError(ERROR_CODES.UNAUTHENTICATED, 'sign in required');
    if (ctx.actor.role !== 'manager') throw graphQLError(ERROR_CODES.FORBIDDEN, 'managers only');
    if (fromDate !== undefined && fromDate !== '' && !isValidIsoDate(fromDate)) {
      throw graphQLError(ERROR_CODES.VALIDATION_FAILED, 'fromDate must be a valid YYYY-MM-DD date');
    }
    if (toDate !== undefined && toDate !== '' && !isValidIsoDate(toDate)) {
      throw graphQLError(ERROR_CODES.VALIDATION_FAILED, 'toDate must be a valid YYYY-MM-DD date');
    }
    const todayMs = Math.floor(ctx.clock.now().getTime() / MS_PER_DAY) * MS_PER_DAY;
    const isoDate = (offsetDays: number): string => new Date(todayMs - offsetDays * MS_PER_DAY).toISOString().slice(0, 10);
    const from = fromDate && fromDate !== '' ? fromDate : isoDate(REPORT_DAYS);
    const to = toDate && toDate !== '' ? toDate : isoDate(1);
    if (from > to) {
      throw graphQLError(ERROR_CODES.VALIDATION_FAILED, 'fromDate must not be after toDate');
    }
    return loadReport(ctx.pool, from, to);
  }
}
