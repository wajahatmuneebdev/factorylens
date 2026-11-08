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
