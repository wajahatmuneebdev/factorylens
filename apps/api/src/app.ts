import { createHealthResponse } from "@factorylens/contracts";
import express from "express";

import { type AuthDependencies, registerAuthRoutes } from "./auth.js";
import type { InspectionApiRepository } from "./db/inspection-repository.js";
import { registerInspectionRoutes } from "./inspections.js";
import type { ObjectAccessAuthorizer, ObjectStorage } from "./storage.js";
import type { TaskDispatcher } from "./task-dispatcher.js";

export interface AppDependencies extends AuthDependencies {
  inspections?: InspectionApiRepository;
  objectAccess?: ObjectAccessAuthorizer;
  storage?: ObjectStorage;
  taskDispatcher?: TaskDispatcher;
}

export function createApp(dependencies?: AppDependencies): express.Express {
  const app = express();

  app.get("/health", (_request, response) => {
    response.json(createHealthResponse("api"));
  });

  if (dependencies) {
    registerAuthRoutes(app, dependencies);
    if (dependencies.inspections) {
      if (
        !dependencies.objectAccess ||
        !dependencies.storage ||
        !dependencies.taskDispatcher
      ) {
        throw new Error(
          "Inspection routes require storage, object access, and task dispatcher dependencies",
        );
      }
      registerInspectionRoutes(app, {
        appOrigin: dependencies.appOrigin,
        now: dependencies.now,
        objectAccess: dependencies.objectAccess,
        repository: dependencies.inspections,
        storage: dependencies.storage,
        taskDispatcher: dependencies.taskDispatcher,
      });
    }
  }

  return app;
}

export const app = createApp();
