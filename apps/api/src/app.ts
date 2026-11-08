import { createHealthResponse } from "@factorylens/contracts";
import express from "express";

export const app = express();

app.get("/health", (_request, response) => {
  response.json(createHealthResponse("api"));
});
