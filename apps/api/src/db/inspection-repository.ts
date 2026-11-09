import { and, desc, eq, lt, or, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "./schema.js";

export type InspectionRecord = typeof schema.inspections.$inferSelect;
export type InspectionStatus = InspectionRecord["status"];
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
  createOwned(input: CreateOwnedInspectionInput): Promise<InspectionRecord>;
  findOwnedViewById(
    ownerUserId: string,
    inspectionId: string,
  ): Promise<InspectionViewRecord | null>;
  listOwned(
    ownerUserId: string,
    options: ListOwnedInspectionsOptions,
  ): Promise<InspectionPage>;
}

export class PostgresInspectionRepository implements InspectionApiRepository {
  constructor(private readonly database: PostgresJsDatabase<typeof schema>) {}

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
