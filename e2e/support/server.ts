import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";

import { PredictionArtifactV1Schema, type User } from "@factorylens/contracts";
import express from "express";

import { createApp } from "../../apps/api/src/app.js";
import type {
  AuthStore,
  OidcAuthorizationRequest,
  OidcIdentity,
  OidcProvider,
} from "../../apps/api/src/auth.js";
import type {
  CreateOwnedInspectionInput,
  InspectionApiRepository,
  InspectionPage,
  InspectionRecord,
  InspectionUpdate,
  InspectionViewRecord,
  JobRecord,
  ListOwnedInspectionsOptions,
  UploadCompletionRecord,
} from "../../apps/api/src/db/inspection-repository.js";
import type {
  ObjectAccessAuthorizer,
  ObjectStorage,
  StorageObjectMetadata,
} from "../../apps/api/src/storage.js";
import { StorageObjectNotFoundError } from "../../apps/api/src/storage.js";
import {
  deterministicTaskName,
  type TaskDispatcher,
} from "../../apps/api/src/task-dispatcher.js";

const appOrigin = new URL("http://localhost:5173");
const apiPort = 3100;
const owner: User = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  avatarUrl: null,
  displayName: "Factory Owner",
  email: "owner@example.com",
};
const identity: OidcIdentity = {
  avatarUrl: owner.avatarUrl,
  displayName: owner.displayName,
  email: owner.email,
  googleSubject: "playwright-development-user",
};
const videoFixture = Buffer.from(
  "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAU2EU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEkTbuMU6uEHFO7a1OsggUg7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjEuNy4xMDBXQYxMYXZmNjEuNy4xMDBEiYhAj0AAAAAAABZUrmvJrgEAAAAAAABA14EBc8WI9XpwJoyhEOacgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QCYloA4JGwggFAuoG0moECVbCEVbmBARJUw2f7c3OfY8CAZ8iZRaOHRU5DT0RFUkSHjExhdmY2MS43LjEwMHNz1mPAi2PFiPV6cCaMoRDmZ8ihRaOHRU5DT0RFUkSHlExhdmM2MS4xOS4xMDEgbGlidnB4Z8ihRaOIRFVSQVRJT05Eh5MwMDowMDowMS4wMDAwMDAwMDAAH0O2dUN254EAo0CKgQAAgPAOAJ0BKkABtAAARwiFhYiFhIgCAgAGFgT3BoFkn2vbmyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eyc4eycuAP7/q1CAo52BACgAsQIABRCsABgAGFgv9AAIgAQzX61yT5WAAKOdgQBQALECAAUQrAAYABhYL/QACIAEM1+tck+VgACjnYEAeACxAgAFEKwAGAAYWC/0AAiABDNfrXJPlYAAo52BAKAAsQIABRCsABgAGFgv9AAIgAQzX61yT5WAAKOdgQDIALECAAUQrAAYABhYL/QACIAEM1+tck+VgACjnYEA8ACxAgAFEKwAGAAYWC/0AAiABDNfrXJPlYAAo5yBARgAkQIABRAQFGAAYWC/0AAiABDNfrXJPlYAo52BAUAAsQIABRCsABgAGFgv9AAIgAQzX61yT5WAAKOdgQFoALECAAUQrAAYABhYL/QACIAEM1+tck+VgACjnYEBkACxAgAFEKwAGAAYWC/0AAiABDNfrXJPlYAAo52BAbgAsQIABRCsABgAGFgv9AAIgAQzX61yT5WAAKOdgQHgALECAAUQrAAYABhYL/QACIAEM1+tck+VgACjnYECCACxAgAFEKwAGAAYWC/0AAiABDNfrXJPlYAAo52BAjAAsQIABRCsABgAGFgv9AAIgAQzX61yT5WAAKOdgQJYALECAAUQrAAYABhYL/QACIAEM1+tck+VgACjnYECgACxAgAFEKwAGAAYWC/0AAiABDNfrXJPlYAAo52BAqgAsQIABRCsABgAGFgv9AAIgAQzX61yT5WAAKOcgQLQAJECAAUQEBRgAGFgv9AAIgAQzX61yT5WAKOdgQL4ALECAAUQrAAYABhYL/QACIAEM1+tck+VgACjnYEDIACxAgAFEKwAGAAYWC/0AAiABDNfrXJPlYAAo52BA0gAsQIABRCsABgAGFgv9AAIgAQzX61yT5WAAKOdgQNwALECAAUQrAAYABhYL/QACIAEM1+tck+VgACjnYEDmACxAgAFEKwAGAAYWC/0AAiABDNfrXJPlYAAo52BA8AAsQIABRCsABgAGFgv9AAIgAQzX61yT5WAABxTu2uRu4+zgQC3iveBAfGCAaTwgQM=",
  "base64",
);

