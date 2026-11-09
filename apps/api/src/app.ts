import { createHealthResponse } from "@factorylens/contracts";
import express from "express";

import { type AuthDependencies, registerAuthRoutes } from "./auth.js";
import type { InspectionApiRepository } from "./db/inspection-repository.js";
import { registerInspectionRoutes } from "./inspections.js";

export interface AppDependencies extends AuthDependencies {
  inspections?: InspectionApiRepository;
}

export function createApp(dependencies?: AppDependencies): express.Express {
  const app = express();

  app.get("/health", (_request, response) => {
    response.json(createHealthResponse("api"));
  });

  if (dependencies) {
    registerAuthRoutes(app, dependencies);
    if (dependencies.inspections) {
      registerInspectionRoutes(app, {
        appOrigin: dependencies.appOrigin,
        repository: dependencies.inspections,
      });
    }
  }

  return app;
}

export const app = createApp();
