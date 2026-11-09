import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresAuthStore } from "../src/db/auth-store.js";
import { PostgresInspectionRepository } from "../src/db/inspection-repository.js";
import * as schema from "../src/db/schema.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL must identify an empty PostgreSQL database for the integration test.",
  );
}

describe("PostgreSQL migrations", () => {
  let sql: postgres.Sql;
  let database: PostgresJsDatabase<typeof schema>;

  beforeAll(async () => {
    sql = postgres(databaseUrl, { max: 1 });
    database = drizzle(sql, { schema });
    await migrate(database, { migrationsFolder });
  }, 60_000);

  afterAll(async () => {
    await sql?.end();
  });

  it("creates the four tables and enforces identity, ownership, and job constraints", async () => {
    const tables = await sql<{ table_name: string }[]>`
      select table_name
      from information_schema.tables
      where table_schema = 'public'
        and table_name in ('users', 'sessions', 'inspections', 'jobs')
      order by table_name
    `;

    expect(tables.map(({ table_name }) => table_name)).toEqual([
      "inspections",
      "jobs",
      "sessions",
      "users",
    ]);

    const [user] = await sql<{ id: string }[]>`
      insert into users (google_subject, email, display_name)
      values ('google-subject-1', 'owner@example.com', 'Factory Owner')
      returning id
    `;
    expect(user).toBeDefined();

    await expect(
      sql`
        insert into users (google_subject, email, display_name)
        values ('google-subject-1', 'other@example.com', 'Other Owner')
      `,
    ).rejects.toMatchObject({ code: "23505" });

    await sql`
      insert into sessions (user_id, token_hash, expires_at)
      values (${user!.id}, ${"a".repeat(64)}, now() + interval '1 hour')
    `;

    await expect(
      sql`
        insert into sessions (user_id, token_hash, expires_at)
        values (${user!.id}, ${"a".repeat(64)}, now() + interval '2 hours')
      `,
    ).rejects.toMatchObject({ code: "23505" });

    await expect(
      sql`
        insert into sessions (user_id, token_hash, expires_at)
        values (${randomUUID()}, ${"b".repeat(64)}, now() + interval '1 hour')
      `,
    ).rejects.toMatchObject({ code: "23503" });

    const [inspection] = await sql<{ id: string; status: string }[]>`
      insert into inspections (
        owner_user_id,
        title,
        source_type,
        workflow_key,
        source_object_key,
        declared_file_name,
        declared_content_type,
        declared_size_bytes
      )
      values (
        ${user!.id},
        'Assembly line review',
        'upload',
        'factory-safety-v1',
        'inspections/source.webm',
        'source.webm',
        'video/webm',
        1024
      )
      returning id, status
    `;
    expect(inspection?.status).toBe("awaiting_upload");

    const [job] = await sql<
      {
        attempt_count: number;
        dispatch_generation: number;
        max_attempts: number;
        progress_percent: number;
        status: string;
      }[]
    >`
      insert into jobs (inspection_id)
      values (${inspection!.id})
      returning
        attempt_count,
        dispatch_generation,
        max_attempts,
        progress_percent,
        status
    `;
    expect(job).toEqual({
      attempt_count: 0,
      dispatch_generation: 1,
      max_attempts: 3,
      progress_percent: 0,
      status: "pending_dispatch",
    });

    await expect(
      sql`insert into jobs (inspection_id) values (${inspection!.id})`,
    ).rejects.toMatchObject({ code: "23505" });

    await expect(
      sql`update jobs set progress_percent = 101 where inspection_id = ${inspection!.id}`,
    ).rejects.toMatchObject({ code: "23514" });

    const indexes = await sql<{ indexname: string }[]>`
      select indexname
      from pg_indexes
      where schemaname = 'public'
    `;
    expect(indexes.map(({ indexname }) => indexname)).toEqual(
      expect.arrayContaining([
        "inspections_owner_history_idx",
        "inspections_owner_active_idx",
        "jobs_pending_dispatch_idx",
        "jobs_stale_lease_idx",
      ]),
    );
  });

  it("upserts users by Google subject and rejects expired and revoked sessions", async () => {
    const store = new PostgresAuthStore(database);
    const now = new Date("2026-11-09T08:00:00.000Z");
    const expiresAt = new Date("2026-12-09T08:00:00.000Z");
    const firstHash = createHash("sha256").update("first-token").digest("hex");
    const secondHash = createHash("sha256")
      .update("second-token")
      .digest("hex");
    const firstUser = await store.createSession(
      {
        googleSubject: "stable-google-subject",
        email: "first@example.com",
        displayName: "First Profile",
        avatarUrl: null,
      },
      firstHash,
      expiresAt,
      now,
    );
    const updatedUser = await store.createSession(
      {
        googleSubject: "stable-google-subject",
        email: "updated@example.com",
        displayName: "Updated Profile",
        avatarUrl: "https://images.example/profile.png",
      },
      secondHash,
      expiresAt,
      new Date(now.getTime() + 1_000),
    );

    expect(updatedUser).toMatchObject({
      id: firstUser.id,
      email: "updated@example.com",
      displayName: "Updated Profile",
    });
    await expect(store.findActiveUser(firstHash, now)).resolves.toMatchObject({
      id: firstUser.id,
      email: "updated@example.com",
    });

    const storedSessions = await sql<
      { token_hash: string }[]
    >`select token_hash from sessions where user_id = ${firstUser.id}`;
    expect(storedSessions.map(({ token_hash }) => token_hash)).toEqual(
      expect.arrayContaining([firstHash, secondHash]),
    );
    expect(JSON.stringify(storedSessions)).not.toContain("first-token");

    await store.revokeSession(firstHash, new Date(now.getTime() + 2_000));
    await expect(store.findActiveUser(firstHash, now)).resolves.toBeNull();

    const expiredHash = createHash("sha256")
      .update("expired-token")
      .digest("hex");
    await store.createSession(
      {
        googleSubject: "expired-google-subject",
        email: "expired@example.com",
        displayName: "Expired Profile",
        avatarUrl: null,
      },
      expiredHash,
      new Date(now.getTime() - 1),
      new Date(now.getTime() - 10_000),
    );
    await expect(store.findActiveUser(expiredHash, now)).resolves.toBeNull();
  });

  it("scopes inspection reads and writes to the current owner", async () => {
    const [owner, otherOwner] = await sql<{ id: string }[]>`
      insert into users (google_subject, email, display_name)
      values
        ('repository-owner', 'repository-owner@example.com', 'Repository Owner'),
        ('repository-other', 'repository-other@example.com', 'Other Owner')
      returning id
    `;
    const [inspection] = await sql<{ id: string }[]>`
      insert into inspections (
        owner_user_id,
        title,
        source_type,
        workflow_key,
        source_object_key
      )
      values (
        ${owner!.id},
        'Owner-only inspection',
        'upload',
        'factory-safety-v1',
        'inspections/owner-only/source'
      )
      returning id
    `;
    const repository = new PostgresInspectionRepository(database);

    await expect(
      repository.findOwnedById(owner!.id, inspection!.id),
    ).resolves.toMatchObject({
      id: inspection!.id,
      ownerUserId: owner!.id,
      title: "Owner-only inspection",
    });
    await expect(
      repository.findOwnedById(otherOwner!.id, inspection!.id),
    ).resolves.toBeNull();
    await expect(
      repository.findOwnedById(otherOwner!.id, randomUUID()),
    ).resolves.toBeNull();

    await expect(
      repository.updateOwnedById(otherOwner!.id, inspection!.id, {
        title: "Cross-user mutation",
      }),
    ).resolves.toBeNull();
    await expect(
      repository.updateOwnedById(owner!.id, inspection!.id, {
        title: "Owner update",
      }),
    ).resolves.toMatchObject({
      id: inspection!.id,
      ownerUserId: owner!.id,
      title: "Owner update",
    });

    const [storedInspection] = await sql<
      { owner_user_id: string; title: string }[]
    >`
      select owner_user_id, title
      from inspections
      where id = ${inspection!.id}
    `;
    expect(storedInspection).toEqual({
      owner_user_id: owner!.id,
      title: "Owner update",
    });
  });
});
