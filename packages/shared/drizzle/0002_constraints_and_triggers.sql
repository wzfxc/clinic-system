-- Custom migration: everything Drizzle cannot express (docs/analysis/01, 00-decisions D1/R4).
-- Custom SQLSTATEs: CL001 patient future limit, CL002 invalid status transition,
-- CL003 app.clock_now not set, CL004 appointment_events is append-only.

-- ---------------------------------------------------------------- clock
-- Time in triggers comes only from the injected clock: the app runs
-- set_config('app.clock_now', <iso>, true) at the start of every transaction.
-- After a transaction that used set_config(..., true) the setting stays as ''
-- on that connection, so empty is treated the same as unset.
CREATE FUNCTION app_clock_now() RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$
DECLARE v text := current_setting('app.clock_now', true);
BEGIN
  IF v IS NULL OR v = '' THEN
    RAISE EXCEPTION 'app.clock_now is not set' USING ERRCODE = 'CL003';
  END IF;
  RETURN v::timestamptz;
END $$;
--> statement-breakpoint

-- ---------------------------------------------------------------- schedule
ALTER TABLE schedule_templates ADD CONSTRAINT schedule_templates_no_overlap
  EXCLUDE USING gist (doctor_id WITH =, weekday WITH =, valid_during WITH &&);
--> statement-breakpoint

-- ---------------------------------------------------------------- appointments: exclusion (D1: status <> 'cancelled')
ALTER TABLE appointments ADD CONSTRAINT appt_doctor_no_overlap
  EXCLUDE USING gist (doctor_id WITH =, tstzrange(starts_at, blocked_until, '[)') WITH &&)
  WHERE (status <> 'cancelled');
--> statement-breakpoint
ALTER TABLE appointments ADD CONSTRAINT appt_ultrasound_no_overlap
  EXCLUDE USING gist (clinic_id WITH =, tstzrange(starts_at, blocked_until, '[)') WITH &&)
  WHERE (uses_ultrasound_room AND status <> 'cancelled');
