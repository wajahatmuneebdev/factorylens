import type { User } from "@factorylens/contracts";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import type {
  InspectionRecord,
  OwnerScopedInspectionRepository,
} from "../src/db/inspection-repository.js";
import {
  ownedInspection,
  requireInspectionOwner,
} from "../src/inspection-authorization.js";
import {
  hashSessionToken,
  requireSession,
  type SessionStore,
} from "../src/session.js";

const currentTime = new Date("2026-11-09T08:00:00.000Z");
const owner: User = {
  id: "123e4567-e89b-42d3-a456-426614174000",
  avatarUrl: null,
  displayName: "Factory Owner",
  email: "owner@example.com",
};
const otherOwnerId = "223e4567-e89b-42d3-a456-426614174000";
const ownedInspectionId = "323e4567-e89b-42d3-a456-426614174000";
const crossUserInspectionId = "423e4567-e89b-42d3-a456-426614174000";
const unknownInspectionId = "523e4567-e89b-42d3-a456-426614174000";

function inspection(
  id: string,
  ownerUserId: string,
  title: string,
): InspectionRecord {
  return {
    id,
    ownerUserId,
    title,
    status: "awaiting_upload",
    sourceType: "upload",
    workflowKey: "factory-safety-v1",
    sourceObjectKey: `inspections/${id}/source`,
    normalizedObjectKey: null,
    predictionObjectKey: null,
    declaredFileName: "source.webm",
    declaredContentType: "video/webm",
    declaredSizeBytes: 1024,
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
    createdAt: currentTime,
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    updatedAt: currentTime,
  };
}

class FakeSessionStore implements SessionStore {
  readonly findActiveUser = vi.fn(
    async (tokenHash: string): Promise<User | null> =>
      tokenHash === hashSessionToken("active-token") ? owner : null,
  );
}

class FakeInspectionRepository implements OwnerScopedInspectionRepository {
  private readonly inspections = new Map([
    [ownedInspectionId, inspection(ownedInspectionId, owner.id, "Owned")],
    [
      crossUserInspectionId,
      inspection(crossUserInspectionId, otherOwnerId, "Private metadata"),
    ],
  ]);

  readonly findOwnedById = vi.fn(
    async (
      ownerUserId: string,
      inspectionId: string,
    ): Promise<InspectionRecord | null> => {
      const record = this.inspections.get(inspectionId);
      return record?.ownerUserId === ownerUserId ? record : null;
    },
  );

  readonly updateOwnedById = vi.fn(
    async (): Promise<InspectionRecord | null> => null,
  );
}

function authorizationApp(
  sessions: SessionStore,
  inspections: OwnerScopedInspectionRepository,
) {
  const app = express();
  app.use("/api", requireSession({ store: sessions, now: () => currentTime }));
  app.get(
    "/api/inspections/:id",
    requireInspectionOwner(inspections),
    (receivedRequest, response) => {
      const record = ownedInspection(receivedRequest);
      response.json({ id: record.id, title: record.title });
    },
  );
  app.post("/internal/tasks/process", (_request, response) => {
    response.status(401).json({
      error: {
        code: "access_denied",
        category: "authorization",
        message: "Internal service authentication is required.",
      },
    });
  });
  return app;
}

describe("browser authorization boundaries", () => {
  it("rejects missing, expired, and revoked sessions with one safe contract", async () => {
    const sessions = new FakeSessionStore();
    const app = authorizationApp(sessions, new FakeInspectionRepository());
    const expectedError = {
      error: {
        code: "authentication_required",
        category: "authorization",
        message: "Sign in to continue.",
      },
    };

    const missing = await request(app).get(
      `/api/inspections/${ownedInspectionId}`,
    );
    const expired = await request(app)
      .get(`/api/inspections/${ownedInspectionId}`)
      .set("Cookie", "__Host-factorylens_session=expired-token");
    const revoked = await request(app)
      .get(`/api/inspections/${ownedInspectionId}`)
      .set("Cookie", "__Host-factorylens_session=revoked-token");

    for (const response of [missing, expired, revoked]) {
      expect(response.status).toBe(401);
      expect(response.body).toEqual(expectedError);
    }
    expect(expired.headers["set-cookie"]?.[0]).toContain(
      "__Host-factorylens_session=;",
    );
    expect(revoked.headers["set-cookie"]?.[0]).toContain(
      "__Host-factorylens_session=;",
    );
  });

  it("allows the owner and hides cross-user inspection existence and metadata", async () => {
    const inspections = new FakeInspectionRepository();
    const app = authorizationApp(new FakeSessionStore(), inspections);
    const cookie = "__Host-factorylens_session=active-token";

    const allowed = await request(app)
      .get(`/api/inspections/${ownedInspectionId}`)
      .set("Cookie", cookie);
    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual({ id: ownedInspectionId, title: "Owned" });

    const denied = await request(app)
      .get(`/api/inspections/${crossUserInspectionId}`)
      .set("Cookie", cookie);
    const unknown = await request(app)
      .get(`/api/inspections/${unknownInspectionId}`)
      .set("Cookie", cookie);
    const safeNotFound = {
      error: {
        code: "inspection_not_found",
        category: "terminal",
        message: "Inspection not found.",
      },
    };

    expect(denied.status).toBe(404);
    expect(denied.body).toEqual(safeNotFound);
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual(safeNotFound);
    expect(JSON.stringify(denied.body)).not.toContain("Private metadata");
    expect(inspections.findOwnedById).toHaveBeenCalledWith(
      owner.id,
      crossUserInspectionId,
    );
  });

  it("does not apply browser sessions to the internal service boundary", async () => {
    const sessions = new FakeSessionStore();
    const app = authorizationApp(sessions, new FakeInspectionRepository());

    const response = await request(app)
      .post("/internal/tasks/process")
      .set("Cookie", "__Host-factorylens_session=active-token");

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("access_denied");
    expect(sessions.findActiveUser).not.toHaveBeenCalled();
  });
});
