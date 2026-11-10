import { createHealthResponse } from "@factorylens/contracts";
import express from "express";

import { type AuthDependencies, registerAuthRoutes } from "./auth.js";
import type { InspectionApiRepository } from "./db/inspection-repository.js";
import { registerInspectionRoutes } from "./inspections.js";
import type { ObjectStorage } from "./storage.js";
import type { TaskDispatcher } from "./task-dispatcher.js";

export interface AppDependencies extends AuthDependencies {
  inspections?: InspectionApiRepository;
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
      if (!dependencies.storage || !dependencies.taskDispatcher) {
        throw new Error(
          "Inspection routes require storage and task dispatcher dependencies",
        );
      }
      registerInspectionRoutes(app, {
        appOrigin: dependencies.appOrigin,
        now: dependencies.now,
        repository: dependencies.inspections,
        storage: dependencies.storage,
        taskDispatcher: dependencies.taskDispatcher,
      });
    }
  }

  return app;
}

export const app = createApp();
