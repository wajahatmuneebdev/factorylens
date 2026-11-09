import { createHealthResponse } from "@factorylens/contracts";
import express from "express";

import { type AuthDependencies, registerAuthRoutes } from "./auth.js";

export function createApp(auth?: AuthDependencies): express.Express {
  const app = express();

  app.get("/health", (_request, response) => {
    response.json(createHealthResponse("api"));
  });

  if (auth) {
    registerAuthRoutes(app, auth);
  }

  return app;
}

export const app = createApp();
