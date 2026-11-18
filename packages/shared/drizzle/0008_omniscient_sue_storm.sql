CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role" text NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_hash" text NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "clinic_id" bigint;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK ("users"."role" IN ('patient','receptionist','doctor','manager'));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_clinic_binding_check" CHECK (("users"."role" = 'receptionist') = ("users"."clinic_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_clinic_id_clinics_id_fk" FOREIGN KEY ("clinic_id") REFERENCES "public"."clinics"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Cross-process change feed for subscriptions (api LISTENs; the worker and any writer fire it). Ids only, no PII.
-- Postgres stays the source of truth: a lost notification costs a refetch, never correctness.
CREATE FUNCTION appointments_notify() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('appointments_changed', json_build_object(
    'appointmentId', NEW.id, 'patientId', NEW.patient_id, 'doctorId', NEW.doctor_id,
    'clinicId', NEW.clinic_id, 'startsAt', NEW.starts_at)::text);
  RETURN NULL;
END $$;--> statement-breakpoint
CREATE TRIGGER appointments_z_notify AFTER INSERT OR UPDATE ON "appointments"
  FOR EACH ROW EXECUTE FUNCTION appointments_notify();