class DevelopmentAuthStore implements AuthStore {
  private readonly sessions = new Map<string, User>();

  async createSession(
    _identity: OidcIdentity,
    tokenHash: string,
  ): Promise<User> {
    this.sessions.set(tokenHash, owner);
    return owner;
  }

  async findActiveUser(tokenHash: string): Promise<User | null> {
    return this.sessions.get(tokenHash) ?? null;
  }

  async revokeSession(tokenHash: string): Promise<void> {
    this.sessions.delete(tokenHash);
  }
}

class DevelopmentOidcProvider implements OidcProvider {
  async createAuthorizationRequest(): Promise<OidcAuthorizationRequest> {
    const state = randomUUID();
    const location = new URL("/auth/development", appOrigin);
    location.searchParams.set("state", state);
    return {
      codeVerifier: "v".repeat(64),
      location,
      nonce: randomUUID(),
      state,
    };
  }

  async exchangeAuthorizationCode(): Promise<OidcIdentity> {
    return identity;
  }
}

interface StoredInspection {
  inspection: InspectionRecord;
  job: JobRecord | null;
  outcome: "completed" | "failed";
}

class DevelopmentInspectionRepository implements InspectionApiRepository {
  private readonly records = new Map<string, StoredInspection>();

  reset(): void {
    this.records.clear();
  }

  async createOwned(
    input: CreateOwnedInspectionInput,
  ): Promise<InspectionRecord> {
    const now = new Date();
    const inspection: InspectionRecord = {
      id: input.id,
      ownerUserId: input.ownerUserId,
      title: input.title,
      status: "awaiting_upload",
      sourceType: input.sourceType,
      workflowKey: input.workflowKey,
      sourceObjectKey: input.sourceObjectKey,
      normalizedObjectKey: null,
      predictionObjectKey: null,
      declaredFileName: input.declaredFileName,
      declaredContentType: input.declaredContentType,
      declaredSizeBytes: input.declaredSizeBytes,
      inspectedContentType: null,
      inspectedSizeBytes: null,
      inspectedDurationMs: null,
      inspectedWidth: null,
      inspectedHeight: null,
      inspectedContainer: null,
      inspectedFrameRate: null,
      inspectedStreams: null,
      predictionSchemaVersion: null,
      workflowFingerprint: null,
      missingHardHatEventCount: null,
      qualifyingFrameCount: null,
      peakConfidence: null,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      queuedAt: null,
      startedAt: null,
      completedAt: null,
      updatedAt: now,
    };
    this.records.set(input.id, {
      inspection,
      job: null,
      outcome: input.title.toLowerCase().includes("failure")
        ? "failed"
        : "completed",
    });
    return inspection;
  }

  async completeOwnedUpload(
    ownerUserId: string,
    inspectionId: string,
    inspectedSizeBytes: number,
    now: Date,
    maxAttempts = 3,
  ): Promise<UploadCompletionRecord | null> {
    const record = this.owned(ownerUserId, inspectionId);
    if (!record) return null;
    if (record.job) return record;
    record.inspection = {
      ...record.inspection,
      inspectedSizeBytes,
      queuedAt: now,
      status: "queued",
      updatedAt: now,
    };
    record.job = this.newJob(inspectionId, maxAttempts, now);
    return record;
  }

  async findOwnedById(
    ownerUserId: string,
    inspectionId: string,
  ): Promise<InspectionRecord | null> {
    return this.owned(ownerUserId, inspectionId)?.inspection ?? null;
  }

  async findOwnedUploadCompletionById(
    ownerUserId: string,
    inspectionId: string,
  ): Promise<UploadCompletionRecord | null> {
    return this.owned(ownerUserId, inspectionId) ?? null;
  }

  async findOwnedViewById(
    ownerUserId: string,
    inspectionId: string,
  ): Promise<InspectionViewRecord | null> {
    const record = this.owned(ownerUserId, inspectionId);
    if (!record) return null;
    const view = this.view(record);
    this.advance(record);
    return view;
  }

  async listOwned(
    ownerUserId: string,
    options: ListOwnedInspectionsOptions,
  ): Promise<InspectionPage> {
    const inspections = [...this.records.values()]
      .filter(
        ({ inspection }) =>
          inspection.ownerUserId === ownerUserId &&
          (!options.status || inspection.status === options.status),
      )
      .slice(0, options.limit)
      .map((record) => this.view(record));
    return { hasMore: false, inspections };
  }

