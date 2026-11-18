CREATE TABLE "idempotency_keys" (
	"scope" text NOT NULL,
	"actor_id" bigint NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_scope_actor_id_key_pk" PRIMARY KEY("scope","actor_id","key")
);
--> statement-breakpoint
CREATE INDEX "idempotency_keys_expiry_idx" ON "idempotency_keys" USING btree ("expires_at");