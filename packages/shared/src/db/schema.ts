/**
 * Drizzle schema (docs/analysis/01-data-model-exclusion.md, 00-decisions.md D1-D3, R3).
 *
 * Not expressible here and therefore living in custom SQL migrations
 * (`drizzle-kit generate --custom`): EXCLUDE constraints, INCLUDE/partial GiST
 * indexes, triggers (patient limit, local_date, status transitions, history,
 * append-only events), the transitions table content and the clock helper.
 * Never use `drizzle-kit push`.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const id = () => bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity();
const fk = (name: string) => bigint(name, { mode: 'number' });
const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** Postgres `daterange`, used as the validity period of a schedule template. */
const daterange = customType<{ data: string }>({
  dataType() {
    return 'daterange';
  },
});

export const appointmentStatus = pgEnum('appointment_status', [
  'held',
  'booked',
  'checked_in',
  'completed',
  'no_show',
  'cancelled',
]);
export const holdKind = pgEnum('hold_kind', ['checkout', 'waitlist_offer']);
export const exceptionKind = pgEnum('exception_kind', ['day_off', 'extra_day']);
export const exceptionReason = pgEnum('exception_reason', ['vacation', 'sick', 'other']);
export const appointmentEventKind = pgEnum('appointment_event_kind', [
  'created',
  'held',
  'confirmed',
  'rescheduled',
  'cancelled',
  'checked_in',
  'completed',
  'no_show',
  'hold_expired',
  'offer_accepted',
]);

/** Minimal placeholder: roles and registrar clinic belong to block 6 and are added there. */
export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull().unique(),
  createdAt: tstz('created_at').notNull(),
});

export const clinics = pgTable(
  'clinics',
  {
    id: id(),
    city: text('city').notNull(),
    name: text('name').notNull(),
    timezone: text('timezone').notNull(),
    currency: char('currency', { length: 3 }).notNull(),
  },
  (t) => [check('clinics_currency_check', sql`${t.currency} IN ('UAH','PLN')`)],
);

export const services = pgTable(
  'services',
  {
    id: id(),
    name: text('name').notNull(),
    durationMinutes: integer('duration_minutes').notNull(),
    usesUltrasoundRoom: boolean('uses_ultrasound_room').notNull().default(false),
  },
  (t) => [
    check(
      'services_duration_check',
      sql`${t.durationMinutes} BETWEEN 15 AND 90 AND ${t.durationMinutes} % 15 = 0`,
    ),
  ],
);

export const clinicServices = pgTable(
  'clinic_services',
  {
    clinicId: fk('clinic_id').notNull().references(() => clinics.id),
    serviceId: fk('service_id').notNull().references(() => services.id),
    priceMinor: bigint('price_minor', { mode: 'number' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.clinicId, t.serviceId] }),
    index('clinic_services_service_idx').on(t.serviceId),
    check('clinic_services_price_check', sql`${t.priceMinor} >= 0`),
  ],
);

export const doctors = pgTable('doctors', {
  id: id(),
  userId: fk('user_id').unique().references(() => users.id),
  specialty: text('specialty').notNull(),
});

export const doctorClinics = pgTable(
  'doctor_clinics',
  {
    doctorId: fk('doctor_id').notNull().references(() => doctors.id),
    clinicId: fk('clinic_id').notNull().references(() => clinics.id),
  },
  (t) => [primaryKey({ columns: [t.doctorId, t.clinicId] }), index('doctor_clinics_clinic_idx').on(t.clinicId)],
);

export const doctorServices = pgTable(
  'doctor_services',
  {
    doctorId: fk('doctor_id').notNull().references(() => doctors.id),
    serviceId: fk('service_id').notNull().references(() => services.id),
  },
  (t) => [primaryKey({ columns: [t.doctorId, t.serviceId] }), index('doctor_services_service_idx').on(t.serviceId)],
);