  async markOwnedJobDispatched(
    ownerUserId: string,
    inspectionId: string,
    jobId: string,
    dispatchGeneration: number,
    taskName: string,
    now: Date,
  ): Promise<UploadCompletionRecord | null> {
    const record = this.owned(ownerUserId, inspectionId);
    if (
      !record?.job ||
      record.job.id !== jobId ||
      record.job.dispatchGeneration !== dispatchGeneration
    ) {
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
  }

  async requestOwnedCancellation(): Promise<InspectionViewRecord | null> {
    return null;
  }

  async retryOwnedFailure(
    ownerUserId: string,
    inspectionId: string,
    now: Date,
  ): Promise<UploadCompletionRecord | null> {
    const record = this.owned(ownerUserId, inspectionId);
    if (!record?.job || record.inspection.status !== "failed") return null;
    record.outcome = "completed";
    record.inspection = {
      ...record.inspection,
      status: "queued",
      errorCode: null,
      errorMessage: null,
      completedAt: null,
      startedAt: null,
      queuedAt: now,
      updatedAt: now,
    };
    record.job = {
      ...this.newJob(inspectionId, record.job.maxAttempts, now),
      id: record.job.id,
      dispatchGeneration: record.job.dispatchGeneration + 1,
    };
    return record;
  }

  async updateOwnedById(
    ownerUserId: string,
    inspectionId: string,
    update: InspectionUpdate,
  ): Promise<InspectionRecord | null> {
    const record = this.owned(ownerUserId, inspectionId);
    if (!record) return null;
    record.inspection = { ...record.inspection, ...update };
    return record.inspection;
  }

  private advance(record: StoredInspection): void {
    const now = new Date();
    if (record.inspection.status === "queued" && record.job) {
      record.inspection = {
        ...record.inspection,
        status: "processing",
        startedAt: now,
        updatedAt: now,
      };
      record.job = {
        ...record.job,
        attemptCount: 1,
        progressPercent: 55,
        stage: "running_workflow",
        status: "running",
        startedAt: now,
        updatedAt: now,
      };
    } else if (record.inspection.status === "processing" && record.job) {
      if (record.outcome === "failed") {
        record.inspection = {
          ...record.inspection,
          status: "failed",
          errorCode: "provider_unavailable",
          errorMessage: "Fixture inference is temporarily unavailable.",
          completedAt: now,
          updatedAt: now,
        };
        record.job = {
          ...record.job,
          status: "failed",
          errorCode: "provider_unavailable",
          errorMessage: "Fixture inference is temporarily unavailable.",
          finishedAt: now,
          updatedAt: now,
        };
      } else {
        const predictionObjectKey = `inspections/${record.inspection.id}/generations/1/prediction`;
        record.inspection = {
          ...record.inspection,
          status: "completed",
          predictionObjectKey,
          predictionSchemaVersion: 1,
          workflowFingerprint: predictionFixture.workflow.fingerprint,
          inspectedContentType: "video/webm",
          inspectedDurationMs: predictionFixture.source.durationMs,
          inspectedWidth: predictionFixture.source.width,
          inspectedHeight: predictionFixture.source.height,
          missingHardHatEventCount:
            predictionFixture.summary.missingHardHatEventCount,
          qualifyingFrameCount: predictionFixture.summary.qualifyingFrameCount,
          peakConfidence: predictionFixture.summary.peakConfidence,
          completedAt: now,
          updatedAt: now,
        };
        storage.objects.set(
          predictionObjectKey,
          gzipSync(
            JSON.stringify({
              ...predictionFixture,
              inspectionId: record.inspection.id,
            }),
          ),
        );
        record.job = {
          ...record.job,
          status: "completed",
          progressPercent: 100,
          stage: "writing_artifact",
          finishedAt: now,
          updatedAt: now,
        };
      }
    }
  }

  private newJob(
    inspectionId: string,
    maxAttempts: number,
    now: Date,
  ): JobRecord {
    return {
      id: randomUUID(),
      inspectionId,
      status: "pending_dispatch",
      stage: null,
      progressPercent: 0,
      attemptCount: 0,
      maxAttempts,
      dispatchGeneration: 1,
      taskName: null,
      taskEnqueuedAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
      heartbeatAt: null,
      cancelRequestedAt: null,
      errorCode: null,
      errorMessage: null,
      createdAt: now,
      availableAt: now,
      startedAt: null,
      finishedAt: null,
      updatedAt: now,
    };
  }

  private owned(ownerUserId: string, inspectionId: string) {
    const record = this.records.get(inspectionId);
    return record?.inspection.ownerUserId === ownerUserId ? record : null;
  }

  private view(record: StoredInspection): InspectionViewRecord {
    return {
      inspection: { ...record.inspection },
      job: record.job
        ? {
            attemptCount: record.job.attemptCount,
            cancelRequestedAt: record.job.cancelRequestedAt,
            errorCode: record.job.errorCode,
            errorMessage: record.job.errorMessage,
            id: record.job.id,
            progressPercent: record.job.progressPercent,
            stage: record.job.stage,
            maxAttempts: record.job.maxAttempts,
            status: record.job.status,
          }
        : null,
    };
  }
}

class DevelopmentStorage implements ObjectStorage, ObjectAccessAuthorizer {
  readonly objects = new Map<string, Buffer>();

