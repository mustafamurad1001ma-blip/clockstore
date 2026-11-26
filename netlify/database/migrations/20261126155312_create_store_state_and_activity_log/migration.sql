CREATE TABLE "activity_log" (
	"id" serial PRIMARY KEY,
	"store_id" text NOT NULL,
	"version" integer NOT NULL,
	"action" text NOT NULL,
	"section" text,
	"details" text,
	"actor" text,
	"device" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "store_state" (
	"id" text PRIMARY KEY,
	"payload" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "activity_log_store_created_idx" ON "activity_log" ("store_id","created_at");