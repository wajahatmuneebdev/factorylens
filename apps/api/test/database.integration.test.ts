import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const databaseUrl = process.env.TEST_DATABASE_URL;

if (!databaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL must identify an empty PostgreSQL database for the integration test.",
  );
}

describe("PostgreSQL migrations", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = postgres(databaseUrl, { max: 1 });
    await migrate(drizzle(sql), { migrationsFolder });
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
});