  async authorizeDownload(key: string) {
    return {
      url: new URL(
        `/__e2e/storage/${Buffer.from(key).toString("base64url")}`,
        appOrigin,
      ).href,
      expiresAt: new Date(Date.now() + 60_000),
    };
  }

  async authorizeUpload(key: string, contentType: string) {
    return {
      method: "PUT" as const,
      url: new URL(
        `/__e2e/storage/${Buffer.from(key).toString("base64url")}`,
        appOrigin,
      ).href,
      headers: { "Content-Type": contentType },
      expiresAt: new Date(Date.now() + 60_000),
    };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async metadata(key: string): Promise<StorageObjectMetadata> {
    const value = this.objects.get(key);
    if (!value) throw new StorageObjectNotFoundError(key);
    return { key, sizeBytes: value.byteLength };
  }

  async put(key: string, source: Readable): Promise<StorageObjectMetadata> {
    const chunks: Buffer[] = [];
    for await (const chunk of source) chunks.push(Buffer.from(chunk));
    const value = Buffer.concat(chunks);
    this.objects.set(key, value);
    return { key, sizeBytes: value.byteLength };
  }

  async read(key: string): Promise<Readable> {
    const value = this.objects.get(key);
    if (!value) throw new StorageObjectNotFoundError(key);
    return Readable.from(value);
  }
}

const predictionFixture = PredictionArtifactV1Schema.parse(
  JSON.parse(
    readFileSync(
      new URL(
        "../../fixtures/contracts/prediction-artifact-v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ),
);
const storage = new DevelopmentStorage();
const repository = new DevelopmentInspectionRepository();
const taskDispatcher: TaskDispatcher = {
  async dispatch(message) {
    return {
      outcome: "dispatched",
      taskName: deterministicTaskName(message),
    };
  },
};
const app = createApp({
  appOrigin,
  callbackUrl: new URL("/auth/google/callback", appOrigin),
  inspections: repository,
  objectAccess: storage,
  oidcProvider: new DevelopmentOidcProvider(),
  storage,
  store: new DevelopmentAuthStore(),
  taskDispatcher,
  transactionSecret: "playwright-development-secret-at-least-32-characters",
});

// This route exists only in the Playwright support process. The production
// server never imports this module, so no runtime production flag can enable it.
app.get("/auth/development", (request, response) => {
  repository.reset();
  storage.objects.clear();
  const state =
    typeof request.query.state === "string" ? request.query.state : "";
  const callback = new URL("/auth/google/callback", appOrigin);
  callback.searchParams.set("code", "development-identity");
  callback.searchParams.set("state", state);
  response.redirect(callback.href);
});

app.put(
  "/__e2e/storage/:key",
  express.raw({ limit: "5mb", type: () => true }),
  (request, response) => {
    const key = Buffer.from(request.params.key, "base64url").toString("utf8");
    storage.objects.set(key, Buffer.from(request.body as Buffer));
    response.status(200).end();
  },
);

app.get("/__e2e/storage/:key", (request, response) => {
  const key = Buffer.from(request.params.key, "base64url").toString("utf8");
  const value = storage.objects.get(key);
  if (!value) {
    response.status(404).end();
    return;
  }
  response.type(key.endsWith("prediction") ? "application/gzip" : "video/webm");
  response.send(key.endsWith("prediction") ? value : videoFixture);
});

const server = app.listen(apiPort, "127.0.0.1", () => {
  process.stdout.write(`FactoryLens Playwright API listening on ${apiPort}\n`);
});

function shutdown(): void {
  server.close(() => process.exit(0));
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
