import { and, desc, eq, inArray, isNull, lt, or, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "./schema.js";

export type InspectionRecord = typeof schema.inspections.$inferSelect;
export type InspectionStatus = InspectionRecord["status"];
export type JobRecord = typeof schema.jobs.$inferSelect;
export type InspectionUpdate = Partial<
  Omit<
    typeof schema.inspections.$inferInsert,
    "createdAt" | "id" | "ownerUserId"
  >
>;

export interface InspectionJobSummaryRecord {
  errorCode: string | null;
  errorMessage: string | null;
  id: string;
  progressPercent: number;
  stage: string | null;
}

export interface InspectionViewRecord {
  inspection: InspectionRecord;
  job: InspectionJobSummaryRecord | null;
}

export interface UploadCompletionRecord {
  inspection: InspectionRecord;
  job: JobRecord | null;
}

export class InspectionStateConflictError extends Error {
  constructor(readonly status: InspectionStatus) {
    super(`Inspection cannot complete upload from status ${status}`);
    this.name = "InspectionStateConflictError";
  }
}

export interface InspectionListCursor {
  createdAt: Date;
  id: string;
}

export interface ListOwnedInspectionsOptions {
  cursor?: InspectionListCursor;
  limit: number;
  status?: InspectionStatus;
}

export interface InspectionPage {
  hasMore: boolean;
  inspections: InspectionViewRecord[];
}

export interface CreateOwnedInspectionInput {
  declaredContentType: string | null;
  declaredFileName: string | null;
  declaredSizeBytes: number | null;
  id: string;
  ownerUserId: string;
  sourceObjectKey: string;
  sourceType: InspectionRecord["sourceType"];
  title: string;
  workflowKey: string;
}

export interface OwnerScopedInspectionRepository {
  findOwnedById(
    ownerUserId: string,
    inspectionId: string,
  ): Promise<InspectionRecord | null>;
  updateOwnedById(
    ownerUserId: string,
    inspectionId: string,
    update: InspectionUpdate,
  ): Promise<InspectionRecord | null>;
}

export interface InspectionApiRepository extends OwnerScopedInspectionRepository {
  completeOwnedUpload(
    ownerUserId: string,
    inspectionId: string,
    inspectedSizeBytes: number,
    now: Date,
  ): Promise<UploadCompletionRecord | null>;
  createOwned(input: CreateOwnedInspectionInput): Promise<InspectionRecord>;
  findOwnedUploadCompletionById(
    ownerUserId: string,
    inspectionId: string,
  ): Promise<UploadCompletionRecord | null>;
  findOwnedViewById(
    ownerUserId: string,
    inspectionId: string,
  ): Promise<InspectionViewRecord | null>;
  listOwned(
    ownerUserId: string,
    options: ListOwnedInspectionsOptions,
  ): Promise<InspectionPage>;
  markOwnedJobDispatched(
    ownerUserId: string,
    inspectionId: string,
    jobId: string,
    dispatchGeneration: number,
    taskName: string,
    now: Date,
  ): Promise<UploadCompletionRecord | null>;
}

export class PostgresInspectionRepository implements InspectionApiRepository {
  constructor(private readonly database: PostgresJsDatabase<typeof schema>) {}

  async completeOwnedUpload(
    ownerUserId: string,
    inspectionId: string,
    inspectedSizeBytes: number,
    now: Date,
  ): Promise<UploadCompletionRecord | null> {
    return this.database.transaction(async (transaction) => {
      const [inspection] = await transaction
        .select()
        .from(schema.inspections)
        .where(
          and(
            eq(schema.inspections.id, inspectionId),
            eq(schema.inspections.ownerUserId, ownerUserId),
          ),
        )
        .limit(1)
        .for("update");

      if (!inspection) {
        return null;
      }

      const [existingJob] = await transaction
        .select({ job: schema.jobs })
        .from(schema.jobs)
        .innerJoin(
          schema.inspections,
          and(
            eq(schema.inspections.id, schema.jobs.inspectionId),
            eq(schema.inspections.ownerUserId, ownerUserId),
          ),
        )
        .where(eq(schema.jobs.inspectionId, inspection.id))
        .limit(1);

      if (existingJob) {
        return { inspection, job: existingJob.job };
      }
      if (inspection.status !== "awaiting_upload") {
        throw new InspectionStateConflictError(inspection.status);
      }

      const [queuedInspection] = await transaction
        .update(schema.inspections)
        .set({
          inspectedSizeBytes,
          queuedAt: now,
          status: "queued",
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.inspections.id, inspectionId),
            eq(schema.inspections.ownerUserId, ownerUserId),
            eq(schema.inspections.status, "awaiting_upload"),
          ),
        )
        .returning();
      if (!queuedInspection) {
        throw new InspectionStateConflictError(inspection.status);
      }

      const [job] = await transaction
        .insert(schema.jobs)
        .values({ inspectionId: queuedInspection.id })
        .returning();
      if (!job) {
        throw new Error("Job insert returned no row");
      }

      return { inspection: queuedInspection, job };
    });
  }

  async createOwned(
    input: CreateOwnedInspectionInput,
  ): Promise<InspectionRecord> {
    const [inspection] = await this.database
      .insert(schema.inspections)
      .values(input)
      .returning();

    if (!inspection) {
      throw new Error("Inspection insert returned no row");
    }
    return inspection;
  }

  async findOwnedById(
    ownerUserId: string,
    inspectionId: string,
  ): Promise<InspectionRecord | null> {
    const [inspection] = await this.database
      .select()
      .from(schema.inspections)
      .where(
        and(
          eq(schema.inspections.id, inspectionId),
          eq(schema.inspections.ownerUserId, ownerUserId),
        ),
      )
      .limit(1);

    return inspection ?? null;
  }

  async findOwnedUploadCompletionById(
    ownerUserId: string,
    inspectionId: string,
  ): Promise<UploadCompletionRecord | null> {
    const [record] = await this.database
      .select({ inspection: schema.inspections, job: schema.jobs })
      .from(schema.inspections)
      .leftJoin(
        schema.jobs,
        eq(schema.jobs.inspectionId, schema.inspections.id),
      )
      .where(
        and(
          eq(schema.inspections.id, inspectionId),
          eq(schema.inspections.ownerUserId, ownerUserId),
        ),
      )
      .limit(1);

    return record ?? null;
  }

  async updateOwnedById(
    ownerUserId: string,
    inspectionId: string,
    update: InspectionUpdate,
  ): Promise<InspectionRecord | null> {
    const [inspection] = await this.database
      .update(schema.inspections)
      .set(update)
      .where(
        and(
          eq(schema.inspections.id, inspectionId),
          eq(schema.inspections.ownerUserId, ownerUserId),
        ),
      )
      .returning();

    return inspection ?? null;
  }

  async findOwnedViewById(
    ownerUserId: string,
    inspectionId: string,
  ): Promise<InspectionViewRecord | null> {
    const [record] = await this.inspectionViewQuery()
      .where(
        and(
          eq(schema.inspections.ownerUserId, ownerUserId),
          eq(schema.inspections.id, inspectionId),
        ),
      )
      .limit(1);

    return record ?? null;
  }

  async listOwned(
    ownerUserId: string,
    options: ListOwnedInspectionsOptions,
  ): Promise<InspectionPage> {
    const conditions: SQL[] = [eq(schema.inspections.ownerUserId, ownerUserId)];
    if (options.status) {
      conditions.push(eq(schema.inspections.status, options.status));
    }
    if (options.cursor) {
      const olderThanCursor = or(
        lt(schema.inspections.createdAt, options.cursor.createdAt),
        and(
          eq(schema.inspections.createdAt, options.cursor.createdAt),
          lt(schema.inspections.id, options.cursor.id),
        ),
      );
      if (olderThanCursor) {
        conditions.push(olderThanCursor);
      }
    }

    const records = await this.inspectionViewQuery()
      .where(and(...conditions))
      .orderBy(desc(schema.inspections.createdAt), desc(schema.inspections.id))
      .limit(options.limit + 1);

    return {
      hasMore: records.length > options.limit,
      inspections: records.slice(0, options.limit),
    };
  }

  async markOwnedJobDispatched(
    ownerUserId: string,
    inspectionId: string,
    jobId: string,
    dispatchGeneration: number,
    taskName: string,
    now: Date,
  ): Promise<UploadCompletionRecord | null> {
    return this.database.transaction(async (transaction) => {
      const [ownedJob] = await transaction
        .select({ job: schema.jobs })
        .from(schema.jobs)
        .innerJoin(
          schema.inspections,
          and(
            eq(schema.inspections.id, schema.jobs.inspectionId),
            eq(schema.inspections.ownerUserId, ownerUserId),
          ),
        )
        .where(
          and(
            eq(schema.jobs.id, jobId),
            eq(schema.jobs.inspectionId, inspectionId),
            eq(schema.jobs.dispatchGeneration, dispatchGeneration),
          ),
        )
        .limit(1)
        .for("update");

      if (!ownedJob) {
        return null;
      }

      if (
        ownedJob.job.status === "pending_dispatch" &&
        ownedJob.job.taskEnqueuedAt === null
      ) {
        await transaction
          .update(schema.jobs)
          .set({
            status: "queued",
            taskEnqueuedAt: now,
            taskName,
            updatedAt: now,
          })
          .where(
            and(
              eq(schema.jobs.id, jobId),
              eq(schema.jobs.inspectionId, inspectionId),
              eq(schema.jobs.dispatchGeneration, dispatchGeneration),
              eq(schema.jobs.status, "pending_dispatch"),
              isNull(schema.jobs.taskEnqueuedAt),
              inArray(
                schema.jobs.inspectionId,
                transaction
                  .select({ id: schema.inspections.id })
                  .from(schema.inspections)
                  .where(
                    and(
                      eq(schema.inspections.id, inspectionId),
                      eq(schema.inspections.ownerUserId, ownerUserId),
                    ),
                  ),
              ),
            ),
          );
      }

      const [record] = await transaction
        .select({ inspection: schema.inspections, job: schema.jobs })
        .from(schema.inspections)
        .innerJoin(
          schema.jobs,
          eq(schema.jobs.inspectionId, schema.inspections.id),
        )
        .where(
          and(
            eq(schema.inspections.id, inspectionId),
            eq(schema.inspections.ownerUserId, ownerUserId),
            eq(schema.jobs.id, jobId),
          ),
        )
        .limit(1);

      return record ?? null;
    });
  }

  private inspectionViewQuery() {
    return this.database
      .select({
        inspection: schema.inspections,
        job: {
          id: schema.jobs.id,
          errorCode: schema.jobs.errorCode,
          errorMessage: schema.jobs.errorMessage,
          progressPercent: schema.jobs.progressPercent,
          stage: schema.jobs.stage,
        },
      })
      .from(schema.inspections)
      .leftJoin(
        schema.jobs,
        eq(schema.jobs.inspectionId, schema.inspections.id),
      )
      .$dynamic();
  }
}