--> statement-breakpoint
ALTER TABLE appointments ADD CONSTRAINT appt_patient_no_overlap
  EXCLUDE USING gist (patient_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
  WHERE (status <> 'cancelled');
--> statement-breakpoint

-- ---------------------------------------------------------------- appointments: INCLUDE / partial indexes
CREATE INDEX appt_doctor_time ON appointments (doctor_id, starts_at)
  INCLUDE (blocked_until, status, hold_expires_at) WHERE status <> 'cancelled';
--> statement-breakpoint
CREATE INDEX appt_uzi_time ON appointments (clinic_id, starts_at)
  INCLUDE (blocked_until, status, hold_expires_at)
  WHERE uses_ultrasound_room AND status <> 'cancelled';
--> statement-breakpoint
CREATE INDEX appt_report ON appointments (starts_at)
  INCLUDE (doctor_id, clinic_id, service_id, status, ends_at, price_minor);
--> statement-breakpoint

-- ---------------------------------------------------------------- trigger a: local_date
-- date of starts_at in the clinic's zone; a generated column cannot do it (zone lookup is not immutable).
CREATE FUNCTION appt_set_local_date() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tz text;
BEGIN
  SELECT timezone INTO STRICT tz FROM clinics WHERE id = NEW.clinic_id;
  NEW.local_date := (NEW.starts_at AT TIME ZONE tz)::date;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER appointments_a_local_date
  BEFORE INSERT OR UPDATE OF starts_at, clinic_id, local_date ON appointments
  FOR EACH ROW EXECUTE FUNCTION appt_set_local_date();
--> statement-breakpoint

-- ---------------------------------------------------------------- trigger b: patient limit (max 3 future)
-- Keep 3 in sync with MAX_FUTURE_APPOINTMENTS in packages/shared/src/rules.ts.
CREATE FUNCTION appt_patient_limit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  n int;
  now_ts timestamptz := app_clock_now();
BEGIN
  IF NEW.status = 'cancelled' OR NEW.starts_at <= now_ts THEN RETURN NEW; END IF;
  -- The count-after-lock below needs a fresh snapshot per statement (READ COMMITTED).
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'patient limit requires READ COMMITTED' USING ERRCODE = 'CL001';
  END IF;
  -- Skip only when the old row was already counted (future and booked/checked_in/live hold)
  -- for the same patient: then the move or status change does not grow the count.
  IF TG_OP = 'UPDATE' AND OLD.patient_id = NEW.patient_id AND OLD.starts_at > now_ts
     AND (OLD.status IN ('booked','checked_in')
          OR (OLD.status = 'held' AND OLD.hold_expires_at > now_ts)) THEN
    RETURN NEW;
  END IF;
  PERFORM 1 FROM patients WHERE id = NEW.patient_id FOR UPDATE; -- serialise per patient
  SELECT count(*) INTO n FROM appointments
   WHERE patient_id = NEW.patient_id AND id <> NEW.id
     AND starts_at > now_ts
     AND (status IN ('booked','checked_in')
          OR (status = 'held' AND hold_expires_at > now_ts));
  IF n >= 3 THEN
    RAISE EXCEPTION 'patient_future_limit' USING ERRCODE = 'CL001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER appointments_b_patient_limit
  BEFORE INSERT OR UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION appt_patient_limit();
--> statement-breakpoint

-- ---------------------------------------------------------------- trigger c: status transitions
INSERT INTO appointment_status_transitions (from_status, to_status) VALUES
  ('held','booked'), ('held','cancelled'),
  ('booked','checked_in'), ('booked','no_show'), ('booked','completed'), ('booked','cancelled'),
  ('checked_in','completed'), ('checked_in','no_show'), ('checked_in','cancelled');
--> statement-breakpoint
CREATE FUNCTION appt_check_status_transition() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT EXISTS (
    SELECT 1 FROM appointment_status_transitions
     WHERE from_status = OLD.status AND to_status = NEW.status) THEN
    RAISE EXCEPTION 'invalid status transition % -> %', OLD.status, NEW.status USING ERRCODE = 'CL002';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER appointments_c_status_transition
  BEFORE UPDATE OF status ON appointments
  FOR EACH ROW EXECUTE FUNCTION appt_check_status_transition();
--> statement-breakpoint

-- ---------------------------------------------------------------- history (AFTER trigger)
-- Keep 24 hours in sync with FREE_CANCEL_HOURS; exactly 24h is late (R1).
CREATE FUNCTION appt_write_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  now_ts timestamptz := app_clock_now();
  ev appointment_event_kind;
  late boolean := false;
  strike boolean := false;
  actor_id_text text := nullif(current_setting('app.actor_id', true), '');
  actor_role_text text := nullif(current_setting('app.actor_role', true), '');
BEGIN
  IF TG_OP = 'INSERT' THEN
    ev := CASE WHEN NEW.status = 'held' THEN 'held' ELSE 'created' END;
    INSERT INTO appointment_events (appointment_id, patient_id, kind, to_status, new_starts_at,
                                    actor_user_id, actor_role, occurred_at)
    VALUES (NEW.id, NEW.patient_id, ev, NEW.status, NEW.starts_at,
            actor_id_text::bigint, actor_role_text, now_ts);
    RETURN NULL;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    ev := CASE
      WHEN NEW.status = 'booked' AND OLD.hold_kind = 'waitlist_offer' THEN 'offer_accepted'
      WHEN NEW.status = 'booked' THEN 'confirmed'
      WHEN NEW.status = 'cancelled' AND OLD.status = 'held' AND NEW.cancel_reason = 'hold_expired' THEN 'hold_expired'
      ELSE NEW.status::text::appointment_event_kind
    END;
  ELSIF NEW.starts_at IS DISTINCT FROM OLD.starts_at THEN
    ev := 'rescheduled';
  ELSE
    RETURN NULL;
  END IF;

  -- System-initiated cancels (sick leave cascade, hold replacement/expiry) are never late or strikes.
  IF OLD.status IN ('booked','checked_in') AND ev IN ('cancelled','rescheduled')
     AND coalesce(NEW.cancel_reason, '') NOT IN ('sick_leave','checkout_replaced','hold_expired') THEN
    late := (OLD.starts_at - now_ts) <= interval '24 hours';
  END IF;
  strike := late OR ev = 'no_show';

  INSERT INTO appointment_events (appointment_id, patient_id, kind, from_status, to_status,
                                  old_starts_at, new_starts_at, actor_user_id, actor_role,
                                  is_late, is_strike, reason, occurred_at)
  VALUES (NEW.id, NEW.patient_id, ev, OLD.status, NEW.status,
          OLD.starts_at, NEW.starts_at, actor_id_text::bigint, actor_role_text,
          late, strike, NEW.cancel_reason, now_ts);
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER appointments_history
  AFTER INSERT OR UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION appt_write_history();
--> statement-breakpoint

-- ---------------------------------------------------------------- append-only events
-- Only processed_at (worker outbox) may change; deletes are forbidden.
CREATE FUNCTION appt_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (to_jsonb(NEW) - 'processed_at') = (to_jsonb(OLD) - 'processed_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'appointment_events is append-only' USING ERRCODE = 'CL004';
END $$;
--> statement-breakpoint
CREATE TRIGGER appointment_events_append_only
  BEFORE UPDATE OR DELETE ON appointment_events
  FOR EACH ROW EXECUTE FUNCTION appt_events_append_only();
