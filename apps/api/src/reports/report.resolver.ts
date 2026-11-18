/** Manager-only report over the last 90 clinic-local days (docs/analysis/06: others get FORBIDDEN, anonymous UNAUTHENTICATED). */
import { Context, Query, Resolver } from '@nestjs/graphql';
import { ERROR_CODES } from '@clinic/shared';
import type { RequestContext } from '../graphql/context.js';
import { graphQLError } from '../graphql/guards.js';
import { ReportModel } from './report.models.js';
import { loadReport, type ReportData } from './report.queries.js';

export const REPORT_DAYS = 90;
const MS_PER_DAY = 86_400_000;

@Resolver()
export class ReportResolver {
  @Query(() => ReportModel, { description: 'Manager report over the 90 complete days before today (Clock, UTC date).' })
  async managerReport(@Context() ctx: RequestContext): Promise<ReportData> {
    if (ctx.actor.role === 'anon') throw graphQLError(ERROR_CODES.UNAUTHENTICATED, 'sign in required');
    if (ctx.actor.role !== 'manager') throw graphQLError(ERROR_CODES.FORBIDDEN, 'managers only');
    const todayMs = Math.floor(ctx.clock.now().getTime() / MS_PER_DAY) * MS_PER_DAY;
    const isoDate = (offsetDays: number): string => new Date(todayMs - offsetDays * MS_PER_DAY).toISOString().slice(0, 10);
    return loadReport(ctx.pool, isoDate(REPORT_DAYS), isoDate(1));
  }
}
