import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as schema from "./schema.js";

export type InspectionRecord = typeof schema.inspections.$inferSelect;
export type InspectionUpdate = Partial<
  Omit<
    typeof schema.inspections.$inferInsert,
    "createdAt" | "id" | "ownerUserId"
  >
>;

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

export class PostgresInspectionRepository implements OwnerScopedInspectionRepository {
  constructor(private readonly database: PostgresJsDatabase<typeof schema>) {}

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
}