export const patients = pgTable('patients', {
  id: id(),
  userId: fk('user_id').unique().references(() => users.id),
  fullName: text('full_name').notNull(),
  phone: text('phone'),
  email: text('email'),
  onlineBookingBlockedUntil: tstz('online_booking_blocked_until'),
});

export const scheduleTemplates = pgTable(
  'schedule_templates',
  {
    id: id(),
    doctorId: fk('doctor_id').notNull(),
    clinicId: fk('clinic_id').notNull(),
    weekday: smallint('weekday').notNull(),
    workStart: time('work_start').notNull(),
    workEnd: time('work_end').notNull(),
    breakStart: time('break_start'),
    breakEnd: time('break_end'),
    validDuring: daterange('valid_during').notNull().default(sql`daterange(NULL, NULL, '[)')`),
  },
  (t) => [
    foreignKey({
      name: 'schedule_templates_doctor_clinic_fk',
      columns: [t.doctorId, t.clinicId],
      foreignColumns: [doctorClinics.doctorId, doctorClinics.clinicId],
    }),
    check('schedule_templates_weekday_check', sql`${t.weekday} BETWEEN 1 AND 7`),
    check('schedule_templates_work_check', sql`${t.workEnd} > ${t.workStart}`),
    check('schedule_templates_break_pair_check', sql`(${t.breakStart} IS NULL) = (${t.breakEnd} IS NULL)`),
    check(
      'schedule_templates_break_range_check',
      sql`${t.breakStart} IS NULL OR (${t.breakStart} >= ${t.workStart} AND ${t.breakEnd} > ${t.breakStart} AND ${t.breakEnd} <= ${t.workEnd})`,
    ),
  ],
);

export const scheduleExceptions = pgTable(
  'schedule_exceptions',
  {
    id: id(),
    doctorId: fk('doctor_id').notNull().references(() => doctors.id),
    onDate: date('on_date', { mode: 'string' }).notNull(),
    kind: exceptionKind('kind').notNull(),
    reason: exceptionReason('reason').notNull(),
    clinicId: fk('clinic_id').notNull(),
    workStart: time('work_start'),
    workEnd: time('work_end'),
    breakStart: time('break_start'),
    breakEnd: time('break_end'),
    createdBy: fk('created_by'),
    createdAt: tstz('created_at').notNull(),
  },
  (t) => [
    foreignKey({
      name: 'schedule_exceptions_doctor_clinic_fk',
      columns: [t.doctorId, t.clinicId],
      foreignColumns: [doctorClinics.doctorId, doctorClinics.clinicId],
    }),
    // One exception per doctor, clinic and date, regardless of kind (R3).
    unique('schedule_exceptions_uq').on(t.doctorId, t.clinicId, t.onDate),
    check(
      'schedule_exceptions_extra_day_check',
      sql`(${t.kind} = 'extra_day') = (${t.workStart} IS NOT NULL AND ${t.workEnd} > ${t.workStart})`,
    ),
    check(
      'schedule_exceptions_day_off_check',
      sql`${t.kind} = 'extra_day' OR (${t.workStart} IS NULL AND ${t.workEnd} IS NULL AND ${t.breakStart} IS NULL AND ${t.breakEnd} IS NULL)`,
    ),
  ],
);

