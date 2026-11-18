CREATE TYPE "public"."reminder_kind" AS ENUM('h24', 'h2');--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "reminders_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"appointment_id" bigint NOT NULL,
	"kind" "reminder_kind" NOT NULL,
	"time_version" integer NOT NULL,
	"start_snapshot" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone,
	"enqueued_at" timestamp with time zone,
	"skipped_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "reminders_appointment_kind_version_uq" UNIQUE("appointment_id","kind","time_version")
);
--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reminders_due_idx" ON "reminders" USING btree ("due_at") WHERE "reminders"."enqueued_at" IS NULL AND "reminders"."cancelled_at" IS NULL AND "reminders"."skipped_at" IS NULL;--> statement-breakpoint
CREATE INDEX "reminders_appointment_idx" ON "reminders" USING btree ("appointment_id");--> statement-breakpoint

-- Keeps reminders in step with the appointment in the same transaction (docs/analysis/04, section 4).
-- 24 and 2 hours: keep in sync with REMINDER_HOURS. A reminder whose due time has already passed
-- is stored as skipped, so a late booking (or seed data) never causes a burst of old reminders.
CREATE FUNCTION appt_sync_reminders() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  now_ts timestamptz := app_clock_now();
BEGIN
  UPDATE reminders
     SET cancelled_at = now_ts
   WHERE appointment_id = NEW.id
     AND cancelled_at IS NULL AND enqueued_at IS NULL AND skipped_at IS NULL
     AND (NEW.status <> 'booked' OR time_version <> NEW.time_version);
  IF NEW.status = 'booked' THEN
    INSERT INTO reminders (appointment_id, kind, time_version, start_snapshot, due_at, skipped_at, created_at)
    SELECT NEW.id, k.kind, NEW.time_version, NEW.starts_at, NEW.starts_at - k.lead,
           CASE WHEN NEW.starts_at - k.lead < now_ts THEN now_ts END, now_ts
      FROM (VALUES ('h24'::reminder_kind, interval '24 hours'), ('h2'::reminder_kind, interval '2 hours')) AS k(kind, lead)
    ON CONFLICT (appointment_id, kind, time_version) DO NOTHING;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER appointments_reminders
  AFTER INSERT OR UPDATE OF status, starts_at, time_version ON appointments
  FOR EACH ROW EXECUTE FUNCTION appt_sync_reminders();
