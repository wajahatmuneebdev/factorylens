import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";

import type {
  CleanupInspectionRecord,
  MaintenanceRepository,
  PendingDispatchRecord,
} from "../src/db/maintenance-repository.js";
import type { InternalIdentityVerifier } from "../src/internal-auth.js";
import {
  registerMaintenanceRoutes,
  type MaintenancePolicy,
} from "../src/maintenance.js";
import type { ObjectStorage } from "../src/storage.js";
import {
  deterministicTaskName,
  type TaskDispatcher,
} from "../src/task-dispatcher.js";

const currentTime = new Date("2026-11-13T08:00:00.000Z");
const policy: MaintenancePolicy = {
  abandonedUploadAgeMs: 24 * 60 * 60 * 1000,
  batchSize: 2,
  dispatchGraceMs: 5 * 60 * 1000,
  maxDurationMs: 50_000,
  retentionAgeMs: 30 * 24 * 60 * 60 * 1000,
};

function candidate(id = randomUUID()): CleanupInspectionRecord {
  return {
    dispatchGeneration: 2,
    id,
    normalizedObjectKey: `inspections/${id}/generations/2/normalized`,
    predictionObjectKey: `inspections/${id}/generations/2/prediction`,
    sourceObjectKey: `inspections/${id}/source`,
    sourceType: "upload",
  };
}

class FakeRepository implements MaintenanceRepository {
  abandoned: CleanupInspectionRecord[] = [];
  deletedAbandoned: string[] = [];
  deletedTerminal: string[] = [];
  dispatched = new Set<string>();
  pending: PendingDispatchRecord[] = [];
  terminal: CleanupInspectionRecord[] = [];

  async listPendingDispatches(_cutoff: Date, limit: number) {
    return this.pending
      .filter((job) => !this.dispatched.has(job.jobId))
      .slice(0, limit);
  }
  async markJobDispatched(jobId: string) {
    if (this.dispatched.has(jobId)) return false;
    this.dispatched.add(jobId);
    return true;
  }
  async recoverExpiredLeases() {
    return { failed: 1, retryWait: 1 };
  }
  async listAbandonedInspections(_cutoff: Date, limit: number) {
    return this.abandoned.slice(0, limit);
  }
  async listExpiredTerminalInspections(_cutoff: Date, limit: number) {
    return this.terminal.slice(0, limit);
  }
  async deleteAbandonedInspection(id: string) {
    this.deletedAbandoned.push(id);
    this.abandoned = this.abandoned.filter((item) => item.id !== id);
    return true;
  }
  async deleteExpiredTerminalInspection(id: string) {
    this.deletedTerminal.push(id);
    this.terminal = this.terminal.filter((item) => item.id !== id);
    return true;
  }
}

class FakeStorage implements ObjectStorage {
  readonly deleted: string[] = [];
  failKey?: string;
  async delete(key: string) {
    this.deleted.push(key);
    if (key === this.failKey) throw new Error("storage unavailable");
  }
  async put() {
    throw new Error("unused");
  }
  async read() {
    return Readable.from([]);
  }
  async metadata() {
    throw new Error("unused");
  }
  async exists() {
    return false;
  }
}

class FakeDispatcher implements TaskDispatcher {
  readonly messages: string[] = [];
  async dispatch(message: { dispatchGeneration: number; jobId: string }) {
    this.messages.push(deterministicTaskName(message));
    return {
      outcome: "dispatched" as const,
      taskName: deterministicTaskName(message),
    };
  }
}

function maintenanceApp(
  repository: FakeRepository,
  storage = new FakeStorage(),
  dispatcher = new FakeDispatcher(),
  verifier: InternalIdentityVerifier = {
    verify: async (token) => token === "valid",
  },
) {
  const app = express();
  registerMaintenanceRoutes(app, {
    identityVerifier: verifier,
    now: () => currentTime,
    policy,
    repository,
    storage,
    taskDispatcher: dispatcher,
  });
  return { app, dispatcher, storage };
}

describe("POST /internal/maintenance/reconcile", () => {
  it("rejects requests outside the internal service identity boundary", async () => {
    const { app } = maintenanceApp(new FakeRepository());

    expect(
      (await request(app).post("/internal/maintenance/reconcile")).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .post("/internal/maintenance/reconcile")
          .set("Authorization", "Bearer invalid")
      ).status,
    ).toBe(401);
  });

  it("batches each repair and reports partial storage failure", async () => {
    const repository = new FakeRepository();
    repository.pending = [
      { dispatchGeneration: 3, jobId: randomUUID() },
      { dispatchGeneration: 4, jobId: randomUUID() },
      { dispatchGeneration: 5, jobId: randomUUID() },
    ];
    repository.abandoned = [candidate(), candidate()];
    repository.terminal = [candidate()];
    const storage = new FakeStorage();
    storage.failKey = repository.abandoned[1]!.sourceObjectKey;
    const { app, dispatcher } = maintenanceApp(repository, storage);

    const response = await request(app)
      .post("/internal/maintenance/reconcile")
      .set("Authorization", "Bearer valid");

    expect(response.status).toBe(200);
    expect(response.body.dispatch).toEqual({
      attempted: 2,
      failed: 0,
      succeeded: 2,
    });
    expect(response.body.leases).toEqual({ failed: 1, retryWait: 1 });
    expect(response.body.abandoned).toEqual({
      attempted: 2,
      failed: 1,
      succeeded: 1,
    });
    expect(response.body.retention).toEqual({
      attempted: 1,
      failed: 0,
      succeeded: 1,
    });
    expect(dispatcher.messages).toHaveLength(2);
    expect(repository.deletedAbandoned).toEqual([
      repository.deletedAbandoned[0],
    ]);
    expect(repository.deletedTerminal).toHaveLength(1);
    const terminal = repository.deletedTerminal[0]!;
    expect(storage.deleted).toContain(
      `inspections/${terminal}/generations/1/prediction`,
    );
  });

  it("retains the shared prepared-sample source during inspection cleanup", async () => {
    const repository = new FakeRepository();
    repository.terminal = [
      {
        ...candidate(),
        sourceObjectKey: "samples/assembly-line-no-hard-hat.webm",
        sourceType: "sample",
      },
    ];
    const storage = new FakeStorage();
    const { app } = maintenanceApp(repository, storage);

    const response = await request(app)
      .post("/internal/maintenance/reconcile")
      .set("Authorization", "Bearer valid");

    expect(response.status).toBe(200);
    expect(storage.deleted).not.toContain(
      "samples/assembly-line-no-hard-hat.webm",
    );
    expect(repository.deletedTerminal).toHaveLength(1);
  });

  it("is safe under concurrent invocations and repeats deterministic dispatch", async () => {
    const repository = new FakeRepository();
    const pending = { dispatchGeneration: 7, jobId: randomUUID() };
    repository.pending = [pending];
    const dispatcher = new FakeDispatcher();
    const { app } = maintenanceApp(repository, new FakeStorage(), dispatcher);

    const [first, second] = await Promise.all([
      request(app)
        .post("/internal/maintenance/reconcile")
        .set("Authorization", "Bearer valid"),
      request(app)
        .post("/internal/maintenance/reconcile")
        .set("Authorization", "Bearer valid"),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(new Set(dispatcher.messages)).toEqual(
      new Set([deterministicTaskName(pending)]),
    );
    expect(repository.dispatched).toEqual(new Set([pending.jobId]));
  });
});
