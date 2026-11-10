import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  ERROR_DEFINITIONS,
  type ErrorCode,
  type InspectionState,
  type JobState,
} from "@factorylens/contracts";
import { drizzle } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import type { OidcProvider } from "../src/auth.js";
import { PostgresAuthStore } from "../src/db/auth-store.js";
import { PostgresInspectionRepository } from "../src/db/inspection-repository.js";
import * as schema from "../src/db/schema.js";
import { hashSessionToken } from "../src/session.js";
import {
  LocalFilesystemStorage,
  type ObjectAccessAuthorizer,
} from "../src/storage.js";
import {
  deterministicTaskName,
  type TaskDispatcher,
} from "../src/task-dispatcher.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const databaseUrl = process.env.TEST_DATABASE_URL;
const appOrigin = new URL("https://factorylens.example");
const currentTime = new Date("2026-11-09T08:00:00.000Z");

const oidcProvider: OidcProvider = {
  async createAuthorizationRequest() {
    throw new Error("OIDC is not used by upload integration tests");
  },
  async exchangeAuthorizationCode() {
    throw new Error("OIDC is not used by upload integration tests");
  },
};

class RecordingTaskDispatcher implements TaskDispatcher {
  readonly messages: { dispatchGeneration: number; jobId: string }[] = [];
  fail = false;
  onDispatch?: (jobId: string) => Promise<void>;

  async dispatch(message: { dispatchGeneration: number; jobId: string }) {
    this.messages.push({ ...message });
    if (this.fail) {
      throw new Error("simulated dispatch failure");
    }
    await this.onDispatch?.(message.jobId);
    return {
      outcome: "dispatched" as const,
      taskName: deterministicTaskName(message),
    };
  }
}

if (!databaseUrl) {
  throw new Error(
    "TEST_DATABASE_URL must identify an empty PostgreSQL database for the integration test.",
  );
}