export const appointments = pgTable(
  'appointments',
  {
    id: id(),
    clinicId: fk('clinic_id').notNull(),
    doctorId: fk('doctor_id').notNull(),
    patientId: fk('patient_id').notNull().references(() => patients.id),
    serviceId: fk('service_id').notNull(),
    status: appointmentStatus('status').notNull(),
    startsAt: tstz('starts_at').notNull(),
    endsAt: tstz('ends_at').notNull(),
    blockedUntil: tstz('blocked_until').notNull(),
    // Filled by the appointments_a_local_date trigger from clinics.timezone.
    localDate: date('local_date', { mode: 'string' }).notNull(),
    usesUltrasoundRoom: boolean('uses_ultrasound_room').notNull(),
    priceMinor: bigint('price_minor', { mode: 'number' }).notNull(),
    currency: char('currency', { length: 3 }).notNull(),
    holdKind: holdKind('hold_kind'),
    holdExpiresAt: tstz('hold_expires_at'),
    waitlistEntryId: fk('waitlist_entry_id'),
    cancelReason: text('cancel_reason'),
    createdAt: tstz('created_at').notNull(),
    updatedAt: tstz('updated_at').notNull(),
    timeVersion: integer('time_version').notNull().default(1),
  },
  (t) => [
    foreignKey({
      name: 'appointments_doctor_clinic_fk',
      columns: [t.doctorId, t.clinicId],
      foreignColumns: [doctorClinics.doctorId, doctorClinics.clinicId],
    }),
    foreignKey({
      name: 'appointments_doctor_service_fk',
      columns: [t.doctorId, t.serviceId],
      foreignColumns: [doctorServices.doctorId, doctorServices.serviceId],
    }),
    foreignKey({
      name: 'appointments_clinic_service_fk',
      columns: [t.clinicId, t.serviceId],
      foreignColumns: [clinicServices.clinicId, clinicServices.serviceId],
    }),
    check('appointments_price_check', sql`${t.priceMinor} >= 0`),
    check(
      'appointments_duration_check',
      sql`${t.endsAt} - ${t.startsAt} BETWEEN interval '15 minutes' AND interval '90 minutes'`,
    ),
    check('appointments_buffer_check', sql`${t.blockedUntil} = ${t.endsAt} + interval '5 minutes'`),
    check(
      'appointments_grid_check',
      sql`date_trunc('minute', ${t.startsAt}) = ${t.startsAt} AND extract(minute FROM ${t.startsAt} AT TIME ZONE 'UTC')::int % 15 = 0`,
    ),
    check(
      'appointments_hold_check',
      sql`(${t.status} = 'held') = (${t.holdKind} IS NOT NULL AND ${t.holdExpiresAt} IS NOT NULL)`,
    ),
    // Once per local day per doctor (D1: every status except cancelled counts).
    uniqueIndex('appt_patient_doctor_day_uq')
      .on(t.patientId, t.doctorId, t.localDate)
      .where(sql`${t.status} <> 'cancelled'`),
    index('appt_clinic_time').on(t.clinicId, t.startsAt),
    index('appt_patient_time').on(t.patientId, t.startsAt.desc()),
    index('appt_hold_expiry').on(t.holdExpiresAt).where(sql`${t.status} = 'held'`),
    index('appt_service').on(t.serviceId),
  ],
);

/** Allowed status moves, enforced by the appointments_c_status_transition trigger. */
export const appointmentStatusTransitions = pgTable(
  'appointment_status_transitions',
  {
    fromStatus: appointmentStatus('from_status').notNull(),
    toStatus: appointmentStatus('to_status').notNull(),
  },
  (t) => [primaryKey({ columns: [t.fromStatus, t.toStatus] })],
);

/** Append-only history, written by the appointments_history trigger. */
export const appointmentEvents = pgTable(
  'appointment_events',
  {
    id: id(),
    appointmentId: fk('appointment_id').notNull().references(() => appointments.id),
    patientId: fk('patient_id').notNull(),
    kind: appointmentEventKind('kind').notNull(),
    fromStatus: appointmentStatus('from_status'),
    toStatus: appointmentStatus('to_status'),
    oldStartsAt: tstz('old_starts_at'),
    newStartsAt: tstz('new_starts_at'),
    actorUserId: fk('actor_user_id'),
    actorRole: text('actor_role'),
    isLate: boolean('is_late').notNull().default(false),
    isStrike: boolean('is_strike').notNull().default(false),
    reason: text('reason'),
    occurredAt: tstz('occurred_at').notNull(),
    processedAt: tstz('processed_at'),
  },
  (t) => [
    index('appointment_events_appointment_idx').on(t.appointmentId, t.occurredAt),
    index('appointment_events_strike_idx').on(t.patientId, t.occurredAt).where(sql`${t.isStrike}`),
    index('appointment_events_unprocessed_idx').on(t.id).where(sql`${t.processedAt} IS NULL`),
  ],
);

