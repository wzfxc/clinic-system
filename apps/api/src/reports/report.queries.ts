/**
 * Manager report SQL. Window = whole clinic-local days [from, to] (inclusive), derived from the injected Clock by the caller.
 * Definitions (docs/analysis/00-decisions.md, stage 9):
 *  - load % = minutes of non-cancelled appointments / scheduled minutes (templates minus day-offs plus extra days, breaks excluded);
 *  - no-show share = no_show / (completed + no_show);
 *  - late-cancel share = cancelled appointments with a late `cancelled` event (<= 24 h before start, R1) / user-side cancellations
 *    (system reasons such as sick_leave or hold_expired are excluded);
 *  - accepted offers = accepted waitlist offers whose held appointment falls in the window;
 *  - revenue = price of completed appointments, per service and currency (clinics use different currencies).
 */
import type { Pool } from 'pg';

const SYSTEM_CANCEL_REASONS = "('sick_leave','checkout_replaced','hold_expired','offer_expired','offer_declined')";

export const DOCTOR_REPORT_SQL = `
WITH days AS (
  SELECT d::date AS d FROM generate_series($1::date, $2::date, interval '1 day') AS d
), planned AS (
  SELECT t.doctor_id,
         extract(epoch FROM (t.work_end - t.work_start) - coalesce(t.break_end - t.break_start, interval '0')) / 60 AS minutes
    FROM days
    JOIN schedule_templates t ON t.weekday = extract(isodow FROM days.d) AND t.valid_during @> days.d
   WHERE NOT EXISTS (SELECT 1 FROM schedule_exceptions x
                      WHERE x.doctor_id = t.doctor_id AND x.clinic_id = t.clinic_id AND x.on_date = days.d)
  UNION ALL
  SELECT x.doctor_id,
         extract(epoch FROM (x.work_end - x.work_start) - coalesce(x.break_end - x.break_start, interval '0')) / 60
    FROM schedule_exceptions x
   WHERE x.kind = 'extra_day' AND x.on_date BETWEEN $1::date AND $2::date
), planned_by_doctor AS (
  SELECT doctor_id, sum(minutes)::bigint AS scheduled_minutes FROM planned GROUP BY doctor_id
), appt AS (
  SELECT doctor_id,
         count(*) FILTER (WHERE status = 'completed') AS completed,
         count(*) FILTER (WHERE status = 'no_show') AS no_show,
         count(*) FILTER (WHERE status = 'cancelled' AND coalesce(cancel_reason, '') NOT IN ${SYSTEM_CANCEL_REASONS}) AS cancelled,
         coalesce(sum(extract(epoch FROM ends_at - starts_at) / 60)
                  FILTER (WHERE status IN ('booked','checked_in','completed','no_show')), 0)::bigint AS booked_minutes
    FROM appointments
   WHERE local_date BETWEEN $1::date AND $2::date
   GROUP BY doctor_id
), late AS (
  SELECT a.doctor_id, count(*) AS n
    FROM appointment_events e JOIN appointments a ON a.id = e.appointment_id
   WHERE e.kind = 'cancelled' AND e.is_late AND a.local_date BETWEEN $1::date AND $2::date
   GROUP BY a.doctor_id
), offers AS (
  SELECT a.doctor_id, count(*) AS n
    FROM waitlist_offers o JOIN appointments a ON a.id = o.appointment_id
   WHERE o.status = 'accepted' AND a.local_date BETWEEN $1::date AND $2::date
   GROUP BY a.doctor_id
)
SELECT d.id AS doctor_id, dc.clinic_id,
       coalesce(p.scheduled_minutes, 0) AS scheduled_minutes,
       coalesce(a.booked_minutes, 0) AS booked_minutes,
       coalesce(a.completed, 0) AS completed, coalesce(a.no_show, 0) AS no_show,
       coalesce(a.cancelled, 0) AS cancelled, coalesce(l.n, 0) AS late_cancelled,
       coalesce(o.n, 0) AS accepted_offers
  FROM doctors d
  JOIN doctor_clinics dc ON dc.doctor_id = d.id
  LEFT JOIN planned_by_doctor p ON p.doctor_id = d.id
  LEFT JOIN appt a ON a.doctor_id = d.id
  LEFT JOIN late l ON l.doctor_id = d.id
  LEFT JOIN offers o ON o.doctor_id = d.id
 ORDER BY d.id`;

