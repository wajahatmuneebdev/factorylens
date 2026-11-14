import type express from "express";

import type {
  CleanupInspectionRecord,
  MaintenanceRepository,
} from "./db/maintenance-repository.js";
import type { InternalIdentityVerifier } from "./internal-auth.js";
import { rejectBrowserSession } from "./security.js";
import { processingObjectKeys, type ObjectStorage } from "./storage.js";
import type { TaskDispatcher } from "./task-dispatcher.js";

const DAY_MS = 24 * 60 * 60 * 1000;
export interface MaintenancePolicy {
  abandonedUploadAgeMs: number;
  batchSize: number;
  dispatchGraceMs: number;
  maxDurationMs: number;
  retentionAgeMs: number;
}
export const DEFAULT_MAINTENANCE_POLICY: MaintenancePolicy = {
  abandonedUploadAgeMs: DAY_MS,
  batchSize: 50,
  dispatchGraceMs: 5 * 60 * 1000,
  maxDurationMs: 50 * 1000,
  retentionAgeMs: 30 * DAY_MS,
};
interface MaintenanceDependencies {
  identityVerifier: InternalIdentityVerifier;
  now?: () => Date;
  policy?: MaintenancePolicy;
  repository: MaintenanceRepository;
  storage: ObjectStorage;
  taskDispatcher: TaskDispatcher;
}
interface OperationSummary {
  attempted: number;
  failed: number;
  succeeded: number;
}

function bearerToken(header: string | undefined): string | null {
  return /^Bearer ([^\s]+)$/i.exec(header ?? "")?.[1] ?? null;
}
function cutoff(now: Date, ageMs: number): Date {
  return new Date(now.getTime() - ageMs);
}
function objectKeys(candidate: CleanupInspectionRecord): string[] {
  const keys = [
    candidate.sourceType === "sample" ? null : candidate.sourceObjectKey,
    candidate.normalizedObjectKey,
    candidate.predictionObjectKey,
  ];
  if (candidate.dispatchGeneration !== null) {
    for (
      let generation = 1;
      generation <= candidate.dispatchGeneration;
      generation += 1
    ) {
      const generated = processingObjectKeys(candidate.id, generation);
      keys.push(
        generated.normalized,
        generated.thumbnail,
        generated.prediction,
      );
    }
  }
  return [...new Set(keys.filter((key): key is string => key !== null))];
}
async function cleanupBatch(
  candidates: CleanupInspectionRecord[],
  storage: ObjectStorage,
  deleteRecord: (candidate: CleanupInspectionRecord) => Promise<boolean>,
  beforeDeadline: () => boolean,
): Promise<OperationSummary> {
  const summary = { attempted: 0, failed: 0, succeeded: 0 };
  for (const candidate of candidates) {
    if (!beforeDeadline()) break;
    summary.attempted += 1;
    try {
      for (const key of objectKeys(candidate)) await storage.delete(key);
      if (await deleteRecord(candidate)) summary.succeeded += 1;
    } catch {
      summary.failed += 1;
    }
  }
  return summary;
}

export function registerMaintenanceRoutes(
  app: express.Express,
  dependencies: MaintenanceDependencies,
): void {
  const policy = dependencies.policy ?? DEFAULT_MAINTENANCE_POLICY;
  const now = dependencies.now ?? (() => new Date());
  app.post("/internal/maintenance/reconcile", async (request, response) => {
    const token = bearerToken(request.header("authorization"));
    if (
      rejectBrowserSession(request) ||
      !token ||
      !(await dependencies.identityVerifier.verify(token))
    ) {
      response.status(401).json({ error: { code: "authentication_required" } });
      return;
    }
    const startedAt = now();
    const deadline = startedAt.getTime() + policy.maxDurationMs;
    const beforeDeadline = (): boolean => now().getTime() < deadline;
    const dispatch: OperationSummary = {
      attempted: 0,
      failed: 0,
      succeeded: 0,
    };
    const pending = await dependencies.repository.listPendingDispatches(
      cutoff(startedAt, policy.dispatchGraceMs),
      policy.batchSize,
    );
    for (const job of pending) {
      if (!beforeDeadline()) break;
      dispatch.attempted += 1;
      try {
        const result = await dependencies.taskDispatcher.dispatch({
          dispatchGeneration: job.dispatchGeneration,
          jobId: job.jobId,
        });
        if (
          await dependencies.repository.markJobDispatched(
            job.jobId,
            job.dispatchGeneration,
            result.taskName,
            now(),
          )
        )
          dispatch.succeeded += 1;
      } catch {
        dispatch.failed += 1;
      }
    }
    const leases = beforeDeadline()
      ? await dependencies.repository.recoverExpiredLeases(
          startedAt,
          policy.batchSize,
        )
      : { failed: 0, retryWait: 0 };
    const abandonedCutoff = cutoff(startedAt, policy.abandonedUploadAgeMs);
    const abandonedCandidates = beforeDeadline()
      ? await dependencies.repository.listAbandonedInspections(
          abandonedCutoff,
          policy.batchSize,
        )
      : [];
    const abandoned = await cleanupBatch(
      abandonedCandidates,
      dependencies.storage,
      (candidate) =>
        dependencies.repository.deleteAbandonedInspection(
          candidate.id,
          abandonedCutoff,
        ),
      beforeDeadline,
    );
    const retentionCutoff = cutoff(startedAt, policy.retentionAgeMs);
    const retentionCandidates = beforeDeadline()
      ? await dependencies.repository.listExpiredTerminalInspections(
          retentionCutoff,
          policy.batchSize,
        )
      : [];
    const retention = await cleanupBatch(
      retentionCandidates,
      dependencies.storage,
      (candidate) =>
        dependencies.repository.deleteExpiredTerminalInspection(
          candidate.id,
          retentionCutoff,
        ),
      beforeDeadline,
    );
    response.json({
      abandoned,
      dispatch,
      durationMs: Math.max(0, now().getTime() - startedAt.getTime()),
      leases,
      retention,
      timedOut: !beforeDeadline(),
    });
  });
}
