import { z } from "zod";

export const ErrorCategorySchema = z.enum([
  "terminal",
  "retryable",
  "cancelled",
  "authorization",
]);

export type ErrorCategory = z.infer<typeof ErrorCategorySchema>;

export const ERROR_DEFINITIONS = {
  invalid_request: "terminal",
  inspection_not_found: "terminal",
  inspection_state_conflict: "terminal",
  invalid_media: "terminal",
  unsupported_media: "terminal",
  media_limit_exceeded: "terminal",
  provider_response_invalid: "terminal",
  processing_attempts_exhausted: "terminal",
  storage_unavailable: "retryable",
  provider_unavailable: "retryable",
  lease_conflict: "retryable",
  inspection_cancelled: "cancelled",
  authentication_required: "authorization",
  access_denied: "authorization",
} as const satisfies Record<string, ErrorCategory>;

export const ErrorCodeSchema = z.enum(
  Object.keys(ERROR_DEFINITIONS) as [
    keyof typeof ERROR_DEFINITIONS,
    ...(keyof typeof ERROR_DEFINITIONS)[],
  ],
);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const SafeErrorSchema = z
  .object({
    code: ErrorCodeSchema,
    category: ErrorCategorySchema,
    message: z.string().min(1).max(240),
    requestId: z.string().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((error, context) => {
    if (ERROR_DEFINITIONS[error.code] !== error.category) {
      context.addIssue({
        code: "custom",
        message: `Error code ${error.code} must use category ${ERROR_DEFINITIONS[error.code]}`,
        path: ["category"],
      });
    }
  });

export type SafeError = z.infer<typeof SafeErrorSchema>;

export const ErrorResponseSchema = z
  .object({ error: SafeErrorSchema })
  .strict();

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
