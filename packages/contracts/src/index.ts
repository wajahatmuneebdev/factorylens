export * from "./api.js";
export * from "./errors.js";
export * from "./lifecycle.js";
export * from "./prediction.js";
export * from "./task.js";

export const CONTRACT_VERSION = 1 as const;

export type TypeScriptService = "api" | "web";

export interface HealthResponse {
  service: TypeScriptService;
  status: "ok";
}

export function createHealthResponse(
  service: TypeScriptService,
): HealthResponse {
  return { service, status: "ok" };
}
