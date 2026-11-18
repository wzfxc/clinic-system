CREATE TYPE "public"."waitlist_entry_status" AS ENUM('waiting', 'offered', 'fulfilled', 'cancelled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."waitlist_offer_status" AS ENUM('pending', 'accepted', 'declined', 'expired');--> statement-breakpoint
CREATE TABLE "waitlist_entries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "waitlist_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"patient_id" bigint NOT NULL,
	"doctor_id" bigint NOT NULL,
	"clinic_id" bigint NOT NULL,
	"service_id" bigint NOT NULL,
	"date_from" date NOT NULL,
	"date_to" date NOT NULL,
	"priority" smallint DEFAULT 0 NOT NULL,
	"priority_reason" text,
	"source_appointment_id" bigint,
	"status" "waitlist_entry_status" DEFAULT 'waiting' NOT NULL,
	"missed_offers" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "waitlist_entries_range_check" CHECK ("waitlist_entries"."date_from" <= "waitlist_entries"."date_to"),
	CONSTRAINT "waitlist_entries_priority_check" CHECK ("waitlist_entries"."priority" BETWEEN 0 AND 1)
);
--> statement-breakpoint
CREATE TABLE "waitlist_offers" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "waitlist_offers_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"entry_id" bigint NOT NULL,
	"appointment_id" bigint NOT NULL,
	"chain_id" uuid NOT NULL,
	"status" "waitlist_offer_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "waitlist_offers_chain_entry_uq" UNIQUE("chain_id","entry_id"),
	CONSTRAINT "waitlist_offers_resolved_check" CHECK (("waitlist_offers"."status" = 'pending') = ("waitlist_offers"."resolved_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_doctor_clinic_fk" FOREIGN KEY ("doctor_id","clinic_id") REFERENCES "public"."doctor_clinics"("doctor_id","clinic_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_doctor_service_fk" FOREIGN KEY ("doctor_id","service_id") REFERENCES "public"."doctor_services"("doctor_id","service_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_offers" ADD CONSTRAINT "waitlist_offers_entry_id_waitlist_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."waitlist_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_offers" ADD CONSTRAINT "waitlist_offers_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_entries_active_uq" ON "waitlist_entries" USING btree ("patient_id","doctor_id","service_id") WHERE "waitlist_entries"."status" IN ('waiting', 'offered');--> statement-breakpoint
CREATE INDEX "waitlist_entries_queue_idx" ON "waitlist_entries" USING btree ("doctor_id","clinic_id","priority" DESC NULLS LAST,"created_at","id") WHERE "waitlist_entries"."status" = 'waiting';--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_offers_entry_pending_uq" ON "waitlist_offers" USING btree ("entry_id") WHERE "waitlist_offers"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_offers_appt_pending_uq" ON "waitlist_offers" USING btree ("appointment_id") WHERE "waitlist_offers"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "waitlist_offers_due_idx" ON "waitlist_offers" USING btree ("expires_at") WHERE "waitlist_offers"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_waitlist_entry_fk" FOREIGN KEY ("waitlist_entry_id") REFERENCES "public"."waitlist_entries"("id") ON DELETE no action ON UPDATE no action;