describe("PostgreSQL migrations", () => {
  let sql: postgres.Sql;
  let database: PostgresJsDatabase<typeof schema>;
  const storageRoots: string[] = [];

  beforeAll(async () => {
    sql = postgres(databaseUrl, { max: 1 });
    database = drizzle(sql, { schema });
    await migrate(database, { migrationsFolder });
  }, 60_000);

  afterAll(async () => {
    await sql?.end();
    await Promise.all(
      storageRoots.map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  async function createUploadHarness(dispatcher: TaskDispatcher) {
    const store = new PostgresAuthStore(database);
    const token = randomUUID();
    const identitySuffix = randomUUID();
    const user = await store.createSession(
      {
        googleSubject: `upload-${identitySuffix}`,
        email: `upload-${identitySuffix}@example.com`,
        displayName: "Upload Owner",
        avatarUrl: null,
      },
      hashSessionToken(token),
      new Date("2026-12-09T08:00:00.000Z"),
      currentTime,
    );
    const storageRoot = await mkdtemp(
      join(tmpdir(), "factorylens-upload-integration-"),
    );
    storageRoots.push(storageRoot);
    const storage = new LocalFilesystemStorage(storageRoot);
    const objectAccess: ObjectAccessAuthorizer = {
      async authorizeDownload(key) {
        return {
          url: `https://storage.example/${key}?signature=download`,
          expiresAt: new Date(currentTime.getTime() + 10 * 60 * 1000),
        };
      },
      async authorizeUpload(key, contentType) {
        return {
          method: "PUT",
          url: `https://storage.example/${key}?signature=upload`,
          headers: { "Content-Type": contentType },
          expiresAt: new Date(currentTime.getTime() + 10 * 60 * 1000),
        };
      },
    };
    const repository = new PostgresInspectionRepository(database);
    const app = createApp({
      appOrigin,
      callbackUrl: new URL("/auth/google/callback", appOrigin),
      inspections: repository,
      now: () => currentTime,
      objectAccess,
      oidcProvider,
      storage,
      store,
      taskDispatcher: dispatcher,
      transactionSecret: "a-secure-test-secret-that-is-long-enough",
    });

    return { app, repository, storage, token, user };
  }

  async function createUploadInspection(
    repository: PostgresInspectionRepository,
    ownerUserId: string,
    declaredSizeBytes = 4096,
  ) {
    const id = randomUUID();
    return repository.createOwned({
      id,
      ownerUserId,
      title: "Assembly line upload",
      sourceType: "upload",
      workflowKey: "factory-safety-v1",
      sourceObjectKey: `inspections/${id}/source`,
      declaredFileName: "line.webm",
      declaredContentType: "video/webm",
      declaredSizeBytes,
    });
  }

  function completeUpload(
    app: ReturnType<typeof createApp>,
    token: string,
    inspectionId: string,
  ) {
    return request(app)
      .post(`/api/inspections/${inspectionId}/upload-complete`)
      .set("Origin", appOrigin.origin)
      .set("Cookie", `__Host-factorylens_session=${token}`)
      .send({});
  }

  function runInspectionCommand(
    app: ReturnType<typeof createApp>,
    token: string,
    inspectionId: string,
    command: "cancel" | "retry",
  ) {
    return request(app)
      .post(`/api/inspections/${inspectionId}/${command}`)
      .set("Origin", appOrigin.origin)
      .set("Cookie", `__Host-factorylens_session=${token}`)
      .send({});
  }

  async function createCommandInspection(
    ownerUserId: string,
    inspectionStatus: InspectionState,
    jobStatus: JobState | null,
    errorCode: ErrorCode | null = null,
  ) {
    const inspectionId = randomUUID();
    const predictionObjectKey = `inspections/${inspectionId}/predictions/generation-4.json`;
    await sql`
      insert into inspections (
        id,
        owner_user_id,
        title,
        status,
        source_type,
        workflow_key,
        source_object_key,
        prediction_object_key,
        error_code,
        error_message,
        queued_at,
        started_at,
        completed_at,
        updated_at
      )
      values (
        ${inspectionId},
        ${ownerUserId},
        'Inspection command fixture',
        ${inspectionStatus}::inspection_status,
        'upload',
        'factory-safety-v1',
        ${`inspections/${inspectionId}/source`},
        ${predictionObjectKey},
        ${errorCode},
        ${errorCode ? "A safe processing failure occurred." : null},
        ${inspectionStatus === "awaiting_upload" ? null : "2026-11-09T06:00:00.000Z"},
        ${inspectionStatus === "processing" || inspectionStatus === "completed" || inspectionStatus === "failed" ? "2026-11-09T06:10:00.000Z" : null},
        ${inspectionStatus === "completed" || inspectionStatus === "failed" || inspectionStatus === "cancelled" ? "2026-11-09T07:00:00.000Z" : null},
        '2026-11-09T07:00:00.000Z'
      )
    `;

    if (!jobStatus) {
      return { inspectionId, jobId: null, predictionObjectKey };
    }

    const jobId = randomUUID();
    const oldTaskName = deterministicTaskName({
      dispatchGeneration: 4,
      jobId,
    });
    await sql`
      insert into jobs (
        id,
        inspection_id,
        status,
        stage,
        progress_percent,
        attempt_count,
        dispatch_generation,
        task_name,
        task_enqueued_at,
        cancel_requested_at,
        error_code,
        error_message,
        started_at,
        finished_at,
        updated_at
      )
      values (
        ${jobId},
        ${inspectionId},
        ${jobStatus}::job_status,
        'workflow',
        75,
        3,
        4,
        ${oldTaskName},
        '2026-11-09T06:00:00.000Z',
        ${inspectionStatus === "cancelled" ? "2026-11-09T06:30:00.000Z" : null},
        ${errorCode},
        ${errorCode ? "A safe processing failure occurred." : null},
        '2026-11-09T06:10:00.000Z',
        ${jobStatus === "failed" || jobStatus === "completed" || jobStatus === "cancelled" ? "2026-11-09T07:00:00.000Z" : null},
        '2026-11-09T07:00:00.000Z'
      )
    `;
    return { inspectionId, jobId, predictionObjectKey };
  }

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

  it("creates and pages owner history in stable newest-first order", async () => {
    const [owner, otherOwner, emptyOwner] = await sql<{ id: string }[]>`
      insert into users (google_subject, email, display_name)
      values
        ('history-owner', 'history-owner@example.com', 'History Owner'),
        ('history-other', 'history-other@example.com', 'History Other'),
        ('history-empty', 'history-empty@example.com', 'History Empty')
      returning id
    `;
    const repository = new PostgresInspectionRepository(database);
    const created = await repository.createOwned({
      id: "10000000-0000-4000-8000-000000000001",
      ownerUserId: owner!.id,
      title: "Created through repository",
      sourceType: "recording",
      workflowKey: "factory-safety-v1",
      sourceObjectKey:
        "inspections/10000000-0000-4000-8000-000000000001/source",
      declaredFileName: "recording.webm",
      declaredContentType: "video/webm",
      declaredSizeBytes: 2048,
    });
    expect(created).toMatchObject({
      ownerUserId: owner!.id,
      status: "awaiting_upload",
    });
    await sql`
      update inspections
      set
        created_at = '2026-11-09T07:59:59.000Z',
        updated_at = '2026-11-09T07:59:59.000Z'
      where id = ${created.id}
    `;

    const olderId = "20000000-0000-4000-8000-000000000001";
    const tiedLowerId = "30000000-0000-4000-8000-000000000001";
    const tiedHigherId = "40000000-0000-4000-8000-000000000001";
    await sql`
      insert into inspections (
        id,
        owner_user_id,
        title,
        source_type,
        workflow_key,
        source_object_key,
        created_at,
        updated_at
      )
      values
        (
          ${olderId},
          ${owner!.id},
          'Older',
          'upload',
          'factory-safety-v1',
          ${`inspections/${olderId}/source`},
          '2026-11-09T08:00:00.000Z',
          '2026-11-09T08:00:00.000Z'
        ),
        (
          ${tiedLowerId},
          ${owner!.id},
          'Tied lower',
          'upload',
          'factory-safety-v1',
          ${`inspections/${tiedLowerId}/source`},
          '2026-11-09T08:00:02.000Z',
          '2026-11-09T08:00:02.000Z'
        ),
        (
          ${tiedHigherId},
          ${owner!.id},
          'Tied higher',
          'upload',
          'factory-safety-v1',
          ${`inspections/${tiedHigherId}/source`},
          '2026-11-09T08:00:02.000Z',
          '2026-11-09T08:00:02.000Z'
        ),
        (
          ${randomUUID()},
          ${otherOwner!.id},
          'Other owner newest',
          'upload',
          'factory-safety-v1',
          'inspections/other-owner/source',
          '2026-11-09T08:00:03.000Z',
          '2026-11-09T08:00:03.000Z'
        )
    `;
    await sql`
      insert into jobs (inspection_id, status, stage, progress_percent)
      values (${tiedHigherId}, 'running', 'workflow', 45)
    `;

    await expect(
      repository.listOwned(emptyOwner!.id, { limit: 20 }),
    ).resolves.toEqual({ hasMore: false, inspections: [] });

    const firstPage = await repository.listOwned(owner!.id, { limit: 2 });
    expect(firstPage.hasMore).toBe(true);
    expect(
      firstPage.inspections.map(({ inspection }) => inspection.id),
    ).toEqual([tiedHigherId, tiedLowerId]);
    expect(firstPage.inspections[0]?.job).toMatchObject({
      progressPercent: 45,
      stage: "workflow",
    });

    const secondPage = await repository.listOwned(owner!.id, {
      cursor: {
        createdAt: firstPage.inspections[1]!.inspection.createdAt,
        id: firstPage.inspections[1]!.inspection.id,
      },
      limit: 20,
    });
    expect(
      secondPage.inspections.map(({ inspection }) => inspection.id),
    ).toEqual([olderId, created.id]);
    expect(
      secondPage.inspections.every(
        ({ inspection }) => inspection.ownerUserId === owner!.id,
      ),
    ).toBe(true);

    await expect(
      repository.findOwnedViewById(otherOwner!.id, tiedHigherId),
    ).resolves.toBeNull();
    await expect(
      repository.findOwnedViewById(owner!.id, tiedHigherId),
    ).resolves.toMatchObject({
      inspection: { id: tiedHigherId, ownerUserId: owner!.id },
      job: { progressPercent: 45, stage: "workflow" },
    });
  });

  it("rejects missing objects and size mismatches without creating jobs", async () => {
    const dispatcher = new RecordingTaskDispatcher();
    const { app, repository, storage, token, user } =
      await createUploadHarness(dispatcher);
    const missing = await createUploadInspection(repository, user.id);
    const mismatched = await createUploadInspection(repository, user.id);
    await storage.put(
      mismatched.sourceObjectKey,
      Readable.from([Buffer.alloc(4095)]),
    );

    const missingResponse = await completeUpload(app, token, missing.id);
    const mismatchResponse = await completeUpload(app, token, mismatched.id);

    expect(missingResponse.status).toBe(400);
    expect(missingResponse.body.error.code).toBe("invalid_media");
    expect(mismatchResponse.status).toBe(400);
    expect(mismatchResponse.body.error.code).toBe("invalid_media");
    const [jobCount] = await sql<{ count: number }[]>`
      select count(*)::int as count
      from jobs
      where inspection_id in (${missing.id}, ${mismatched.id})
    `;
    expect(jobCount?.count).toBe(0);
    expect(dispatcher.messages).toEqual([]);
  });

  it("commits one pending job before dispatch and returns that job for duplicate completion", async () => {
    const dispatcher = new RecordingTaskDispatcher();
    const { app, repository, storage, token, user } =
      await createUploadHarness(dispatcher);
    const inspection = await createUploadInspection(repository, user.id);
    await storage.put(
      inspection.sourceObjectKey,
      Readable.from([Buffer.alloc(4096)]),
    );
    dispatcher.onDispatch = async (jobId) => {
      const [committed] = await sql<
        {
          inspection_status: string;
          job_status: string;
          task_enqueued_at: string | null;
        }[]
      >`
        select
          inspections.status as inspection_status,
          jobs.status as job_status,
          jobs.task_enqueued_at
        from jobs
        inner join inspections on inspections.id = jobs.inspection_id
        where jobs.id = ${jobId}
      `;
      expect(committed).toEqual({
        inspection_status: "queued",
        job_status: "pending_dispatch",
        task_enqueued_at: null,
      });
    };

    const first = await completeUpload(app, token, inspection.id);
    const duplicate = await completeUpload(app, token, inspection.id);

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      inspection: { id: inspection.id, status: "queued" },
      job: { status: "queued" },
    });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.job).toEqual(first.body.job);
    expect(dispatcher.messages).toEqual([
      { jobId: first.body.job.id, dispatchGeneration: 1 },
    ]);

    const [stored] = await sql<
      {
        count: number;
        status: string;
        task_enqueued_at: string | null;
        task_name: string | null;
      }[]
    >`
      select
        count(*) over ()::int as count,
        status,
        task_enqueued_at,
        task_name
      from jobs
      where inspection_id = ${inspection.id}
    `;
    expect(stored).toMatchObject({
      count: 1,
      status: "queued",
      task_name: deterministicTaskName({
        jobId: first.body.job.id,
        dispatchGeneration: 1,
      }),
    });
    expect(new Date(stored!.task_enqueued_at!).toISOString()).toBe(
      currentTime.toISOString(),
    );
  });

  it("does not dispatch when the upload-completion transaction fails to commit", async () => {
    const dispatcher = new RecordingTaskDispatcher();
    const { app, repository, storage, token, user } =
      await createUploadHarness(dispatcher);
    const inspection = await createUploadInspection(repository, user.id);
    await storage.put(
      inspection.sourceObjectKey,
      Readable.from([Buffer.alloc(4096)]),
    );

    await sql`
      create function fail_upload_job_commit() returns trigger
      language plpgsql
      as $$
      begin
        raise exception 'simulated upload job commit failure';
      end
      $$
    `;
    await sql`
      create constraint trigger fail_upload_job_commit
      after insert on jobs
      deferrable initially deferred
      for each row execute function fail_upload_job_commit()
    `;

    let response;
    try {
      response = await completeUpload(app, token, inspection.id);
    } finally {
      await sql`drop trigger fail_upload_job_commit on jobs`;
      await sql`drop function fail_upload_job_commit()`;
    }

    expect(response.status).toBe(503);
    expect(dispatcher.messages).toEqual([]);
    const [stored] = await sql<{ job_count: number; status: string }[]>`
      select
        inspections.status,
        count(jobs.id)::int as job_count
      from inspections
      left join jobs on jobs.inspection_id = inspections.id
      where inspections.id = ${inspection.id}
      group by inspections.id
    `;
    expect(stored).toEqual({ status: "awaiting_upload", job_count: 0 });
  });

  it("leaves dispatch failures pending and recovers the same job on retry", async () => {
    const dispatcher = new RecordingTaskDispatcher();
    dispatcher.fail = true;
    const { app, repository, storage, token, user } =
      await createUploadHarness(dispatcher);
    const inspection = await createUploadInspection(repository, user.id);
    await storage.put(
      inspection.sourceObjectKey,
      Readable.from([Buffer.alloc(4096)]),
    );

    const failed = await completeUpload(app, token, inspection.id);
    expect(failed.status).toBe(503);
    const [pending] = await sql<
      {
        id: string;
        status: string;
        task_enqueued_at: string | null;
        task_name: string | null;
      }[]
    >`
      select id, status, task_enqueued_at, task_name
      from jobs
      where inspection_id = ${inspection.id}
    `;
    expect(pending).toMatchObject({
      status: "pending_dispatch",
      task_enqueued_at: null,
      task_name: null,
    });

    dispatcher.fail = false;
    const recovered = await completeUpload(app, token, inspection.id);

    expect(recovered.status).toBe(200);
    expect(recovered.body.job).toEqual({
      id: pending!.id,
      status: "queued",
    });
    expect(dispatcher.messages).toEqual([
      { jobId: pending!.id, dispatchGeneration: 1 },
      { jobId: pending!.id, dispatchGeneration: 1 },
    ]);
    const [queued] = await sql<
      { status: string; task_enqueued_at: string | null; task_name: string }[]
    >`
      select status, task_enqueued_at, task_name
      from jobs
      where id = ${pending!.id}
    `;
    expect(queued).toMatchObject({
      status: "queued",
      task_name: deterministicTaskName({
        jobId: pending!.id,
        dispatchGeneration: 1,
      }),
    });
    expect(new Date(queued!.task_enqueued_at!).toISOString()).toBe(
      currentTime.toISOString(),
    );
  });

  it("records cancellation only for cancellable states and is idempotent", async () => {
    const dispatcher = new RecordingTaskDispatcher();
    const { app, token, user } = await createUploadHarness(dispatcher);
    const cases: {
      allowed: boolean;
      inspectionStatus: InspectionState;
      jobStatus: JobState | null;
    }[] = [
      { allowed: false, inspectionStatus: "awaiting_upload", jobStatus: null },
      { allowed: true, inspectionStatus: "queued", jobStatus: "queued" },
      { allowed: true, inspectionStatus: "processing", jobStatus: "running" },
      { allowed: false, inspectionStatus: "completed", jobStatus: "completed" },
      { allowed: false, inspectionStatus: "failed", jobStatus: "failed" },
      { allowed: true, inspectionStatus: "cancelled", jobStatus: "cancelled" },
    ];

    for (const testCase of cases) {
      const fixture = await createCommandInspection(
        user.id,
        testCase.inspectionStatus,
        testCase.jobStatus,
        testCase.inspectionStatus === "failed" ? "invalid_media" : null,
      );
      const first = await runInspectionCommand(
        app,
        token,
        fixture.inspectionId,
        "cancel",
      );

      expect(first.status, testCase.inspectionStatus).toBe(
        testCase.allowed ? 200 : 409,
      );
      if (testCase.allowed) {
        expect(first.body.inspection.status).toBe(testCase.inspectionStatus);
        const [afterFirst] = await sql<
          {
            cancel_requested_at: Date | null;
            inspection_status: string;
            prediction_object_key: string | null;
          }[]
        >`
          select
            inspections.status as inspection_status,
            inspections.prediction_object_key,
            jobs.cancel_requested_at
          from inspections
          inner join jobs on jobs.inspection_id = inspections.id
          where inspections.id = ${fixture.inspectionId}
        `;
        expect(afterFirst?.cancel_requested_at).not.toBeNull();
        expect(afterFirst?.inspection_status).toBe(testCase.inspectionStatus);
        expect(afterFirst?.prediction_object_key).toBe(
          fixture.predictionObjectKey,
        );

        const duplicate = await runInspectionCommand(
          app,
          token,
          fixture.inspectionId,
          "cancel",
        );
        expect(duplicate.status).toBe(200);
        const [afterDuplicate] = await sql<
          { cancel_requested_at: Date | null }[]
        >`
          select cancel_requested_at
          from jobs
          where inspection_id = ${fixture.inspectionId}
        `;
        expect(afterDuplicate?.cancel_requested_at).toEqual(
          afterFirst?.cancel_requested_at,
        );
      } else {
        expect(first.body.error.code).toBe("inspection_state_conflict");
        if (fixture.jobId) {
          const [job] = await sql<{ cancel_requested_at: Date | null }[]>`
            select cancel_requested_at from jobs where id = ${fixture.jobId}
          `;
          expect(job?.cancel_requested_at).toBeNull();
        }
      }
    }
    expect(dispatcher.messages).toEqual([]);
  });

  it("retries every documented retryable failure with a new dispatch generation", async () => {
    const dispatcher = new RecordingTaskDispatcher();
    const { app, token, user } = await createUploadHarness(dispatcher);
    const retryableCodes = Object.entries(ERROR_DEFINITIONS)
      .filter(([, category]) => category === "retryable")
      .map(([code]) => code as ErrorCode);

    for (const errorCode of retryableCodes) {
      const fixture = await createCommandInspection(
        user.id,
        "failed",
        "failed",
        errorCode,
      );
      const response = await runInspectionCommand(
        app,
        token,
        fixture.inspectionId,
        "retry",
      );

      expect(response.status, errorCode).toBe(200);
      expect(response.body.inspection).toMatchObject({
        id: fixture.inspectionId,
        status: "queued",
        error: null,
        progress: { stage: null, percent: 0 },
      });
      const [stored] = await sql<
        {
          attempt_count: number;
          cancel_requested_at: Date | null;
          dispatch_generation: number;
          error_code: string | null;
          inspection_status: string;
          prediction_object_key: string | null;
          progress_percent: number;
          status: string;
          task_name: string | null;
        }[]
      >`
        select
          inspections.status as inspection_status,
          inspections.prediction_object_key,
          jobs.status,
          jobs.attempt_count,
          jobs.cancel_requested_at,
          jobs.dispatch_generation,
          jobs.error_code,
          jobs.progress_percent,
          jobs.task_name
        from inspections
        inner join jobs on jobs.inspection_id = inspections.id
        where inspections.id = ${fixture.inspectionId}
      `;
      expect(stored).toMatchObject({
        attempt_count: 0,
        cancel_requested_at: null,
        dispatch_generation: 5,
        error_code: null,
        inspection_status: "queued",
        prediction_object_key: fixture.predictionObjectKey,
        progress_percent: 0,
        status: "queued",
        task_name: deterministicTaskName({
          dispatchGeneration: 5,
          jobId: fixture.jobId!,
        }),
      });
    }

    expect(dispatcher.messages).toHaveLength(retryableCodes.length);
    expect(
      dispatcher.messages.every(
        ({ dispatchGeneration }) => dispatchGeneration === 5,
      ),
    ).toBe(true);
  });

  it("rejects retry from every non-failed state and every non-retryable failure", async () => {
    const dispatcher = new RecordingTaskDispatcher();
    const { app, token, user } = await createUploadHarness(dispatcher);
    const stateCases: [InspectionState, JobState | null][] = [
      ["awaiting_upload", null],
      ["queued", "queued"],
      ["processing", "running"],
      ["completed", "completed"],
      ["cancelled", "cancelled"],
    ];

    for (const [inspectionStatus, jobStatus] of stateCases) {
      const fixture = await createCommandInspection(
        user.id,
        inspectionStatus,
        jobStatus,
        null,
      );
      const response = await runInspectionCommand(
        app,
        token,
        fixture.inspectionId,
        "retry",
      );
      expect(response.status, inspectionStatus).toBe(409);
      expect(response.body.error.code).toBe("inspection_state_conflict");
    }

    const nonRetryableCodes = Object.entries(ERROR_DEFINITIONS)
      .filter(([, category]) => category !== "retryable")
      .map(([code]) => code as ErrorCode);
    for (const errorCode of nonRetryableCodes) {
      const fixture = await createCommandInspection(
        user.id,
        "failed",
        "failed",
        errorCode,
      );
      const response = await runInspectionCommand(
        app,
        token,
        fixture.inspectionId,
        "retry",
      );
      expect(response.status, errorCode).toBe(409);
      expect(response.body.error.code).toBe("inspection_state_conflict");
    }

    expect(dispatcher.messages).toEqual([]);
  });

  it("leaves a retried generation committed and pending when dispatch fails", async () => {
    const dispatcher = new RecordingTaskDispatcher();
    dispatcher.fail = true;
    const { app, token, user } = await createUploadHarness(dispatcher);
    const fixture = await createCommandInspection(
      user.id,
      "failed",
      "failed",
      "provider_unavailable",
    );

    const response = await runInspectionCommand(
      app,
      token,
      fixture.inspectionId,
      "retry",
    );

    expect(response.status).toBe(503);
    const [stored] = await sql<
      {
        dispatch_generation: number;
        inspection_status: string;
        prediction_object_key: string | null;
        status: string;
        task_enqueued_at: Date | null;
        task_name: string | null;
      }[]
    >`
      select
        inspections.status as inspection_status,
        inspections.prediction_object_key,
        jobs.status,
        jobs.dispatch_generation,
        jobs.task_name,
        jobs.task_enqueued_at
      from inspections
      inner join jobs on jobs.inspection_id = inspections.id
      where inspections.id = ${fixture.inspectionId}
    `;
    expect(stored).toEqual({
      dispatch_generation: 5,
      inspection_status: "queued",
      prediction_object_key: fixture.predictionObjectKey,
      status: "pending_dispatch",
      task_enqueued_at: null,
      task_name: null,
    });
    expect(dispatcher.messages).toEqual([
      { dispatchGeneration: 5, jobId: fixture.jobId },
    ]);
  });

  it("hides cancellation and retry targets owned by another user", async () => {
    const dispatcher = new RecordingTaskDispatcher();
    const ownerHarness = await createUploadHarness(dispatcher);
    const otherHarness = await createUploadHarness(dispatcher);
    const cancellable = await createCommandInspection(
      ownerHarness.user.id,
      "queued",
      "queued",
    );
    const retryable = await createCommandInspection(
      ownerHarness.user.id,
      "failed",
      "failed",
      "provider_unavailable",
    );

    const cancel = await runInspectionCommand(
      otherHarness.app,
      otherHarness.token,
      cancellable.inspectionId,
      "cancel",
    );
    const retry = await runInspectionCommand(
      otherHarness.app,
      otherHarness.token,
      retryable.inspectionId,
      "retry",
    );

    expect(cancel.status).toBe(404);
    expect(cancel.body.error.code).toBe("inspection_not_found");
    expect(retry.status).toBe(404);
    expect(retry.body.error.code).toBe("inspection_not_found");
    const [cancelJob] = await sql<{ cancel_requested_at: Date | null }[]>`
      select cancel_requested_at from jobs where id = ${cancellable.jobId}
    `;
    const [retryJob] = await sql<
      { dispatch_generation: number; status: string }[]
    >`
      select dispatch_generation, status from jobs where id = ${retryable.jobId}
    `;
    expect(cancelJob?.cancel_requested_at).toBeNull();
    expect(retryJob).toEqual({ dispatch_generation: 4, status: "failed" });
    expect(dispatcher.messages).toEqual([]);
  });
});