export const REVENUE_SQL = `
SELECT a.service_id, s.name AS service_name, a.currency, sum(a.price_minor)::float8 AS revenue_minor, count(*)::int AS appointments
  FROM appointments a JOIN services s ON s.id = a.service_id
 WHERE a.status = 'completed' AND a.local_date BETWEEN $1::date AND $2::date
 GROUP BY a.service_id, s.name, a.currency
 ORDER BY a.currency, revenue_minor DESC`;

export interface ReportCounts {
  scheduledMinutes: number;
  bookedMinutes: number;
  completed: number;
  noShow: number;
  cancelled: number;
  lateCancelled: number;
  acceptedOffers: number;
}

export interface ReportMetrics extends ReportCounts {
  loadPercent: number;
  noShowShare: number;
  lateCancelShare: number;
}

export interface DoctorReportRow extends ReportMetrics {
  doctorId: number;
  clinicId: number;
}

export interface ServiceRevenueRow {
  serviceId: number;
  serviceName: string;
  currency: string;
  revenueMinor: number;
  appointments: number;
}

export interface ReportData {
  fromDate: string;
  toDate: string;
  doctors: DoctorReportRow[];
  totals: ReportMetrics;
  revenue: ServiceRevenueRow[];
}

interface RawDoctorRow {
  doctor_id: string;
  clinic_id: string;
  scheduled_minutes: string;
  booked_minutes: string;
  completed: string;
  no_show: string;
  cancelled: string;
  late_cancelled: string;
  accepted_offers: string;
}

interface RawRevenueRow {
  service_id: string;
  service_name: string;
  currency: string;
  revenue_minor: number;
  appointments: number;
}

function share(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}

function withRatios(c: ReportCounts): ReportMetrics {
  return {
    ...c,
    loadPercent: share(c.bookedMinutes, c.scheduledMinutes) * 100,
    noShowShare: share(c.noShow, c.completed + c.noShow),
    lateCancelShare: share(c.lateCancelled, c.cancelled),
  };
}

function toRow(r: RawDoctorRow): DoctorReportRow {
  const counts: ReportCounts = {
    scheduledMinutes: Number(r.scheduled_minutes),
    bookedMinutes: Number(r.booked_minutes),
    completed: Number(r.completed),
    noShow: Number(r.no_show),
    cancelled: Number(r.cancelled),
    lateCancelled: Number(r.late_cancelled),
    acceptedOffers: Number(r.accepted_offers),
  };
  return { doctorId: Number(r.doctor_id), clinicId: Number(r.clinic_id), ...withRatios(counts) };
}

function sumTotals(rows: readonly DoctorReportRow[]): ReportMetrics {
  const sum = (pick: (r: DoctorReportRow) => number): number => rows.reduce((acc, r) => acc + pick(r), 0);
  return withRatios({
    scheduledMinutes: sum((r) => r.scheduledMinutes),
    bookedMinutes: sum((r) => r.bookedMinutes),
    completed: sum((r) => r.completed),
    noShow: sum((r) => r.noShow),
    cancelled: sum((r) => r.cancelled),
    lateCancelled: sum((r) => r.lateCancelled),
    acceptedOffers: sum((r) => r.acceptedOffers),
  });
}

export async function loadReport(pool: Pool, fromDate: string, toDate: string): Promise<ReportData> {
  const doctors = await pool.query<RawDoctorRow>(DOCTOR_REPORT_SQL, [fromDate, toDate]);
  const revenue = await pool.query<RawRevenueRow>(REVENUE_SQL, [fromDate, toDate]);
  const rows = doctors.rows.map(toRow);
  return {
    fromDate,
    toDate,
    doctors: rows,
    totals: sumTotals(rows),
    revenue: revenue.rows.map((r) => ({
      serviceId: Number(r.service_id),
      serviceName: r.service_name,
      currency: r.currency,
      revenueMinor: r.revenue_minor,
      appointments: r.appointments,
    })),
  };
}