/**
 * Idempotency records (docs/analysis/03). Written in the same transaction as the
 * operation they guard, so a key never exists without its effect. `request_hash`
 * is SHA-256 of the canonical request; `response` is the stored outcome (success or a
 * deterministic failure). Expired rows are replaced lazily on the next use of the key.
 */
export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    scope: text('scope').notNull(),
    actorId: fk('actor_id').notNull(),
    key: text('key').notNull(),
    requestHash: text('request_hash').notNull(),
    response: jsonb('response').notNull(),
    createdAt: tstz('created_at').notNull(),
    expiresAt: tstz('expires_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.scope, t.actorId, t.key] }), index('idempotency_keys_expiry_idx').on(t.expiresAt)],
);

export const emailStatus = pgEnum('email_status', ['pending', 'sent', 'dead']);

/**
 * Transactional outbox for mail (docs/analysis/04, sections 2 and 4). A row is written in the
 * same transaction as the business change that causes the mail, so "decide to send" is
 * exactly-once (`dedupe_key` is unique) while delivery by the worker is at-least-once.
 * `to_address` is a snapshot; a patient without an email gets a `dead` row so nothing is lost silently.
 */
export const emailOutbox = pgTable(
  'email_outbox',
  {
    id: id(),
    dedupeKey: text('dedupe_key').notNull(),
    toAddress: text('to_address'),
    patientId: fk('patient_id'),
    template: text('template').notNull(),
    payload: jsonb('payload').notNull(),
    messageId: text('message_id').generatedAlwaysAs(sql`'<outbox-' || id || '@clinic.local>'`),
    status: emailStatus('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: tstz('next_attempt_at').notNull(),
    claimedBy: text('claimed_by'),
    claimedUntil: tstz('claimed_until'),
    sentAt: tstz('sent_at'),
    lastError: text('last_error'),
    createdAt: tstz('created_at').notNull(),
  },
  (t) => [
    unique('email_outbox_dedupe_uq').on(t.dedupeKey),
    index('email_outbox_due_idx').on(t.nextAttemptAt).where(sql`${t.status} = 'pending'`),
  ],
);


export const reminderKind = pgEnum('reminder_kind', ['h24', 'h2']);

/**
 * Reminder decisions (docs/analysis/04, section 2), kept in step with `appointments` by the
 * `appointments_reminders` trigger, so they change in the same transaction as a booking, move or
 * cancel. `UNIQUE (appointment_id, kind, time_version)` makes "send" exactly-once per visit time;
 * `due_at` is an absolute instant (`start_snapshot` minus 24h / 2h), so DST does not shift it.
 */
export const reminders = pgTable(
  'reminders',
  {
    id: id(),
    appointmentId: fk('appointment_id').notNull().references(() => appointments.id),
    kind: reminderKind('kind').notNull(),
    timeVersion: integer('time_version').notNull(),
    startSnapshot: tstz('start_snapshot').notNull(),
    dueAt: tstz('due_at').notNull(),
    cancelledAt: tstz('cancelled_at'),
    enqueuedAt: tstz('enqueued_at'),
    skippedAt: tstz('skipped_at'),
    createdAt: tstz('created_at').notNull(),
  },
  (t) => [
    unique('reminders_appointment_kind_version_uq').on(t.appointmentId, t.kind, t.timeVersion),
    index('reminders_due_idx')
      .on(t.dueAt)
      .where(sql`${t.enqueuedAt} IS NULL AND ${t.cancelledAt} IS NULL AND ${t.skippedAt} IS NULL`),
    index('reminders_appointment_idx').on(t.appointmentId),
  ],
);
