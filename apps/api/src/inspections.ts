import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  CancelInspectionRequestSchema,
  CreateInspectionRequestSchema,
  ERROR_DEFINITIONS,
  ErrorCodeSchema,
  ExportCsvRequestSchema,
  GetArtifactsRequestSchema,
  InspectionPathParamsSchema,
  InspectionSchema,
  ListInspectionsQuerySchema,
  RetryInspectionRequestSchema,
  UploadCompleteRequestSchema,
  type Inspection,
  type PredictionArtifactV1,
  type SafeError,
} from "@factorylens/contracts";
import express, {
  type ErrorRequestHandler,
  type Express,
  type Response,
} from "express";
import { z } from "zod";

import type {
  InspectionApiRepository,
  InspectionListCursor,
  InspectionRecord,
  InspectionViewRecord,
  UploadCompletionRecord,
} from "./db/inspection-repository.js";
import {
  InspectionCommandConflictError,
  InspectionStateConflictError,
} from "./db/inspection-repository.js";
import {
  predictionCsvRows,
  readPredictionArtifact,
} from "./prediction-export.js";
import { authenticatedUser } from "./session.js";
import {
  type ObjectAccessAuthorizer,
  type ObjectStorage,
  sourceObjectKey,
  StorageObjectNotFoundError,
} from "./storage.js";
import type { TaskDispatcher } from "./task-dispatcher.js";

const cursorPayloadSchema = z
  .object({
    createdAt: z.iso.datetime({ offset: true }),
    id: z.uuid(),
  })
  .strict();

const PREPARED_SAMPLE = {
  contentType: "video/webm",
  fileName: "assembly-line-no-hard-hat.webm",
  objectKey: "samples/assembly-line-no-hard-hat.webm",
} as const;

export interface InspectionRouteDependencies {
  appOrigin: URL;
  now?: () => Date;
  objectAccess: ObjectAccessAuthorizer;
  repository: InspectionApiRepository;
  storage: ObjectStorage;
  taskDispatcher: TaskDispatcher;
}

function sendSafeError(
  response: Response,
  status: number,
  error: SafeError,
): void {
  response.status(status).json({ error });
}

function sendInvalidRequest(response: Response, message: string): void {
  sendSafeError(response, 400, {
    code: "invalid_request",
    category: "terminal",
    message,
  });
}

function storedError(
  code: string | null,
  message: string | null,
): SafeError | null {
  const parsedCode = ErrorCodeSchema.safeParse(code);
  if (!parsedCode.success || !message) {
    return null;
  }

  return {
    code: parsedCode.data,
    category: ERROR_DEFINITIONS[parsedCode.data],
    message,
  };
}

function inspectionResponse(record: InspectionViewRecord): Inspection {
  const { inspection, job } = record;
  const summary =
    inspection.missingHardHatEventCount !== null &&
    inspection.qualifyingFrameCount !== null
      ? {
          missingHardHatEventCount: inspection.missingHardHatEventCount,
          peakConfidence: inspection.peakConfidence,
          qualifyingFrameCount: inspection.qualifyingFrameCount,
        }
      : null;

  return InspectionSchema.parse({
    id: inspection.id,
    title: inspection.title,
    status: inspection.status,
    sourceType: inspection.sourceType,
    workflowKey: inspection.workflowKey,
    progress: {
      stage: job?.stage ?? null,
      percent: job?.progressPercent ?? 0,
    },
    job: job
      ? {
          status: job.status,
          attempt: job.attemptCount,
          maxAttempts: job.maxAttempts,
          cancellationRequested: job.cancelRequestedAt !== null,
        }
      : null,
    summary,
    error:
      storedError(inspection.errorCode, inspection.errorMessage) ??
      storedError(job?.errorCode ?? null, job?.errorMessage ?? null),
    createdAt: inspection.createdAt.toISOString(),
    queuedAt: inspection.queuedAt?.toISOString() ?? null,
    startedAt: inspection.startedAt?.toISOString() ?? null,
    completedAt: inspection.completedAt?.toISOString() ?? null,
    updatedAt: inspection.updatedAt.toISOString(),
  });
}

function decodeCursor(value: string): InspectionListCursor | null {
  try {
    const parsed = cursorPayloadSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
    return { createdAt: new Date(parsed.createdAt), id: parsed.id };
  } catch {
    return null;
  }
}

