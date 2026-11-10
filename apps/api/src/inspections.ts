import { randomUUID } from "node:crypto";

import {
  CreateInspectionRequestSchema,
  ERROR_DEFINITIONS,
  ErrorCodeSchema,
  InspectionPathParamsSchema,
  InspectionSchema,
  ListInspectionsQuerySchema,
  UploadCompleteRequestSchema,
  type Inspection,
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
  InspectionViewRecord,
  UploadCompletionRecord,
} from "./db/inspection-repository.js";
import { InspectionStateConflictError } from "./db/inspection-repository.js";
import { authenticatedUser } from "./session.js";
import {
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

export interface InspectionRouteDependencies {
  appOrigin: URL;
  now?: () => Date;
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
    try {
      const inspection = await dependencies.repository.createOwned({
        declaredContentType: directSource?.contentType ?? null,
        declaredFileName: directSource?.fileName ?? null,
        declaredSizeBytes: directSource?.sizeBytes ?? null,
        id,
        ownerUserId: authenticatedUser(request).id,
        sourceObjectKey: sourceObjectKey(id),
        sourceType: parsed.data.source.sourceType,
        title: parsed.data.title,
        workflowKey: parsed.data.workflowKey,
      });

      response.status(201).json({
        inspection: inspectionResponse({ inspection, job: null }),
        upload: null,
      });
    } catch {
      sendSafeError(response, 503, {
        code: "provider_unavailable",
        category: "retryable",
        message: "Inspection creation is temporarily unavailable.",
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
          const dispatched = await dependencies.taskDispatcher.dispatch({
            dispatchGeneration: job.dispatchGeneration,
            jobId: job.id,
          });
          const marked = await dependencies.repository.markOwnedJobDispatched(
            ownerUserId,
            path.data.id,
            job.id,
            job.dispatchGeneration,
            dispatched.taskName,
            now(),
          );
          if (!marked?.job) {
            throw new Error("Dispatched job could not be recorded");
          }
          completion = marked;
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
