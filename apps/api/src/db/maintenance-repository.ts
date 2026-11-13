import { and, asc, eq, inArray, isNull, lt } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "./schema.js";

export interface PendingDispatchRecord {
  dispatchGeneration: number;
  jobId: string;
}

export interface CleanupInspectionRecord {
  dispatchGeneration: number | null;
  id: string;
  normalizedObjectKey: string | null;
  predictionObjectKey: string | null;
  sourceObjectKey: string;
}

export interface LeaseRecoveryCounts {
  failed: number;
  retryWait: number;
}

export interface MaintenanceRepository {
  deleteAbandonedInspection(id: string, cutoff: Date): Promise<boolean>;
  deleteExpiredTerminalInspection(id: string, cutoff: Date): Promise<boolean>;
  listAbandonedInspections(
    cutoff: Date,
    limit: number,
  ): Promise<CleanupInspectionRecord[]>;
  listExpiredTerminalInspections(
    cutoff: Date,
    limit: number,
  ): Promise<CleanupInspectionRecord[]>;
  listPendingDispatches(
    cutoff: Date,
    limit: number,
  ): Promise<PendingDispatchRecord[]>;
  markJobDispatched(
    jobId: string,
    dispatchGeneration: number,
    taskName: string,
    now: Date,
  ): Promise<boolean>;
  recoverExpiredLeases(now: Date, limit: number): Promise<LeaseRecoveryCounts>;
}

export class PostgresMaintenanceRepository implements MaintenanceRepository {
  constructor(private readonly database: PostgresJsDatabase<typeof schema>) {}

  async listPendingDispatches(
    cutoff: Date,
    limit: number,
  ): Promise<PendingDispatchRecord[]> {
    return this.database
      .select({
        dispatchGeneration: schema.jobs.dispatchGeneration,
        jobId: schema.jobs.id,
      })
      .from(schema.jobs)
      .where(
        and(
          eq(schema.jobs.status, "pending_dispatch"),
          isNull(schema.jobs.taskEnqueuedAt),
          lt(schema.jobs.availableAt, cutoff),
        ),
      )
      .orderBy(asc(schema.jobs.availableAt), asc(schema.jobs.id))
      .limit(limit);
  }

  async markJobDispatched(
    jobId: string,
    dispatchGeneration: number,
    taskName: string,
    now: Date,
  ): Promise<boolean> {
    const rows = await this.database
      .update(schema.jobs)
      .set({ status: "queued", taskEnqueuedAt: now, taskName, updatedAt: now })
      .where(
        and(
          eq(schema.jobs.id, jobId),
          eq(schema.jobs.dispatchGeneration, dispatchGeneration),
          eq(schema.jobs.status, "pending_dispatch"),
          isNull(schema.jobs.taskEnqueuedAt),
        ),
      )
      .returning({ id: schema.jobs.id });
    return rows.length === 1;
  }

  async recoverExpiredLeases(
    now: Date,
    limit: number,
  ): Promise<LeaseRecoveryCounts> {
    return this.database.transaction(async (transaction) => {
      const expired = await transaction
        .select({
          attemptCount: schema.jobs.attemptCount,
          id: schema.jobs.id,
          inspectionId: schema.jobs.inspectionId,
          maxAttempts: schema.jobs.maxAttempts,
        })
        .from(schema.jobs)
        .where(
          and(
            eq(schema.jobs.status, "running"),
            lt(schema.jobs.leaseExpiresAt, now),
          ),
        )
        .orderBy(asc(schema.jobs.leaseExpiresAt), asc(schema.jobs.id))
        .limit(limit)
        .for("update", { skipLocked: true });
      let failed = 0;
      let retryWait = 0;
      for (const job of expired) {
        if (job.attemptCount >= job.maxAttempts) {
          await transaction
            .update(schema.jobs)
            .set({
              errorCode: "processing_attempts_exhausted",
              errorMessage:
                "Processing did not complete within its final lease.",
              finishedAt: now,
              leaseExpiresAt: null,
              leaseToken: null,
              stage: "failed",
              status: "failed",
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.jobs.id, job.id),
                eq(schema.jobs.status, "running"),
              ),
            );
          await transaction
            .update(schema.inspections)
            .set({
              errorCode: "processing_attempts_exhausted",
              errorMessage:
                "Processing did not complete after the allowed attempts.",
              completedAt: now,
              status: "failed",
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.inspections.id, job.inspectionId),
                inArray(schema.inspections.status, ["queued", "processing"]),
              ),
            );
          failed += 1;
        } else {
          await transaction
            .update(schema.jobs)
            .set({
              availableAt: now,
              errorCode: "lease_conflict",
              errorMessage: "The processing lease expired before completion.",
              leaseExpiresAt: null,
              leaseToken: null,
              stage: "retry_wait",
              status: "retry_wait",
              updatedAt: now,
            })
            .where(
              and(
                eq(schema.jobs.id, job.id),
                eq(schema.jobs.status, "running"),
              ),
            );
          retryWait += 1;
        }
      }
      return { failed, retryWait };
    });
  }

  async listAbandonedInspections(
    cutoff: Date,
    limit: number,
  ): Promise<CleanupInspectionRecord[]> {
    return this.listCleanupCandidates(["awaiting_upload"], cutoff, limit);
  }

  async listExpiredTerminalInspections(
    cutoff: Date,
    limit: number,
  ): Promise<CleanupInspectionRecord[]> {
    return this.listCleanupCandidates(
      ["completed", "failed", "cancelled"],
      cutoff,
      limit,
    );
  }

  async deleteAbandonedInspection(id: string, cutoff: Date): Promise<boolean> {
    const rows = await this.database
      .delete(schema.inspections)
      .where(
        and(
          eq(schema.inspections.id, id),
          eq(schema.inspections.status, "awaiting_upload"),
          lt(schema.inspections.updatedAt, cutoff),
        ),
      )
      .returning({ id: schema.inspections.id });
    return rows.length === 1;
  }

  async deleteExpiredTerminalInspection(
    id: string,
    cutoff: Date,
  ): Promise<boolean> {
    const rows = await this.database
      .delete(schema.inspections)
      .where(
        and(
          eq(schema.inspections.id, id),
          inArray(schema.inspections.status, [
            "completed",
            "failed",
            "cancelled",
          ]),
          lt(schema.inspections.updatedAt, cutoff),
        ),
      )
      .returning({ id: schema.inspections.id });
    return rows.length === 1;
  }

  private async listCleanupCandidates(
    statuses: (typeof schema.inspections.$inferSelect)["status"][],
    cutoff: Date,
    limit: number,
  ): Promise<CleanupInspectionRecord[]> {
    return this.database
      .select({
        dispatchGeneration: schema.jobs.dispatchGeneration,
        id: schema.inspections.id,
        normalizedObjectKey: schema.inspections.normalizedObjectKey,
        predictionObjectKey: schema.inspections.predictionObjectKey,
        sourceObjectKey: schema.inspections.sourceObjectKey,
      })
      .from(schema.inspections)
      .leftJoin(
        schema.jobs,
        eq(schema.jobs.inspectionId, schema.inspections.id),
      )
      .where(
        and(
          inArray(schema.inspections.status, statuses),
          lt(schema.inspections.updatedAt, cutoff),
        ),
      )
      .orderBy(asc(schema.inspections.updatedAt), asc(schema.inspections.id))
      .limit(limit);
  }
}