function encodeCursor(record: InspectionViewRecord): string {
  return Buffer.from(
    JSON.stringify({
      createdAt: record.inspection.createdAt.toISOString(),
      id: record.inspection.id,
    }),
  ).toString("base64url");
}

function uploadCompleteResponse(record: UploadCompletionRecord) {
  if (!record.job) {
    throw new Error("Completed upload has no durable job");
  }

  return {
    inspection: inspectionResponse(record),
    job: { id: record.job.id, status: record.job.status },
  };
}

async function dispatchPendingJob(
  dependencies: InspectionRouteDependencies,
  ownerUserId: string,
  inspectionId: string,
  completion: UploadCompletionRecord,
  now: Date,
): Promise<UploadCompletionRecord> {
  const job = completion.job;
  if (!job) {
    throw new Error("Inspection command has no durable job");
  }
  if (job.status !== "pending_dispatch" || job.taskEnqueuedAt !== null) {
    return completion;
  }

  const dispatched = await dependencies.taskDispatcher.dispatch({
    dispatchGeneration: job.dispatchGeneration,
    jobId: job.id,
  });
  const marked = await dependencies.repository.markOwnedJobDispatched(
    ownerUserId,
    inspectionId,
    job.id,
    job.dispatchGeneration,
    dispatched.taskName,
    now,
  );
  if (!marked?.job) {
    throw new Error("Dispatched job could not be recorded");
  }
  return marked;
}

