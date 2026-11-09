import type { User } from "@factorylens/contracts";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import type { AuthStore, OidcProvider } from "../src/auth.js";
import type {
  CreateOwnedInspectionInput,
  InspectionApiRepository,
  InspectionRecord,
  InspectionViewRecord,
} from "../src/db/inspection-repository.js";
import { hashSessionToken } from "../src/session.js";

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
}

const oidcProvider: OidcProvider = {
  createAuthorizationRequest: vi.fn(),
  exchangeAuthorizationCode: vi.fn(),
};

function inspectionApp(repository: FakeInspectionRepository) {
  return createApp({
    appOrigin,
    callbackUrl: new URL("/auth/google/callback", appOrigin),
    inspections: repository,
    now: () => currentTime,
    oidcProvider,
    store: new FakeAuthStore(),
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
      upload: null,
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
