CREATE TYPE "public"."inspection_source_type" AS ENUM('upload', 'recording', 'sample');--> statement-breakpoint
CREATE TYPE "public"."inspection_status" AS ENUM('awaiting_upload', 'queued', 'processing', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending_dispatch', 'queued', 'running', 'retry_wait', 'completed', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "inspections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"title" varchar(160) NOT NULL,
	"status" "inspection_status" DEFAULT 'awaiting_upload' NOT NULL,
	"source_type" "inspection_source_type" NOT NULL,
	"workflow_key" varchar(64) NOT NULL,
	"source_object_key" varchar(1024) NOT NULL,
	"normalized_object_key" varchar(1024),
	"prediction_object_key" varchar(1024),
	"declared_file_name" varchar(255),
	"declared_content_type" varchar(120),
	"declared_size_bytes" bigint,
	"inspected_content_type" varchar(120),
	"inspected_size_bytes" bigint,
	"inspected_duration_ms" bigint,
	"inspected_width" integer,
	"inspected_height" integer,
	"prediction_schema_version" integer,
	"workflow_fingerprint" varchar(71),
	"missing_hard_hat_event_count" integer,
	"qualifying_frame_count" integer,
	"peak_confidence" double precision,
	"error_code" varchar(64),
	"error_message" varchar(240),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"queued_at" timestamp (3) with time zone,
	"started_at" timestamp (3) with time zone,
	"completed_at" timestamp (3) with time zone,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inspections_declared_size_positive" CHECK ("inspections"."declared_size_bytes" is null or "inspections"."declared_size_bytes" > 0),
	CONSTRAINT "inspections_inspected_size_positive" CHECK ("inspections"."inspected_size_bytes" is null or "inspections"."inspected_size_bytes" > 0),
	CONSTRAINT "inspections_duration_positive" CHECK ("inspections"."inspected_duration_ms" is null or "inspections"."inspected_duration_ms" > 0),
	CONSTRAINT "inspections_width_positive" CHECK ("inspections"."inspected_width" is null or "inspections"."inspected_width" > 0),
	CONSTRAINT "inspections_height_positive" CHECK ("inspections"."inspected_height" is null or "inspections"."inspected_height" > 0),
	CONSTRAINT "inspections_schema_version_positive" CHECK ("inspections"."prediction_schema_version" is null or "inspections"."prediction_schema_version" > 0),
	CONSTRAINT "inspections_event_count_nonnegative" CHECK ("inspections"."missing_hard_hat_event_count" is null or "inspections"."missing_hard_hat_event_count" >= 0),
	CONSTRAINT "inspections_frame_count_nonnegative" CHECK ("inspections"."qualifying_frame_count" is null or "inspections"."qualifying_frame_count" >= 0),
	CONSTRAINT "inspections_peak_confidence_range" CHECK ("inspections"."peak_confidence" is null or "inspections"."peak_confidence" between 0 and 1)
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"inspection_id" uuid NOT NULL,
	"status" "job_status" DEFAULT 'pending_dispatch' NOT NULL,
	"stage" varchar(64),
	"progress_percent" integer DEFAULT 0 NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"dispatch_generation" integer DEFAULT 1 NOT NULL,
	"task_name" varchar(500),
	"task_enqueued_at" timestamp (3) with time zone,
	"lease_token" uuid,
	"lease_expires_at" timestamp (3) with time zone,
	"heartbeat_at" timestamp (3) with time zone,
	"cancel_requested_at" timestamp (3) with time zone,
	"error_code" varchar(64),
	"error_message" varchar(240),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"available_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp (3) with time zone,
	"finished_at" timestamp (3) with time zone,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_progress_percent_range" CHECK ("jobs"."progress_percent" between 0 and 100),
	CONSTRAINT "jobs_attempt_count_nonnegative" CHECK ("jobs"."attempt_count" >= 0),
	CONSTRAINT "jobs_max_attempts_positive" CHECK ("jobs"."max_attempts" > 0),
	CONSTRAINT "jobs_dispatch_generation_positive" CHECK ("jobs"."dispatch_generation" > 0)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(128) NOT NULL,
	"expires_at" timestamp (3) with time zone NOT NULL,
	"last_seen_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"google_subject" varchar(255) NOT NULL,
	"email" varchar(320) NOT NULL,
	"display_name" varchar(120) NOT NULL,
	"avatar_url" varchar(2048),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inspections" ADD CONSTRAINT "inspections_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_inspection_id_inspections_id_fk" FOREIGN KEY ("inspection_id") REFERENCES "public"."inspections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inspections_owner_history_idx" ON "inspections" USING btree ("owner_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "inspections_owner_active_idx" ON "inspections" USING btree ("owner_user_id","status","updated_at") WHERE "inspections"."status" in ('awaiting_upload', 'queued', 'processing');--> statement-breakpoint
CREATE INDEX "inspections_status_updated_at_idx" ON "inspections" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_inspection_id_unique" ON "jobs" USING btree ("inspection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_task_name_unique" ON "jobs" USING btree ("task_name");--> statement-breakpoint
CREATE INDEX "jobs_pending_dispatch_idx" ON "jobs" USING btree ("available_at") WHERE "jobs"."status" = 'pending_dispatch' and "jobs"."task_enqueued_at" is null;--> statement-breakpoint
CREATE INDEX "jobs_stale_lease_idx" ON "jobs" USING btree ("lease_expires_at") WHERE "jobs"."status" = 'running' and "jobs"."lease_expires_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_unique" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_google_subject_unique" ON "users" USING btree ("google_subject");