export function registerInspectionRoutes(
  app: Express,
  dependencies: InspectionRouteDependencies,
): void {
  const now = dependencies.now ?? (() => new Date());
  app.use("/api/inspections", express.json({ limit: "16kb" }));

  app.post("/api/inspections", async (request, response) => {
    if (request.get("origin") !== dependencies.appOrigin.origin) {
      sendSafeError(response, 403, {
        code: "access_denied",
        category: "authorization",
        message: "The inspection request origin is not allowed.",
      });
      return;
    }

    const parsed = CreateInspectionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      sendInvalidRequest(response, "The inspection request is invalid.");
      return;
    }

    const id = randomUUID();
    const directSource =
      parsed.data.source.sourceType === "sample" ? null : parsed.data.source;
    let inspection: InspectionRecord;
    try {
      inspection = await dependencies.repository.createOwned({
        declaredContentType:
          directSource?.contentType ?? PREPARED_SAMPLE.contentType,
        declaredFileName: directSource?.fileName ?? PREPARED_SAMPLE.fileName,
        declaredSizeBytes: directSource?.sizeBytes ?? null,
        id,
        ownerUserId: authenticatedUser(request).id,
        sourceObjectKey:
          parsed.data.source.sourceType === "sample"
            ? PREPARED_SAMPLE.objectKey
            : sourceObjectKey(id),
        sourceType: parsed.data.source.sourceType,
        title: parsed.data.title,
        workflowKey: parsed.data.workflowKey,
      });
    } catch {
      sendSafeError(response, 503, {
        code: "provider_unavailable",
        category: "retryable",
        message: "Inspection creation is temporarily unavailable.",
      });
      return;
    }

    try {
      if (!directSource) {
        const metadata = await dependencies.storage.metadata(
          inspection.sourceObjectKey,
        );
        const completion = await dependencies.repository.completeOwnedUpload(
          authenticatedUser(request).id,
          inspection.id,
          metadata.sizeBytes,
          now(),
        );
        if (!completion) throw new Error("Prepared sample inspection was lost");
        const dispatched = await dispatchPendingJob(
          dependencies,
          authenticatedUser(request).id,
          inspection.id,
          completion,
          now(),
        );
        response.status(201).json({
          inspection: inspectionResponse(dispatched),
          upload: null,
        });
        return;
      }
      const upload = await dependencies.objectAccess.authorizeUpload(
        inspection.sourceObjectKey,
        directSource.contentType,
      );
      response.status(201).json({
        inspection: inspectionResponse({ inspection, job: null }),
        upload: upload
          ? { ...upload, expiresAt: upload.expiresAt.toISOString() }
          : null,
      });
    } catch {
      sendSafeError(response, 503, {
        code: "storage_unavailable",
        category: "retryable",
        message: "Upload authorization is temporarily unavailable.",
      });
    }
  });

  app.get("/api/inspections", async (request, response) => {
    const parsed = ListInspectionsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      sendInvalidRequest(response, "The inspection list request is invalid.");
      return;
    }

    const cursor = parsed.data.cursor
      ? decodeCursor(parsed.data.cursor)
      : undefined;
    if (parsed.data.cursor && !cursor) {
      sendInvalidRequest(response, "The inspection cursor is invalid.");
      return;
    }

    try {
      const page = await dependencies.repository.listOwned(
        authenticatedUser(request).id,
        {
          cursor: cursor ?? undefined,
          limit: parsed.data.limit,
          status: parsed.data.status,
        },
      );
      const lastInspection = page.inspections.at(-1);

      response.json({
        inspections: page.inspections.map(inspectionResponse),
        nextCursor:
          page.hasMore && lastInspection ? encodeCursor(lastInspection) : null,
      });
    } catch {
      sendSafeError(response, 503, {
        code: "provider_unavailable",
        category: "retryable",
        message: "Inspection history is temporarily unavailable.",
      });
    }
  });

  app.post(
    "/api/inspections/:id/upload-complete",
    async (request, response) => {
      if (request.get("origin") !== dependencies.appOrigin.origin) {
        sendSafeError(response, 403, {
          code: "access_denied",
          category: "authorization",
          message: "The inspection request origin is not allowed.",
        });
        return;
      }

      const path = InspectionPathParamsSchema.safeParse(request.params);
      const body = UploadCompleteRequestSchema.safeParse(request.body);
      if (!path.success || !body.success) {
        sendInvalidRequest(
          response,
          "The upload completion request is invalid.",
        );
        return;
      }

      const ownerUserId = authenticatedUser(request).id;
      let completion: UploadCompletionRecord | null;
      try {
        completion =
          await dependencies.repository.findOwnedUploadCompletionById(
            ownerUserId,
            path.data.id,
          );
      } catch {
        sendSafeError(response, 503, {
          code: "provider_unavailable",
          category: "retryable",
          message: "Upload completion is temporarily unavailable.",
        });
        return;
      }

      if (!completion) {
        sendSafeError(response, 404, {
          code: "inspection_not_found",
          category: "terminal",
          message: "Inspection not found.",
        });
        return;
      }

      if (!completion.job) {
        if (
          completion.inspection.status !== "awaiting_upload" ||
          completion.inspection.declaredSizeBytes === null ||
          completion.inspection.sourceType === "sample"
        ) {
          sendSafeError(response, 409, {
            code: "inspection_state_conflict",
            category: "terminal",
            message: "This inspection cannot complete an upload.",
          });
          return;
        }

        let sizeBytes: number;
        try {
          const metadata = await dependencies.storage.metadata(
            completion.inspection.sourceObjectKey,
          );
          sizeBytes = metadata.sizeBytes;
        } catch (error) {
          if (error instanceof StorageObjectNotFoundError) {
            sendSafeError(response, 400, {
              code: "invalid_media",
              category: "terminal",
              message: "The uploaded video was not found.",
            });
          } else {
            sendSafeError(response, 503, {
              code: "storage_unavailable",
              category: "retryable",
              message:
                "Uploaded video verification is temporarily unavailable.",
            });
          }
          return;
        }

        if (sizeBytes !== completion.inspection.declaredSizeBytes) {
          sendSafeError(response, 400, {
            code: "invalid_media",
            category: "terminal",
            message:
              "The uploaded video size does not match the declared size.",
          });
          return;
        }

        try {
          completion = await dependencies.repository.completeOwnedUpload(
            ownerUserId,
            path.data.id,
            sizeBytes,
            now(),
          );
        } catch (error) {
          if (error instanceof InspectionStateConflictError) {
            sendSafeError(response, 409, {
              code: "inspection_state_conflict",
              category: "terminal",
              message: "This inspection cannot complete an upload.",
            });
          } else {
            sendSafeError(response, 503, {
              code: "provider_unavailable",
              category: "retryable",
              message: "Upload completion is temporarily unavailable.",
            });
          }
          return;
        }

        if (!completion) {
          sendSafeError(response, 404, {
            code: "inspection_not_found",
            category: "terminal",
            message: "Inspection not found.",
          });
          return;
        }
      }

      const job = completion.job;
      if (!job) {
        sendSafeError(response, 503, {
          code: "provider_unavailable",
          category: "retryable",
          message: "Upload completion is temporarily unavailable.",
        });
        return;
      }

      if (job.status === "pending_dispatch" && job.taskEnqueuedAt === null) {
        try {
          completion = await dispatchPendingJob(
            dependencies,
            ownerUserId,
            path.data.id,
            completion,
            now(),
          );
        } catch {
          sendSafeError(response, 503, {
            code: "provider_unavailable",
            category: "retryable",
            message: "Processing dispatch is temporarily unavailable.",
          });
          return;
        }
      }

      response.json(uploadCompleteResponse(completion));
    },
  );

  app.get("/api/inspections/:id", async (request, response) => {
    const path = InspectionPathParamsSchema.safeParse(request.params);
    if (!path.success) {
      sendInvalidRequest(response, "The inspection identifier is invalid.");
      return;
    }

    try {
      const inspection = await dependencies.repository.findOwnedViewById(
        authenticatedUser(request).id,
        path.data.id,
      );
      if (!inspection) {
        sendSafeError(response, 404, {
          code: "inspection_not_found",
          category: "terminal",
          message: "Inspection not found.",
        });
        return;
      }

      response.json({ inspection: inspectionResponse(inspection) });
    } catch {
      sendSafeError(response, 503, {
        code: "provider_unavailable",
        category: "retryable",
        message: "Inspection access is temporarily unavailable.",
      });
    }
  });

  app.get("/api/inspections/:id/artifacts", async (request, response) => {
    const path = GetArtifactsRequestSchema.safeParse(request.params);
    if (!path.success) {
      sendInvalidRequest(response, "The inspection identifier is invalid.");
      return;
    }

    let record: InspectionViewRecord | null;
    try {
      record = await dependencies.repository.findOwnedViewById(
        authenticatedUser(request).id,
        path.data.id,
      );
    } catch {
      sendSafeError(response, 503, {
        code: "provider_unavailable",
        category: "retryable",
        message: "Inspection artifacts are temporarily unavailable.",
      });
      return;
    }

    if (!record) {
      sendSafeError(response, 404, {
        code: "inspection_not_found",
        category: "terminal",
        message: "Inspection not found.",
      });
      return;
    }

    const { inspection } = record;
    if (inspection.status !== "completed") {
      sendSafeError(response, 409, {
        code: "inspection_state_conflict",
        category: "terminal",
        message: "Artifacts are available only for completed inspections.",
      });
      return;
    }
    if (
      !inspection.predictionObjectKey ||
      inspection.predictionSchemaVersion !== 1
    ) {
      sendSafeError(response, 503, {
        code: "storage_unavailable",
        category: "retryable",
        message: "Inspection artifacts are temporarily unavailable.",
      });
      return;
    }

    try {
      const videoObjectKey =
        inspection.normalizedObjectKey ?? inspection.sourceObjectKey;
      await Promise.all([
        dependencies.storage.metadata(videoObjectKey),
        dependencies.storage.metadata(inspection.predictionObjectKey),
      ]);
      const [video, predictions] = await Promise.all([
        dependencies.objectAccess.authorizeDownload(videoObjectKey),
        dependencies.objectAccess.authorizeDownload(
          inspection.predictionObjectKey,
        ),
      ]);
      response.set("Cache-Control", "private, no-store");
      response.json({
        video: { ...video, expiresAt: video.expiresAt.toISOString() },
        predictions: {
          ...predictions,
          expiresAt: predictions.expiresAt.toISOString(),
        },
        predictionSchemaVersion: 1,
      });
    } catch {
      sendSafeError(response, 503, {
        code: "storage_unavailable",
        category: "retryable",
        message: "Inspection artifacts are temporarily unavailable.",
      });
    }
  });

  app.get("/api/inspections/:id/export.csv", async (request, response) => {
    const path = ExportCsvRequestSchema.safeParse(request.params);
    if (!path.success) {
      sendInvalidRequest(response, "The inspection identifier is invalid.");
      return;
    }

    let record: InspectionViewRecord | null;
    try {
      record = await dependencies.repository.findOwnedViewById(
        authenticatedUser(request).id,
        path.data.id,
      );
    } catch {
      sendSafeError(response, 503, {
        code: "provider_unavailable",
        category: "retryable",
        message: "Inspection export is temporarily unavailable.",
      });
      return;
    }

    if (!record) {
      sendSafeError(response, 404, {
        code: "inspection_not_found",
        category: "terminal",
        message: "Inspection not found.",
      });
      return;
    }

    const { inspection } = record;
    if (inspection.status !== "completed") {
      sendSafeError(response, 409, {
        code: "inspection_state_conflict",
        category: "terminal",
        message: "Exports are available only for completed inspections.",
      });
      return;
    }
    if (
      !inspection.predictionObjectKey ||
      inspection.predictionSchemaVersion !== 1
    ) {
      sendSafeError(response, 503, {
        code: "storage_unavailable",
        category: "retryable",
        message: "Inspection export is temporarily unavailable.",
      });
      return;
    }

    let artifact: PredictionArtifactV1;
    try {
      artifact = await readPredictionArtifact(
        dependencies.storage,
        inspection.predictionObjectKey,
        inspection.id,
      );
    } catch {
      sendSafeError(response, 503, {
        code: "storage_unavailable",
        category: "retryable",
        message: "Inspection export is temporarily unavailable.",
      });
      return;
    }

    response.status(200);
    response.set({
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="factorylens-${inspection.id}.csv"`,
      "Content-Type": "text/csv; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
    });
    try {
      await pipeline(Readable.from(predictionCsvRows(artifact)), response);
    } catch {
      if (!response.destroyed) {
        response.destroy();
      }
    }
  });

  app.post("/api/inspections/:id/cancel", async (request, response) => {
    if (request.get("origin") !== dependencies.appOrigin.origin) {
      sendSafeError(response, 403, {
        code: "access_denied",
        category: "authorization",
        message: "The inspection request origin is not allowed.",
      });
      return;
    }

    const path = InspectionPathParamsSchema.safeParse(request.params);
    const body = CancelInspectionRequestSchema.safeParse(request.body);
    if (!path.success || !body.success) {
      sendInvalidRequest(response, "The cancellation request is invalid.");
      return;
    }

    try {
      const inspection = await dependencies.repository.requestOwnedCancellation(
        authenticatedUser(request).id,
        path.data.id,
        now(),
      );
      if (!inspection) {
        sendSafeError(response, 404, {
          code: "inspection_not_found",
          category: "terminal",
          message: "Inspection not found.",
        });
        return;
      }

      response.json({ inspection: inspectionResponse(inspection) });
    } catch (error) {
      if (error instanceof InspectionCommandConflictError) {
        sendSafeError(response, 409, {
          code: "inspection_state_conflict",
          category: "terminal",
          message: "This inspection cannot be cancelled.",
        });
        return;
      }
      sendSafeError(response, 503, {
        code: "provider_unavailable",
        category: "retryable",
        message: "Inspection cancellation is temporarily unavailable.",
      });
    }
  });

  app.post("/api/inspections/:id/retry", async (request, response) => {
    if (request.get("origin") !== dependencies.appOrigin.origin) {
      sendSafeError(response, 403, {
        code: "access_denied",
        category: "authorization",
        message: "The inspection request origin is not allowed.",
      });
      return;
    }

    const path = InspectionPathParamsSchema.safeParse(request.params);
    const body = RetryInspectionRequestSchema.safeParse(request.body);
    if (!path.success || !body.success) {
      sendInvalidRequest(response, "The retry request is invalid.");
      return;
    }

    const ownerUserId = authenticatedUser(request).id;
    let completion: UploadCompletionRecord | null;
    try {
      completion = await dependencies.repository.retryOwnedFailure(
        ownerUserId,
        path.data.id,
        now(),
      );
    } catch (error) {
      if (error instanceof InspectionCommandConflictError) {
        sendSafeError(response, 409, {
          code: "inspection_state_conflict",
          category: "terminal",
          message: "This inspection cannot be retried.",
        });
        return;
      }
      sendSafeError(response, 503, {
        code: "provider_unavailable",
        category: "retryable",
        message: "Inspection retry is temporarily unavailable.",
      });
      return;
    }

    if (!completion) {
      sendSafeError(response, 404, {
        code: "inspection_not_found",
        category: "terminal",
        message: "Inspection not found.",
      });
      return;
    }

    try {
      completion = await dispatchPendingJob(
        dependencies,
        ownerUserId,
        path.data.id,
        completion,
        now(),
      );
    } catch {
      sendSafeError(response, 503, {
        code: "provider_unavailable",
        category: "retryable",
        message: "Processing dispatch is temporarily unavailable.",
      });
      return;
    }

    response.json({ inspection: inspectionResponse(completion) });
  });

  const invalidBodyHandler: ErrorRequestHandler = (
    error,
    _request,
    response,
    next,
  ) => {
    if (
      error instanceof SyntaxError &&
      "status" in error &&
      (error.status === 400 || error.status === 413 || error.status === 415)
    ) {
      sendInvalidRequest(response, "The inspection request is invalid.");
      return;
    }
    next(error);
  };
  app.use("/api/inspections", invalidBodyHandler);
}
