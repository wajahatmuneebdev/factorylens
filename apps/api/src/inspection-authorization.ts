import {
  InspectionPathParamsSchema,
  type SafeError,
} from "@factorylens/contracts";
import type { Request, RequestHandler, Response } from "express";

import type {
  InspectionRecord,
  OwnerScopedInspectionRepository,
} from "./db/inspection-repository.js";
import { authenticatedUser } from "./session.js";

const ownedInspectionKey = Symbol("ownedInspection");
type InspectionRequest = Request & {
  [ownedInspectionKey]?: InspectionRecord;
};

function sendSafeError(
  response: Response,
  status: number,
  error: SafeError,
): void {
  response.status(status).json({ error });
}

export function requireInspectionOwner(
  repository: Pick<OwnerScopedInspectionRepository, "findOwnedById">,
): RequestHandler {
  return async (request, response, next) => {
    const path = InspectionPathParamsSchema.safeParse(request.params);
    if (!path.success) {
      sendSafeError(response, 400, {
        code: "invalid_request",
        category: "terminal",
        message: "The inspection identifier is invalid.",
      });
      return;
    }

    try {
      const inspection = await repository.findOwnedById(
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

      (request as InspectionRequest)[ownedInspectionKey] = inspection;
    } catch {
      sendSafeError(response, 503, {
        code: "provider_unavailable",
        category: "retryable",
        message: "Inspection access is temporarily unavailable.",
      });
      return;
    }

    next();
  };
}

export function ownedInspection(request: Request): InspectionRecord {
  const inspection = (request as InspectionRequest)[ownedInspectionKey];
  if (!inspection) {
    throw new Error("Inspection authorization middleware was not applied");
  }
  return inspection;
}
