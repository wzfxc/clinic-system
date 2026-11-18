CREATE TYPE "public"."email_status" AS ENUM('pending', 'sent', 'dead');--> statement-breakpoint
CREATE TABLE "email_outbox" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "email_outbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"dedupe_key" text NOT NULL,
	"to_address" text,
	"patient_id" bigint,
	"template" text NOT NULL,
	"payload" jsonb NOT NULL,
	"message_id" text GENERATED ALWAYS AS ('<outbox-' || id || '@clinic.local>') STORED,
	"status" "email_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"claimed_by" text,
	"claimed_until" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "email_outbox_dedupe_uq" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE INDEX "email_outbox_due_idx" ON "email_outbox" USING btree ("next_attempt_at") WHERE "email_outbox"."status" = 'pending';