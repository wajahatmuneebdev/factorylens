import { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

import {
  PREDICTION_CSV_COLUMNS,
  PredictionArtifactV1Schema,
  type User,
} from "@factorylens/contracts";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { AuthStore, OidcProvider } from "../src/auth.js";
import type {
  CreateOwnedInspectionInput,
  InspectionApiRepository,
  InspectionRecord,
  InspectionViewRecord,
  JobRecord,
  UploadCompletionRecord,
} from "../src/db/inspection-repository.js";
import { InspectionCommandConflictError } from "../src/db/inspection-repository.js";
import { hashSessionToken } from "../src/session.js";
import {
  type ObjectAccessAuthorizer,
  type ObjectStorage,
  type StorageObjectMetadata,
  StorageObjectNotFoundError,
} from "../src/storage.js";
import {
  deterministicTaskName,
  type TaskDispatcher,
} from "../src/task-dispatcher.js";

const appOrigin = new URL("https://factorylens.example");
const currentTime = new Date("2026-11-09T08:00:00.000Z");
const owner: User = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  avatarUrl: null,
  displayName: "Factory Owner",
  email: "owner@example.com",
};
const otherOwnerId = "223e4567-e89b-42d3-a456-426614174000";
const firstInspectionId = "323e4567-e89b-42d3-a456-426614174000";
const secondInspectionId = "423e4567-e89b-42d3-a456-426614174000";
const predictionFixture = PredictionArtifactV1Schema.parse(
  JSON.parse(
    readFileSync(
      new URL(
        "../../../fixtures/contracts/prediction-artifact-v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);

function compressedPredictionArtifact(
  inspectionId: string,
  overrides: Record<string, unknown> = {},
): Buffer {
  return gzipSync(
    JSON.stringify({ ...predictionFixture, inspectionId, ...overrides }),
  );
}

function inspectionRecord(
  id: string,
  ownerUserId: string = owner.id,
  createdAt: Date = currentTime,
): InspectionRecord {
  return {
    id,
    ownerUserId,
    title: "Assembly line review",
    status: "awaiting_upload",
    sourceType: "upload",
    workflowKey: "factory-safety-v1",
    sourceObjectKey: `inspections/${id}/source`,
    normalizedObjectKey: null,
    predictionObjectKey: null,
    declaredFileName: "line.webm",
    declaredContentType: "video/webm",
    declaredSizeBytes: 4096,
    inspectedContentType: null,
    inspectedSizeBytes: null,
    inspectedDurationMs: null,
    inspectedWidth: null,
    inspectedHeight: null,
    predictionSchemaVersion: null,
    workflowFingerprint: null,
    missingHardHatEventCount: null,
    qualifyingFrameCount: null,
    peakConfidence: null,
    errorCode: null,
    errorMessage: null,
    createdAt,
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    updatedAt: createdAt,
  };
}

function jobRecord(id = "523e4567-e89b-42d3-a456-426614174000"): JobRecord {
  return {
    id,
    inspectionId: firstInspectionId,
    status: "pending_dispatch",
    stage: null,
    progressPercent: 0,
    attemptCount: 0,
    maxAttempts: 3,
    dispatchGeneration: 1,
    taskName: null,
    taskEnqueuedAt: null,
    leaseToken: null,
    leaseExpiresAt: null,
    heartbeatAt: null,
    cancelRequestedAt: null,
    errorCode: null,
    errorMessage: null,
    createdAt: currentTime,
    availableAt: currentTime,
    startedAt: null,
    finishedAt: null,
    updatedAt: currentTime,
  };
}

class FakeAuthStore implements AuthStore {
  readonly createSession = vi.fn();
  readonly revokeSession = vi.fn();
  readonly findActiveUser = vi.fn(
    async (tokenHash: string): Promise<User | null> =>
      tokenHash === hashSessionToken("active-token") ? owner : null,
  );
}

class FakeInspectionRepository implements InspectionApiRepository {
  records: InspectionViewRecord[] = [];
  uploads: UploadCompletionRecord[] = [];

  readonly completeOwnedUpload = vi.fn(
    async (
      ownerUserId: string,
      inspectionId: string,
      inspectedSizeBytes: number,
      now: Date,
    ): Promise<UploadCompletionRecord | null> => {
      const record = this.uploads.find(
        ({ inspection }) =>
          inspection.ownerUserId === ownerUserId &&
          inspection.id === inspectionId,
      );
      if (!record) {
        return null;
      }
      if (record.job) {
        return record;
      }

      record.inspection = {
        ...record.inspection,
        inspectedSizeBytes,
        queuedAt: now,
        status: "queued",
        updatedAt: now,
      };
      record.job = { ...jobRecord(), inspectionId };
      return record;
    },
  );

  readonly createOwned = vi.fn(
    async (input: CreateOwnedInspectionInput): Promise<InspectionRecord> => ({
      ...inspectionRecord(input.id, input.ownerUserId),
      declaredContentType: input.declaredContentType,
      declaredFileName: input.declaredFileName,
      declaredSizeBytes: input.declaredSizeBytes,
      sourceObjectKey: input.sourceObjectKey,
      sourceType: input.sourceType,
      title: input.title,
      workflowKey: input.workflowKey,
    }),
  );

  readonly findOwnedById = vi.fn(
    async (
      ownerUserId: string,
      inspectionId: string,
    ): Promise<InspectionRecord | null> =>
      this.records.find(
        ({ inspection }) =>
          inspection.ownerUserId === ownerUserId &&
          inspection.id === inspectionId,
      )?.inspection ?? null,
  );

  readonly findOwnedUploadCompletionById = vi.fn(
    async (
      ownerUserId: string,
      inspectionId: string,
    ): Promise<UploadCompletionRecord | null> =>
      this.uploads.find(
        ({ inspection }) =>
          inspection.ownerUserId === ownerUserId &&
          inspection.id === inspectionId,
      ) ?? null,
  );

  readonly findOwnedViewById = vi.fn(
    async (
      ownerUserId: string,
      inspectionId: string,
    ): Promise<InspectionViewRecord | null> =>
      this.records.find(
        ({ inspection }) =>
          inspection.ownerUserId === ownerUserId &&
          inspection.id === inspectionId,
      ) ?? null,
  );

  readonly listOwned = vi.fn(async (ownerUserId: string) => ({
    hasMore: false,
    inspections: this.records.filter(
      ({ inspection }) => inspection.ownerUserId === ownerUserId,
    ),
  }));

  readonly updateOwnedById = vi.fn(
    async (): Promise<InspectionRecord | null> => null,
  );

  readonly markOwnedJobDispatched = vi.fn(
    async (
      ownerUserId: string,
      inspectionId: string,
      jobId: string,
      dispatchGeneration: number,
      taskName: string,
      now: Date,
    ): Promise<UploadCompletionRecord | null> => {
      const record = this.uploads.find(
        ({ inspection, job }) =>
          inspection.ownerUserId === ownerUserId &&
          inspection.id === inspectionId &&
          job?.id === jobId &&
          job.dispatchGeneration === dispatchGeneration,
      );
      if (!record?.job) {
        return null;
      }
      record.job = {
        ...record.job,
        status: "queued",
        taskName,
        taskEnqueuedAt: now,
        updatedAt: now,
      };
      return record;
    },
  );

  readonly requestOwnedCancellation = vi.fn(
    async (
      ownerUserId: string,
      inspectionId: string,
    ): Promise<InspectionViewRecord | null> =>
      this.records.find(
        ({ inspection }) =>
          inspection.ownerUserId === ownerUserId &&
          inspection.id === inspectionId,
      ) ?? null,
  );

  readonly retryOwnedFailure = vi.fn(
    async (
      ownerUserId: string,
      inspectionId: string,
      now: Date,
    ): Promise<UploadCompletionRecord | null> => {
      const record = this.uploads.find(
        ({ inspection }) =>
          inspection.ownerUserId === ownerUserId &&
          inspection.id === inspectionId,
      );
      if (!record?.job) {
        return null;
      }

      record.inspection = {
        ...record.inspection,
        completedAt: null,
        errorCode: null,
        errorMessage: null,
        queuedAt: now,
        startedAt: null,
        status: "queued",
        updatedAt: now,
      };
      record.job = {
        ...record.job,
        attemptCount: 0,
        dispatchGeneration: record.job.dispatchGeneration + 1,
        errorCode: null,
        errorMessage: null,
        progressPercent: 0,
        stage: null,
        status: "pending_dispatch",
        taskEnqueuedAt: null,
        taskName: null,
        updatedAt: now,
      };
      return record;
    },
  );
}

class FakeStorage implements ObjectStorage, ObjectAccessAuthorizer {
  readonly authorizeDownload = vi.fn(async (key: string) => ({
    url: `https://storage.example/${key}?signature=download`,
    expiresAt: new Date(currentTime.getTime() + 10 * 60 * 1000),
  }));
  readonly authorizeUpload = vi.fn(
    async (key: string, contentType: string) => ({
      method: "PUT" as const,
      url: `https://storage.example/${key}?signature=upload`,
      headers: { "Content-Type": contentType },
      expiresAt: new Date(currentTime.getTime() + 10 * 60 * 1000),
    }),
  );
  readonly delete = vi.fn(async () => undefined);
  readonly exists = vi.fn(async () => false);
  readonly metadata = vi.fn(
    async (key: string): Promise<StorageObjectMetadata> => {
      throw new StorageObjectNotFoundError(key);
    },
  );
  readonly put = vi.fn(async (key: string) => ({ key, sizeBytes: 0 }));
  readonly read = vi.fn(async () => Readable.from([]));
}

class FakeTaskDispatcher implements TaskDispatcher {
  readonly dispatch = vi.fn(async (message) => ({
    outcome: "dispatched" as const,
    taskName: deterministicTaskName(message),
  }));
}

const oidcProvider: OidcProvider = {
  createAuthorizationRequest: vi.fn(),
  exchangeAuthorizationCode: vi.fn(),
};

function inspectionApp(
  repository: FakeInspectionRepository,
  storage: ObjectStorage & ObjectAccessAuthorizer = new FakeStorage(),
  taskDispatcher: TaskDispatcher = new FakeTaskDispatcher(),
) {
  return createApp({
    appOrigin,
    callbackUrl: new URL("/auth/google/callback", appOrigin),
    inspections: repository,
    now: () => currentTime,
    objectAccess: storage,
    oidcProvider,
    storage,
    store: new FakeAuthStore(),
    taskDispatcher,
    transactionSecret: "a-secure-test-secret-that-is-long-enough",
  });
}

function authenticated(requestBuilder: request.Test): request.Test {
  return requestBuilder.set(
    "Cookie",
    "__Host-factorylens_session=active-token",
  );
}

describe("inspection API", () => {
  it("creates an owner-scoped awaiting-upload inspection with server-generated storage identity", async () => {
    const repository = new FakeInspectionRepository();
    const response = await authenticated(
      request(inspectionApp(repository))
        .post("/api/inspections")
        .set("Origin", appOrigin.origin),
    ).send({
      title: "  Shift 2 review  ",
      workflowKey: "factory-safety-v1",
      source: {
        sourceType: "upload",
        fileName: "line.webm",
        contentType: "video/webm",
        sizeBytes: 4096,
      },
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      inspection: {
        status: "awaiting_upload",
        title: "Shift 2 review",
        workflowKey: "factory-safety-v1",
        progress: { stage: null, percent: 0 },
      },
      upload: {
        method: "PUT",
        headers: { "Content-Type": "video/webm" },
        expiresAt: "2026-11-09T08:10:00.000Z",
      },
    });
    expect(repository.createOwned).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: owner.id,
        declaredContentType: "video/webm",
        declaredFileName: "line.webm",
        declaredSizeBytes: 4096,
        sourceType: "upload",
        title: "Shift 2 review",
      }),
    );
    const created = repository.createOwned.mock.calls[0]![0];
    expect(created.sourceObjectKey).toBe(`inspections/${created.id}/source`);
    expect(response.body.upload.url).toContain(
      `/inspections/${created.id}/source?signature=upload`,
    );
  });

  it("does not issue upload authorization for the prepared sample", async () => {
    const repository = new FakeInspectionRepository();
    const storage = new FakeStorage();

    const response = await authenticated(
      request(inspectionApp(repository, storage))
        .post("/api/inspections")
        .set("Origin", appOrigin.origin),
    ).send({
      title: "Prepared sample",
      workflowKey: "factory-safety-v1",
      source: {
        sourceType: "sample",
        sampleKey: "assembly-line-no-hard-hat",
      },
    });

    expect(response.status).toBe(201);
    expect(response.body.upload).toBeNull();
    expect(storage.authorizeUpload).not.toHaveBeenCalled();
  });

  it.each([
    {
      title: " ",
      workflowKey: "factory-safety-v1",
      source: {
        sourceType: "upload",
        fileName: "line.webm",
        contentType: "video/webm",
        sizeBytes: 4096,
      },
    },
    {
      title: "Shift 2 review",
      workflowKey: "unknown-workflow",
      source: {
        sourceType: "upload",
        fileName: "line.webm",
        contentType: "video/webm",
        sizeBytes: 4096,
      },
    },
    {
      title: "Shift 2 review",
      workflowKey: "factory-safety-v1",
      source: {
        sourceType: "upload",
        fileName: "line.webm",
        contentType: "text/plain",
        sizeBytes: 4096,
      },
    },
  ])("returns a stable validation error for invalid input", async (body) => {
    const repository = new FakeInspectionRepository();
    const response = await authenticated(
      request(inspectionApp(repository))
        .post("/api/inspections")
        .set("Origin", appOrigin.origin),
    ).send(body);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "invalid_request",
        category: "terminal",
        message: "The inspection request is invalid.",
      },
    });
    expect(repository.createOwned).not.toHaveBeenCalled();
  });

  it("rejects malformed request bodies and cross-origin creation", async () => {
    const repository = new FakeInspectionRepository();
    const app = inspectionApp(repository);
    const malformed = await authenticated(
      request(app)
        .post("/api/inspections")
        .set("Origin", appOrigin.origin)
        .set("Content-Type", "application/json"),
    ).send('{"title":');
    const crossOrigin = await authenticated(
      request(app)
        .post("/api/inspections")
        .set("Origin", "https://attacker.example"),
    ).send({
      title: "Shift 2 review",
      workflowKey: "factory-safety-v1",
      source: {
        sourceType: "sample",
        sampleKey: "assembly-line-no-hard-hat",
      },
    });

    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe("invalid_request");
    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.body.error.code).toBe("access_denied");
    expect(repository.createOwned).not.toHaveBeenCalled();
  });

  it("returns an empty owner-scoped history and rejects unbounded limits", async () => {
    const repository = new FakeInspectionRepository();
    const app = inspectionApp(repository);
    const empty = await authenticated(request(app).get("/api/inspections"));
    const unbounded = await authenticated(
      request(app).get("/api/inspections?limit=101"),
    );

    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ inspections: [], nextCursor: null });
    expect(repository.listOwned).toHaveBeenCalledWith(owner.id, {
      cursor: undefined,
      limit: 20,
      status: undefined,
    });
    expect(unbounded.status).toBe(400);
    expect(unbounded.body.error.code).toBe("invalid_request");
  });

  it("returns only an owned inspection with a safe job summary", async () => {
    const repository = new FakeInspectionRepository();
    repository.records = [
      {
        inspection: {
          ...inspectionRecord(firstInspectionId),
          status: "processing",
        },
        job: {
          errorCode: "provider_unavailable",
          errorMessage: "Processing is temporarily unavailable.",
          id: "523e4567-e89b-42d3-a456-426614174000",
          progressPercent: 45,
          stage: "workflow",
        },
      },
      {
        inspection: inspectionRecord(secondInspectionId, otherOwnerId),
        job: null,
      },
    ];
    const app = inspectionApp(repository);

    const allowed = await authenticated(
      request(app).get(`/api/inspections/${firstInspectionId}`),
    );
    const denied = await authenticated(
      request(app).get(`/api/inspections/${secondInspectionId}`),
    );

    expect(allowed.status).toBe(200);
    expect(allowed.body.inspection).toMatchObject({
      id: firstInspectionId,
      progress: { stage: "workflow", percent: 45 },
      error: {
        code: "provider_unavailable",
        category: "retryable",
        message: "Processing is temporarily unavailable.",
      },
    });
    expect(JSON.stringify(allowed.body)).not.toContain("lease");
    expect(denied.status).toBe(404);
    expect(denied.body.error.code).toBe("inspection_not_found");
    expect(repository.findOwnedViewById).toHaveBeenCalledWith(
      owner.id,
      secondInspectionId,
    );
  });

  it("authorizes object-specific downloads only for an owned completed inspection", async () => {
    const repository = new FakeInspectionRepository();
    const normalizedKey = `inspections/${firstInspectionId}/generations/2/normalized`;
    const predictionKey = `inspections/${firstInspectionId}/generations/2/prediction`;
    repository.records = [
      {
        inspection: {
          ...inspectionRecord(firstInspectionId),
          completedAt: currentTime,
          normalizedObjectKey: normalizedKey,
          predictionObjectKey: predictionKey,
          predictionSchemaVersion: 1,
          status: "completed",
        },
        job: null,
      },
      {
        inspection: {
          ...inspectionRecord(secondInspectionId, otherOwnerId),
          completedAt: currentTime,
          predictionObjectKey: `inspections/${secondInspectionId}/generations/1/prediction`,
          predictionSchemaVersion: 1,
          status: "completed",
        },
        job: null,
      },
    ];
    const storage = new FakeStorage();
    storage.metadata.mockImplementation(async (key) => ({
      key,
      sizeBytes: 4096,
    }));
    const app = inspectionApp(repository, storage);

    const allowed = await authenticated(
      request(app).get(`/api/inspections/${firstInspectionId}/artifacts`),
    );
    const hidden = await authenticated(
      request(app).get(`/api/inspections/${secondInspectionId}/artifacts`),
    );

    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({
      video: { expiresAt: "2026-11-09T08:10:00.000Z" },
      predictions: { expiresAt: "2026-11-09T08:10:00.000Z" },
      predictionSchemaVersion: 1,
    });
    expect(allowed.headers["cache-control"]).toBe("private, no-store");
    expect(storage.authorizeDownload.mock.calls.map(([key]) => key)).toEqual([
      normalizedKey,
      predictionKey,
    ]);
    expect(hidden.status).toBe(404);
    expect(storage.authorizeDownload).toHaveBeenCalledTimes(2);
  });

  it.each([
    "awaiting_upload",
    "queued",
    "processing",
    "failed",
    "cancelled",
  ] as const)(
    "does not authorize artifacts for a %s inspection",
    async (status) => {
      const repository = new FakeInspectionRepository();
      repository.records = [
        {
          inspection: {
            ...inspectionRecord(firstInspectionId),
            predictionObjectKey: `inspections/${firstInspectionId}/generations/1/prediction`,
            predictionSchemaVersion: 1,
            status,
          },
          job: null,
        },
      ];
      const storage = new FakeStorage();

      const response = await authenticated(
        request(inspectionApp(repository, storage)).get(
          `/api/inspections/${firstInspectionId}/artifacts`,
        ),
      );

      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("inspection_state_conflict");
      expect(storage.metadata).not.toHaveBeenCalled();
      expect(storage.authorizeDownload).not.toHaveBeenCalled();
    },
  );

  it("does not sign artifact locations when a committed object is missing", async () => {
    const repository = new FakeInspectionRepository();
    repository.records = [
      {
        inspection: {
          ...inspectionRecord(firstInspectionId),
          completedAt: currentTime,
          predictionObjectKey: `inspections/${firstInspectionId}/generations/1/prediction`,
          predictionSchemaVersion: 1,
          status: "completed",
        },
        job: null,
      },
    ];
    const storage = new FakeStorage();

    const response = await authenticated(
      request(inspectionApp(repository, storage)).get(
        `/api/inspections/${firstInspectionId}/artifacts`,
      ),
    );

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("storage_unavailable");
    expect(storage.authorizeDownload).not.toHaveBeenCalled();
  });

  it("rejects an unrecognized committed prediction schema before signing", async () => {
    const repository = new FakeInspectionRepository();
    repository.records = [
      {
        inspection: {
          ...inspectionRecord(firstInspectionId),
          completedAt: currentTime,
          predictionObjectKey: `inspections/${firstInspectionId}/generations/1/prediction`,
          predictionSchemaVersion: 2,
          status: "completed",
        },
        job: null,
      },
    ];
    const storage = new FakeStorage();

    const response = await authenticated(
      request(inspectionApp(repository, storage)).get(
        `/api/inspections/${firstInspectionId}/artifacts`,
      ),
    );

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("storage_unavailable");
    expect(storage.metadata).not.toHaveBeenCalled();
    expect(storage.authorizeDownload).not.toHaveBeenCalled();
  });

  it("streams stable CSV columns from the committed prediction artifact", async () => {
    const repository = new FakeInspectionRepository();
    const predictionKey = `inspections/${firstInspectionId}/generations/2/prediction`;
    repository.records = [
      {
        inspection: {
          ...inspectionRecord(firstInspectionId),
          completedAt: currentTime,
          predictionObjectKey: predictionKey,
          predictionSchemaVersion: 1,
          status: "completed",
        },
        job: null,
      },
    ];
    const storage = new FakeStorage();
    storage.read.mockResolvedValue(
      Readable.from([compressedPredictionArtifact(firstInspectionId)]),
    );

    const response = await authenticated(
      request(inspectionApp(repository, storage)).get(
        `/api/inspections/${firstInspectionId}/export.csv`,
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.headers["content-disposition"]).toBe(
      `attachment; filename="factorylens-${firstInspectionId}.csv"`,
    );
    const lines = response.text.trim().split("\r\n");
    expect(lines[0]).toBe(PREDICTION_CSV_COLUMNS.join(","));
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe(
      `"${firstInspectionId}",0,"f000000-p000","NO-Hardhat",0.91,614,238,92,108`,
    );
    expect(storage.read).toHaveBeenCalledWith(predictionKey);
  });

  it("hides cross-owner CSV exports without reading private results", async () => {
    const repository = new FakeInspectionRepository();
    repository.records = [
      {
        inspection: {
          ...inspectionRecord(firstInspectionId, otherOwnerId),
          completedAt: currentTime,
          predictionObjectKey: `inspections/${firstInspectionId}/generations/1/prediction`,
          predictionSchemaVersion: 1,
          status: "completed",
        },
        job: null,
      },
    ];
    const storage = new FakeStorage();

    const response = await authenticated(
      request(inspectionApp(repository, storage)).get(
        `/api/inspections/${firstInspectionId}/export.csv`,
      ),
    );

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("inspection_not_found");
    expect(storage.read).not.toHaveBeenCalled();
  });

  it("rejects missing and unsupported CSV prediction artifacts", async () => {
    const repository = new FakeInspectionRepository();
    repository.records = [
      {
        inspection: {
          ...inspectionRecord(firstInspectionId),
          completedAt: currentTime,
          predictionObjectKey: `inspections/${firstInspectionId}/generations/1/prediction`,
          predictionSchemaVersion: 1,
          status: "completed",
        },
        job: null,
      },
    ];
    const missingStorage = new FakeStorage();
    missingStorage.read.mockRejectedValue(
      new StorageObjectNotFoundError(
        `inspections/${firstInspectionId}/generations/1/prediction`,
      ),
    );
    const unsupportedStorage = new FakeStorage();
    unsupportedStorage.read.mockResolvedValue(
      Readable.from([
        compressedPredictionArtifact(firstInspectionId, { schemaVersion: 2 }),
      ]),
    );

    const missing = await authenticated(
      request(inspectionApp(repository, missingStorage)).get(
        `/api/inspections/${firstInspectionId}/export.csv`,
      ),
    );
    const unsupported = await authenticated(
      request(inspectionApp(repository, unsupportedStorage)).get(
        `/api/inspections/${firstInspectionId}/export.csv`,
      ),
    );

    expect(missing.status).toBe(503);
    expect(missing.body.error.code).toBe("storage_unavailable");
    expect(unsupported.status).toBe(503);
    expect(unsupported.body.error.code).toBe("storage_unavailable");
  });

  it("rejects missing uploads and declared-size mismatches before creating a job", async () => {
    const repository = new FakeInspectionRepository();
    repository.uploads = [
      { inspection: inspectionRecord(firstInspectionId), job: null },
      { inspection: inspectionRecord(secondInspectionId), job: null },
    ];
    const storage = new FakeStorage();
    storage.metadata.mockImplementation(async (key) => {
      if (key.includes(firstInspectionId)) {
        throw new StorageObjectNotFoundError(key);
      }
      return { key, sizeBytes: 4095 };
    });
    const dispatcher = new FakeTaskDispatcher();
    const app = inspectionApp(repository, storage, dispatcher);

    const missing = await authenticated(
      request(app)
        .post(`/api/inspections/${firstInspectionId}/upload-complete`)
        .set("Origin", appOrigin.origin),
    ).send({});
    const mismatch = await authenticated(
      request(app)
        .post(`/api/inspections/${secondInspectionId}/upload-complete`)
        .set("Origin", appOrigin.origin),
    ).send({});

    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe("invalid_media");
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.code).toBe("invalid_media");
    expect(repository.completeOwnedUpload).not.toHaveBeenCalled();
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("rejects cross-origin completion and hides another owner's upload", async () => {
    const repository = new FakeInspectionRepository();
    repository.uploads = [
      {
        inspection: inspectionRecord(firstInspectionId, otherOwnerId),
        job: null,
      },
    ];
    const storage = new FakeStorage();
    const dispatcher = new FakeTaskDispatcher();
    const app = inspectionApp(repository, storage, dispatcher);

    const crossOrigin = await authenticated(
      request(app)
        .post(`/api/inspections/${firstInspectionId}/upload-complete`)
        .set("Origin", "https://attacker.example"),
    ).send({});
    const crossOwner = await authenticated(
      request(app)
        .post(`/api/inspections/${firstInspectionId}/upload-complete`)
        .set("Origin", appOrigin.origin),
    ).send({});

    expect(crossOrigin.status).toBe(403);
    expect(crossOrigin.body.error.code).toBe("access_denied");
    expect(crossOwner.status).toBe(404);
    expect(crossOwner.body.error.code).toBe("inspection_not_found");
    expect(repository.findOwnedUploadCompletionById).toHaveBeenCalledWith(
      owner.id,
      firstInspectionId,
    );
    expect(storage.metadata).not.toHaveBeenCalled();
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
  });

  it("creates and dispatches one durable job after completion, then returns it idempotently", async () => {
    const repository = new FakeInspectionRepository();
    repository.uploads = [
      { inspection: inspectionRecord(firstInspectionId), job: null },
    ];
    const storage = new FakeStorage();
    storage.metadata.mockResolvedValue({
      key: `inspections/${firstInspectionId}/source`,
      sizeBytes: 4096,
    });
    const dispatcher = new FakeTaskDispatcher();
    const app = inspectionApp(repository, storage, dispatcher);

    const first = await authenticated(
      request(app)
        .post(`/api/inspections/${firstInspectionId}/upload-complete`)
        .set("Origin", appOrigin.origin),
    ).send({});
    const duplicate = await authenticated(
      request(app)
        .post(`/api/inspections/${firstInspectionId}/upload-complete`)
        .set("Origin", appOrigin.origin),
    ).send({});

    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      inspection: { id: firstInspectionId, status: "queued" },
      job: { status: "queued" },
    });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.job).toEqual(first.body.job);
    expect(repository.completeOwnedUpload).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
    expect(storage.metadata).toHaveBeenCalledTimes(1);
    expect(
      repository.completeOwnedUpload.mock.invocationCallOrder[0],
    ).toBeLessThan(dispatcher.dispatch.mock.invocationCallOrder[0]!);
    expect(repository.uploads[0]?.job).toMatchObject({
      status: "queued",
      taskName: deterministicTaskName({
        jobId: first.body.job.id,
        dispatchGeneration: 1,
      }),
      taskEnqueuedAt: currentTime,
    });
  });

  it("does not dispatch when the completion transaction fails", async () => {
    const repository = new FakeInspectionRepository();
    const upload = {
      inspection: inspectionRecord(firstInspectionId),
      job: null,
    };
    repository.uploads = [upload];
    repository.completeOwnedUpload.mockRejectedValueOnce(
      new Error("simulated commit failure"),
    );
    const storage = new FakeStorage();
    storage.metadata.mockResolvedValue({
      key: upload.inspection.sourceObjectKey,
      sizeBytes: 4096,
    });
    const dispatcher = new FakeTaskDispatcher();

    const response = await authenticated(
      request(inspectionApp(repository, storage, dispatcher))
        .post(`/api/inspections/${firstInspectionId}/upload-complete`)
        .set("Origin", appOrigin.origin),
    ).send({});

    expect(response.status).toBe(503);
    expect(dispatcher.dispatch).not.toHaveBeenCalled();
    expect(upload).toMatchObject({
      inspection: { status: "awaiting_upload" },
      job: null,
    });
  });

  it("keeps a failed dispatch pending and recovers it on a repeated completion", async () => {
    const repository = new FakeInspectionRepository();
    repository.uploads = [
      { inspection: inspectionRecord(firstInspectionId), job: null },
    ];
    const storage = new FakeStorage();
    storage.metadata.mockResolvedValue({
      key: `inspections/${firstInspectionId}/source`,
      sizeBytes: 4096,
    });
    const dispatcher = new FakeTaskDispatcher();
    dispatcher.dispatch.mockRejectedValueOnce(
      new Error("simulated dispatch failure"),
    );
    const app = inspectionApp(repository, storage, dispatcher);

    const failed = await authenticated(
      request(app)
        .post(`/api/inspections/${firstInspectionId}/upload-complete`)
        .set("Origin", appOrigin.origin),
    ).send({});
    expect(failed.status).toBe(503);
    expect(repository.uploads[0]?.job).toMatchObject({
      status: "pending_dispatch",
      taskEnqueuedAt: null,
      taskName: null,
    });

    const recovered = await authenticated(
      request(app)
        .post(`/api/inspections/${firstInspectionId}/upload-complete`)
        .set("Origin", appOrigin.origin),
    ).send({});

    expect(recovered.status).toBe(200);
    expect(recovered.body.job).toMatchObject({
      id: repository.uploads[0]?.job?.id,
      status: "queued",
    });
    expect(repository.completeOwnedUpload).toHaveBeenCalledTimes(1);
    expect(storage.metadata).toHaveBeenCalledTimes(1);
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
  });

  it("records an owner-scoped cancellation request and returns the current shared inspection state", async () => {
    const repository = new FakeInspectionRepository();
    repository.records = [
      {
        inspection: {
          ...inspectionRecord(firstInspectionId),
          status: "processing",
        },
        job: {
          errorCode: null,
          errorMessage: null,
          id: "523e4567-e89b-42d3-a456-426614174000",
          progressPercent: 45,
          stage: "workflow",
        },
      },
      {
        inspection: inspectionRecord(secondInspectionId, otherOwnerId),
        job: null,
      },
    ];
    const app = inspectionApp(repository);

    const allowed = await authenticated(
      request(app)
        .post(`/api/inspections/${firstInspectionId}/cancel`)
        .set("Origin", appOrigin.origin),
    ).send({});
    const hidden = await authenticated(
      request(app)
        .post(`/api/inspections/${secondInspectionId}/cancel`)
        .set("Origin", appOrigin.origin),
    ).send({});

    expect(allowed.status).toBe(200);
    expect(allowed.body.inspection).toMatchObject({
      id: firstInspectionId,
      status: "processing",
      progress: { stage: "workflow", percent: 45 },
    });
    expect(hidden.status).toBe(404);
    expect(repository.requestOwnedCancellation).toHaveBeenCalledWith(
      owner.id,
      firstInspectionId,
      currentTime,
    );
  });

  it("retries a failure with a new generation and dispatches only after the reset", async () => {
    const repository = new FakeInspectionRepository();
    repository.uploads = [
      {
        inspection: {
          ...inspectionRecord(firstInspectionId),
          errorCode: "provider_unavailable",
          errorMessage: "The provider was unavailable.",
          status: "failed",
        },
        job: {
          ...jobRecord(),
          attemptCount: 3,
          dispatchGeneration: 4,
          errorCode: "provider_unavailable",
          errorMessage: "The provider was unavailable.",
          status: "failed",
          taskEnqueuedAt: new Date("2026-11-09T07:00:00.000Z"),
          taskName: "process-old-generation",
        },
      },
    ];
    const dispatcher = new FakeTaskDispatcher();

    const response = await authenticated(
      request(inspectionApp(repository, new FakeStorage(), dispatcher))
        .post(`/api/inspections/${firstInspectionId}/retry`)
        .set("Origin", appOrigin.origin),
    ).send({});

    expect(response.status).toBe(200);
    expect(response.body.inspection).toMatchObject({
      id: firstInspectionId,
      status: "queued",
      error: null,
      progress: { stage: null, percent: 0 },
    });
    expect(dispatcher.dispatch).toHaveBeenCalledWith({
      dispatchGeneration: 5,
      jobId: "523e4567-e89b-42d3-a456-426614174000",
    });
    expect(
      repository.retryOwnedFailure.mock.invocationCallOrder[0],
    ).toBeLessThan(dispatcher.dispatch.mock.invocationCallOrder[0]!);
  });

  it("returns stable conflicts for disallowed cancellation and retry commands", async () => {
    const repository = new FakeInspectionRepository();
    repository.requestOwnedCancellation.mockRejectedValueOnce(
      new InspectionCommandConflictError("completed"),
    );
    repository.retryOwnedFailure.mockRejectedValueOnce(
      new InspectionCommandConflictError("failed"),
    );
    const app = inspectionApp(repository);

    const cancel = await authenticated(
      request(app)
        .post(`/api/inspections/${firstInspectionId}/cancel`)
        .set("Origin", appOrigin.origin),
    ).send({});
    const retry = await authenticated(
      request(app)
        .post(`/api/inspections/${firstInspectionId}/retry`)
        .set("Origin", appOrigin.origin),
    ).send({});

    expect(cancel.status).toBe(409);
    expect(cancel.body.error.code).toBe("inspection_state_conflict");
    expect(retry.status).toBe(409);
    expect(retry.body.error.code).toBe("inspection_state_conflict");
  });

  it("emits and validates an opaque stable pagination cursor", async () => {
    const repository = new FakeInspectionRepository();
    repository.records = [
      {
        inspection: inspectionRecord(
          firstInspectionId,
          owner.id,
          new Date("2026-11-09T08:00:01.000Z"),
        ),
        job: null,
      },
    ];
    repository.listOwned.mockResolvedValueOnce({
      hasMore: true,
      inspections: repository.records,
    });
    const app = inspectionApp(repository);
    const first = await authenticated(
      request(app).get("/api/inspections?limit=1"),
    );
    const second = await authenticated(
      request(app).get(
        `/api/inspections?limit=1&cursor=${encodeURIComponent(first.body.nextCursor)}`,
      ),
    );
    const invalid = await authenticated(
      request(app).get("/api/inspections?cursor=not-a-cursor"),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(repository.listOwned).toHaveBeenLastCalledWith(owner.id, {
      cursor: {
        createdAt: new Date("2026-11-09T08:00:01.000Z"),
        id: firstInspectionId,
      },
      limit: 1,
      status: undefined,
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe("invalid_request");
  });
});
