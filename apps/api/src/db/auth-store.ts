import type { User } from "@factorylens/contracts";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type { AuthStore, OidcIdentity } from "../auth.js";
import * as schema from "./schema.js";

export class PostgresAuthStore implements AuthStore {
  constructor(private readonly database: PostgresJsDatabase<typeof schema>) {}

  async createSession(
    identity: OidcIdentity,
    tokenHash: string,
    expiresAt: Date,
    now: Date,
  ): Promise<User> {
    return this.database.transaction(async (transaction) => {
      const [user] = await transaction
        .insert(schema.users)
        .values({
          googleSubject: identity.googleSubject,
          email: identity.email,
          displayName: identity.displayName,
          avatarUrl: identity.avatarUrl,
          createdAt: now,
          updatedAt: now,
          lastLoginAt: now,
        })
        .onConflictDoUpdate({
          target: schema.users.googleSubject,
          set: {
            email: identity.email,
            displayName: identity.displayName,
            avatarUrl: identity.avatarUrl,
            updatedAt: now,
            lastLoginAt: now,
          },
        })
        .returning({
          id: schema.users.id,
          email: schema.users.email,
          displayName: schema.users.displayName,
          avatarUrl: schema.users.avatarUrl,
        });
      if (!user) {
        throw new Error("User upsert returned no row");
      }

      await transaction.insert(schema.sessions).values({
        userId: user.id,
        tokenHash,
        expiresAt,
        lastSeenAt: now,
        createdAt: now,
      });

      return user;
    });
  }

  async findActiveUser(tokenHash: string, now: Date): Promise<User | null> {
    const [session] = await this.database
      .update(schema.sessions)
      .set({ lastSeenAt: now })
      .where(
        and(
          eq(schema.sessions.tokenHash, tokenHash),
          isNull(schema.sessions.revokedAt),
          gt(schema.sessions.expiresAt, now),
        ),
      )
      .returning({ userId: schema.sessions.userId });
    if (!session) {
      return null;
    }

    const [user] = await this.database
      .select({
        id: schema.users.id,
        email: schema.users.email,
        displayName: schema.users.displayName,
        avatarUrl: schema.users.avatarUrl,
      })
      .from(schema.users)
      .where(eq(schema.users.id, session.userId))
      .limit(1);

    return user ?? null;
  }

  async revokeSession(tokenHash: string, now: Date): Promise<void> {
    await this.database
      .update(schema.sessions)
      .set({ revokedAt: now })
      .where(
        and(
          eq(schema.sessions.tokenHash, tokenHash),
          isNull(schema.sessions.revokedAt),
        ),
      );
  }
}
