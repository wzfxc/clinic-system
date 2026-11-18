CREATE TYPE "public"."appointment_event_kind" AS ENUM('created', 'held', 'confirmed', 'rescheduled', 'cancelled', 'checked_in', 'completed', 'no_show', 'hold_expired', 'offer_accepted');--> statement-breakpoint
CREATE TYPE "public"."appointment_status" AS ENUM('held', 'booked', 'checked_in', 'completed', 'no_show', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."exception_kind" AS ENUM('day_off', 'extra_day');--> statement-breakpoint
CREATE TYPE "public"."exception_reason" AS ENUM('vacation', 'sick', 'other');--> statement-breakpoint
CREATE TYPE "public"."hold_kind" AS ENUM('checkout', 'waitlist_offer');--> statement-breakpoint
CREATE TABLE "appointment_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "appointment_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"appointment_id" bigint NOT NULL,
	"patient_id" bigint NOT NULL,
	"kind" "appointment_event_kind" NOT NULL,
	"from_status" "appointment_status",
	"to_status" "appointment_status",
	"old_starts_at" timestamp with time zone,
	"new_starts_at" timestamp with time zone,
	"actor_user_id" bigint,
	"actor_role" text,
	"is_late" boolean DEFAULT false NOT NULL,
	"is_strike" boolean DEFAULT false NOT NULL,
	"reason" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "appointment_status_transitions" (
	"from_status" "appointment_status" NOT NULL,
	"to_status" "appointment_status" NOT NULL,
	CONSTRAINT "appointment_status_transitions_from_status_to_status_pk" PRIMARY KEY("from_status","to_status")
);
--> statement-breakpoint
CREATE TABLE "appointments" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "appointments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"clinic_id" bigint NOT NULL,
	"doctor_id" bigint NOT NULL,
	"patient_id" bigint NOT NULL,
	"service_id" bigint NOT NULL,
	"status" "appointment_status" NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"blocked_until" timestamp with time zone NOT NULL,
	"local_date" date NOT NULL,
	"uses_ultrasound_room" boolean NOT NULL,
	"price_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"hold_kind" "hold_kind",
	"hold_expires_at" timestamp with time zone,
	"waitlist_entry_id" bigint,
	"cancel_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"time_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "appointments_price_check" CHECK ("appointments"."price_minor" >= 0),
	CONSTRAINT "appointments_duration_check" CHECK ("appointments"."ends_at" - "appointments"."starts_at" BETWEEN interval '15 minutes' AND interval '90 minutes'),
	CONSTRAINT "appointments_buffer_check" CHECK ("appointments"."blocked_until" = "appointments"."ends_at" + interval '5 minutes'),
	CONSTRAINT "appointments_grid_check" CHECK (date_trunc('minute', "appointments"."starts_at") = "appointments"."starts_at" AND extract(minute FROM "appointments"."starts_at" AT TIME ZONE 'UTC')::int % 15 = 0),
	CONSTRAINT "appointments_hold_check" CHECK (("appointments"."status" = 'held') = ("appointments"."hold_kind" IS NOT NULL AND "appointments"."hold_expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "clinic_services" (
	"clinic_id" bigint NOT NULL,
	"service_id" bigint NOT NULL,
	"price_minor" bigint NOT NULL,
	CONSTRAINT "clinic_services_clinic_id_service_id_pk" PRIMARY KEY("clinic_id","service_id"),
	CONSTRAINT "clinic_services_price_check" CHECK ("clinic_services"."price_minor" >= 0)
);
--> statement-breakpoint
CREATE TABLE "clinics" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "clinics_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"city" text NOT NULL,
	"name" text NOT NULL,
	"timezone" text NOT NULL,
	"currency" char(3) NOT NULL,
	CONSTRAINT "clinics_currency_check" CHECK ("clinics"."currency" IN ('UAH','PLN'))
);
--> statement-breakpoint
CREATE TABLE "doctor_clinics" (
	"doctor_id" bigint NOT NULL,
	"clinic_id" bigint NOT NULL,
	CONSTRAINT "doctor_clinics_doctor_id_clinic_id_pk" PRIMARY KEY("doctor_id","clinic_id")
);
--> statement-breakpoint
CREATE TABLE "doctor_services" (
	"doctor_id" bigint NOT NULL,
	"service_id" bigint NOT NULL,
	CONSTRAINT "doctor_services_doctor_id_service_id_pk" PRIMARY KEY("doctor_id","service_id")
);
--> statement-breakpoint
CREATE TABLE "doctors" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "doctors_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint,
	"specialty" text NOT NULL,
	CONSTRAINT "doctors_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "patients" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "patients_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" bigint,
	"full_name" text NOT NULL,
	"phone" text,
	"email" text,
	"online_booking_blocked_until" timestamp with time zone,
	CONSTRAINT "patients_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "schedule_exceptions" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "schedule_exceptions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"doctor_id" bigint NOT NULL,
	"on_date" date NOT NULL,
	"kind" "exception_kind" NOT NULL,
	"reason" "exception_reason" NOT NULL,
	"clinic_id" bigint NOT NULL,
	"work_start" time,
	"work_end" time,
	"break_start" time,
	"break_end" time,
	"created_by" bigint,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "schedule_exceptions_uq" UNIQUE("doctor_id","clinic_id","on_date"),
	CONSTRAINT "schedule_exceptions_extra_day_check" CHECK (("schedule_exceptions"."kind" = 'extra_day') = ("schedule_exceptions"."work_start" IS NOT NULL AND "schedule_exceptions"."work_end" > "schedule_exceptions"."work_start")),
	CONSTRAINT "schedule_exceptions_day_off_check" CHECK ("schedule_exceptions"."kind" = 'extra_day' OR ("schedule_exceptions"."work_start" IS NULL AND "schedule_exceptions"."work_end" IS NULL AND "schedule_exceptions"."break_start" IS NULL AND "schedule_exceptions"."break_end" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "schedule_templates" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "schedule_templates_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"doctor_id" bigint NOT NULL,
	"clinic_id" bigint NOT NULL,
	"weekday" smallint NOT NULL,
	"work_start" time NOT NULL,
	"work_end" time NOT NULL,
	"break_start" time,
	"break_end" time,
	"valid_during" daterange DEFAULT daterange(NULL, NULL, '[)') NOT NULL,
	CONSTRAINT "schedule_templates_weekday_check" CHECK ("schedule_templates"."weekday" BETWEEN 1 AND 7),
	CONSTRAINT "schedule_templates_work_check" CHECK ("schedule_templates"."work_end" > "schedule_templates"."work_start"),
	CONSTRAINT "schedule_templates_break_pair_check" CHECK (("schedule_templates"."break_start" IS NULL) = ("schedule_templates"."break_end" IS NULL)),
	CONSTRAINT "schedule_templates_break_range_check" CHECK ("schedule_templates"."break_start" IS NULL OR ("schedule_templates"."break_start" >= "schedule_templates"."work_start" AND "schedule_templates"."break_end" > "schedule_templates"."break_start" AND "schedule_templates"."break_end" <= "schedule_templates"."work_end"))
);
--> statement-breakpoint
CREATE TABLE "services" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "services_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"uses_ultrasound_room" boolean DEFAULT false NOT NULL,
	CONSTRAINT "services_duration_check" CHECK ("services"."duration_minutes" BETWEEN 15 AND 90 AND "services"."duration_minutes" % 15 = 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"email" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "appointment_events" ADD CONSTRAINT "appointment_events_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_doctor_clinic_fk" FOREIGN KEY ("doctor_id","clinic_id") REFERENCES "public"."doctor_clinics"("doctor_id","clinic_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_doctor_service_fk" FOREIGN KEY ("doctor_id","service_id") REFERENCES "public"."doctor_services"("doctor_id","service_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_clinic_service_fk" FOREIGN KEY ("clinic_id","service_id") REFERENCES "public"."clinic_services"("clinic_id","service_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_services" ADD CONSTRAINT "clinic_services_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_services" ADD CONSTRAINT "clinic_services_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_clinics" ADD CONSTRAINT "doctor_clinics_doctor_id_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_clinics" ADD CONSTRAINT "doctor_clinics_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_services" ADD CONSTRAINT "doctor_services_doctor_id_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctor_services" ADD CONSTRAINT "doctor_services_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doctors" ADD CONSTRAINT "doctors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patients" ADD CONSTRAINT "patients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_exceptions" ADD CONSTRAINT "schedule_exceptions_doctor_id_doctors_id_fk" FOREIGN KEY ("doctor_id") REFERENCES "public"."doctors"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_exceptions" ADD CONSTRAINT "schedule_exceptions_doctor_clinic_fk" FOREIGN KEY ("doctor_id","clinic_id") REFERENCES "public"."doctor_clinics"("doctor_id","clinic_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_templates" ADD CONSTRAINT "schedule_templates_doctor_clinic_fk" FOREIGN KEY ("doctor_id","clinic_id") REFERENCES "public"."doctor_clinics"("doctor_id","clinic_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "appointment_events_appointment_idx" ON "appointment_events" USING btree ("appointment_id","occurred_at");--> statement-breakpoint
CREATE INDEX "appointment_events_strike_idx" ON "appointment_events" USING btree ("patient_id","occurred_at") WHERE "appointment_events"."is_strike";--> statement-breakpoint
CREATE INDEX "appointment_events_unprocessed_idx" ON "appointment_events" USING btree ("id") WHERE "appointment_events"."processed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "appt_patient_doctor_day_uq" ON "appointments" USING btree ("patient_id","doctor_id","local_date") WHERE "appointments"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "appt_clinic_time" ON "appointments" USING btree ("clinic_id","starts_at");--> statement-breakpoint
CREATE INDEX "appt_patient_time" ON "appointments" USING btree ("patient_id","starts_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "appt_hold_expiry" ON "appointments" USING btree ("hold_expires_at") WHERE "appointments"."status" = 'held';--> statement-breakpoint
CREATE INDEX "appt_service" ON "appointments" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "clinic_services_service_idx" ON "clinic_services" USING btree ("service_id");--> statement-breakpoint
CREATE INDEX "doctor_clinics_clinic_idx" ON "doctor_clinics" USING btree ("clinic_id");--> statement-breakpoint
CREATE INDEX "doctor_services_service_idx" ON "doctor_services" USING btree ("service_id");