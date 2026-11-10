import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const timestampWithTimezone = (name: string) =>
  timestamp(name, { mode: "date", precision: 3, withTimezone: true });

export const inspectionStatus = pgEnum("inspection_status", [
  "awaiting_upload",
  "queued",
  "processing",
  "completed",
  "failed",
  "cancelled",
]);

export const inspectionSourceType = pgEnum("inspection_source_type", [
  "upload",
  "recording",
  "sample",
]);

export const jobStatus = pgEnum("job_status", [
  "pending_dispatch",
  "queued",
  "running",
  "retry_wait",
  "completed",
  "failed",
  "cancelled",
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    googleSubject: varchar("google_subject", { length: 255 }).notNull(),
    email: varchar("email", { length: 320 }).notNull(),
    displayName: varchar("display_name", { length: 120 }).notNull(),
    avatarUrl: varchar("avatar_url", { length: 2048 }),
    createdAt: timestampWithTimezone("created_at").defaultNow().notNull(),
    updatedAt: timestampWithTimezone("updated_at").defaultNow().notNull(),
    lastLoginAt: timestampWithTimezone("last_login_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("users_google_subject_unique").on(table.googleSubject),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 128 }).notNull(),
    expiresAt: timestampWithTimezone("expires_at").notNull(),
    lastSeenAt: timestampWithTimezone("last_seen_at").defaultNow().notNull(),
    revokedAt: timestampWithTimezone("revoked_at"),
    createdAt: timestampWithTimezone("created_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_unique").on(table.tokenHash),
    index("sessions_user_id_idx").on(table.userId),
  ],
);

export const inspections = pgTable(
  "inspections",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    title: varchar("title", { length: 160 }).notNull(),
    status: inspectionStatus("status").default("awaiting_upload").notNull(),
    sourceType: inspectionSourceType("source_type").notNull(),
    workflowKey: varchar("workflow_key", { length: 64 }).notNull(),
    sourceObjectKey: varchar("source_object_key", { length: 1024 }).notNull(),
    normalizedObjectKey: varchar("normalized_object_key", { length: 1024 }),
    predictionObjectKey: varchar("prediction_object_key", { length: 1024 }),
    declaredFileName: varchar("declared_file_name", { length: 255 }),
    declaredContentType: varchar("declared_content_type", { length: 120 }),
    declaredSizeBytes: bigint("declared_size_bytes", { mode: "number" }),
    inspectedContentType: varchar("inspected_content_type", { length: 120 }),
    inspectedSizeBytes: bigint("inspected_size_bytes", { mode: "number" }),
    inspectedDurationMs: bigint("inspected_duration_ms", { mode: "number" }),
    inspectedWidth: integer("inspected_width"),
    inspectedHeight: integer("inspected_height"),
    inspectedContainer: varchar("inspected_container", { length: 120 }),
    inspectedFrameRate: varchar("inspected_frame_rate", { length: 32 }),
    inspectedStreams: jsonb("inspected_streams").$type<
      Array<{
        index: number;
        type: "video" | "audio";
        codec: string;
        durationMs: number | null;
        width: number | null;
        height: number | null;
        frameRate: string | null;
      }>
    >(),
    predictionSchemaVersion: integer("prediction_schema_version"),
    workflowFingerprint: varchar("workflow_fingerprint", { length: 71 }),
    missingHardHatEventCount: integer("missing_hard_hat_event_count"),
    qualifyingFrameCount: integer("qualifying_frame_count"),
    peakConfidence: doublePrecision("peak_confidence"),
    errorCode: varchar("error_code", { length: 64 }),
    errorMessage: varchar("error_message", { length: 240 }),
    createdAt: timestampWithTimezone("created_at").defaultNow().notNull(),
    queuedAt: timestampWithTimezone("queued_at"),
    startedAt: timestampWithTimezone("started_at"),
    completedAt: timestampWithTimezone("completed_at"),
    updatedAt: timestampWithTimezone("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("inspections_owner_history_idx").on(
      table.ownerUserId,
      table.createdAt.desc(),
    ),
    index("inspections_owner_active_idx")
      .on(table.ownerUserId, table.status, table.updatedAt)
      .where(
        sql`${table.status} in ('awaiting_upload', 'queued', 'processing')`,
      ),
    index("inspections_status_updated_at_idx").on(
      table.status,
      table.updatedAt,
    ),
    check(
      "inspections_declared_size_positive",
      sql`${table.declaredSizeBytes} is null or ${table.declaredSizeBytes} > 0`,
    ),
    check(
      "inspections_inspected_size_positive",
      sql`${table.inspectedSizeBytes} is null or ${table.inspectedSizeBytes} > 0`,
    ),
    check(
      "inspections_duration_positive",
      sql`${table.inspectedDurationMs} is null or ${table.inspectedDurationMs} > 0`,
    ),
    check(
      "inspections_width_positive",
      sql`${table.inspectedWidth} is null or ${table.inspectedWidth} > 0`,
    ),
    check(
      "inspections_height_positive",
      sql`${table.inspectedHeight} is null or ${table.inspectedHeight} > 0`,
    ),
    check(
      "inspections_schema_version_positive",
      sql`${table.predictionSchemaVersion} is null or ${table.predictionSchemaVersion} > 0`,
    ),
    check(
      "inspections_event_count_nonnegative",
      sql`${table.missingHardHatEventCount} is null or ${table.missingHardHatEventCount} >= 0`,
    ),
    check(
      "inspections_frame_count_nonnegative",
      sql`${table.qualifyingFrameCount} is null or ${table.qualifyingFrameCount} >= 0`,
    ),
    check(
      "inspections_peak_confidence_range",
      sql`${table.peakConfidence} is null or ${table.peakConfidence} between 0 and 1`,
    ),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    inspectionId: uuid("inspection_id")
      .notNull()
      .references(() => inspections.id, { onDelete: "cascade" }),
    status: jobStatus("status").default("pending_dispatch").notNull(),
    stage: varchar("stage", { length: 64 }),
    progressPercent: integer("progress_percent").default(0).notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    maxAttempts: integer("max_attempts").default(3).notNull(),
    dispatchGeneration: integer("dispatch_generation").default(1).notNull(),
    taskName: varchar("task_name", { length: 500 }),
    taskEnqueuedAt: timestampWithTimezone("task_enqueued_at"),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestampWithTimezone("lease_expires_at"),
    heartbeatAt: timestampWithTimezone("heartbeat_at"),
    cancelRequestedAt: timestampWithTimezone("cancel_requested_at"),
    errorCode: varchar("error_code", { length: 64 }),
    errorMessage: varchar("error_message", { length: 240 }),
    createdAt: timestampWithTimezone("created_at").defaultNow().notNull(),
    availableAt: timestampWithTimezone("available_at").defaultNow().notNull(),
    startedAt: timestampWithTimezone("started_at"),
    finishedAt: timestampWithTimezone("finished_at"),
    updatedAt: timestampWithTimezone("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("jobs_inspection_id_unique").on(table.inspectionId),
    uniqueIndex("jobs_task_name_unique").on(table.taskName),
    index("jobs_pending_dispatch_idx")
      .on(table.availableAt)
      .where(
        sql`${table.status} = 'pending_dispatch' and ${table.taskEnqueuedAt} is null`,
      ),
    index("jobs_stale_lease_idx")
      .on(table.leaseExpiresAt)
      .where(
        sql`${table.status} = 'running' and ${table.leaseExpiresAt} is not null`,
      ),
    check(
      "jobs_progress_percent_range",
      sql`${table.progressPercent} between 0 and 100`,
    ),
    check("jobs_attempt_count_nonnegative", sql`${table.attemptCount} >= 0`),
    check("jobs_max_attempts_positive", sql`${table.maxAttempts} > 0`),
    check(
      "jobs_dispatch_generation_positive",
      sql`${table.dispatchGeneration} > 0`,
    ),
  ],
);
