import { z } from "zod";

import { SafeErrorSchema } from "./errors.js";
import { InspectionStateSchema, JobStateSchema } from "./lifecycle.js";

const timestamp = z.iso.datetime({ offset: true });
const emptyRequest = z.object({}).strict();

const returnTo = z
  .string()
  .startsWith("/")
  .max(512)
  .refine(
    (value) => !value.startsWith("//") && !value.includes("\\"),
    "returnTo must be a same-origin path",
  );
const httpsUrl = z.string().startsWith("https://").pipe(z.url());

export const GoogleAuthRequestSchema = z
  .object({ returnTo: returnTo.optional() })
  .strict();
const callbackMetadata = {
  iss: z.string().min(1).optional(),
  scope: z.string().min(1).optional(),
  authuser: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  hd: z.string().min(1).optional(),
};

export const GoogleAuthCallbackRequestSchema = z.union([
  z
    .object({
      code: z.string().min(1),
      state: z.string().min(1),
      ...callbackMetadata,
    })
    .strict(),
  z
    .object({
      error: z.string().min(1),
      error_description: z.string().min(1).optional(),
      error_uri: z.url().optional(),
      state: z.string().min(1),
      ...callbackMetadata,
    })
    .strict(),
]);
export const AuthRedirectResponseSchema = z
  .object({ location: z.union([returnTo, httpsUrl]) })
  .strict();

export const SourceTypeSchema = z.enum(["upload", "recording", "sample"]);

export const UserSchema = z
  .object({
    id: z.uuid(),
    email: z.email(),
    displayName: z.string().min(1).max(120),
    avatarUrl: z.url().nullable(),
  })
  .strict();

export const InspectionSummarySchema = z
  .object({
    missingHardHatEventCount: z.number().int().nonnegative(),
    qualifyingFrameCount: z.number().int().nonnegative(),
    peakConfidence: z.number().finite().min(0).max(1).nullable(),
  })
  .strict();

export const InspectionSchema = z
  .object({
    id: z.uuid(),
    title: z.string().min(1).max(160),
    status: InspectionStateSchema,
    sourceType: SourceTypeSchema,
    workflowKey: z.literal("factory-safety-v1"),
    progress: z
      .object({
        stage: z.string().min(1).max(64).nullable(),
        percent: z.number().int().min(0).max(100),
      })
      .strict(),
    summary: InspectionSummarySchema.nullable(),
    error: SafeErrorSchema.nullable(),
    createdAt: timestamp,
    queuedAt: timestamp.nullable(),
    startedAt: timestamp.nullable(),
    completedAt: timestamp.nullable(),
    updatedAt: timestamp,
  })
  .strict();

export const LogoutRequestSchema = emptyRequest;
export const LogoutResponseSchema = z
  .object({ signedOut: z.literal(true) })
  .strict();

export const MeRequestSchema = emptyRequest;
export const MeResponseSchema = z.object({ user: UserSchema }).strict();

const directUploadSource = z
  .object({
    sourceType: z.enum(["upload", "recording"]),
    fileName: z.string().trim().min(1).max(255),
    contentType: z.string().trim().startsWith("video/").max(120),
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(250 * 1024 * 1024),
  })
  .strict();

const sampleSource = z
  .object({
    sourceType: z.literal("sample"),
    sampleKey: z.literal("assembly-line-no-hard-hat"),
  })
  .strict();

export const CreateInspectionRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    workflowKey: z.literal("factory-safety-v1"),
    source: z.union([directUploadSource, sampleSource]),
  })
  .strict();

export const UploadAuthorizationSchema = z
  .object({
    method: z.literal("PUT"),
    url: z.url(),
    headers: z.record(z.string(), z.string()),
    expiresAt: timestamp,
  })
  .strict();
export type UploadAuthorization = z.infer<typeof UploadAuthorizationSchema>;

export const CreateInspectionResponseSchema = z
  .object({
    inspection: InspectionSchema,
    upload: UploadAuthorizationSchema.nullable(),
  })
  .strict();

export const InspectionPathParamsSchema = z.object({ id: z.uuid() }).strict();

export const UploadCompleteRequestSchema = z
  .object({ etag: z.string().min(1).max(128).optional() })
  .strict();
export const UploadCompleteResponseSchema = z
  .object({
    inspection: InspectionSchema,
    job: z
      .object({
        id: z.uuid(),
        status: JobStateSchema,
      })
      .strict(),
  })
  .strict();

export const ListInspectionsQuerySchema = z
  .object({
    cursor: z.string().min(1).max(256).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    status: InspectionStateSchema.optional(),
  })
  .strict();
export const ListInspectionsResponseSchema = z
  .object({
    inspections: z.array(InspectionSchema),
    nextCursor: z.string().min(1).max(256).nullable(),
  })
  .strict();

export const GetInspectionRequestSchema = InspectionPathParamsSchema;
export const GetInspectionResponseSchema = z
  .object({ inspection: InspectionSchema })
  .strict();

export const CancelInspectionRequestSchema = emptyRequest;
export const CancelInspectionResponseSchema = GetInspectionResponseSchema;
export const RetryInspectionRequestSchema = emptyRequest;
export const RetryInspectionResponseSchema = GetInspectionResponseSchema;

const ArtifactAuthorizationSchema = z
  .object({
    url: z.url(),
    expiresAt: timestamp,
  })
  .strict();

export const GetArtifactsRequestSchema = InspectionPathParamsSchema;
export const GetArtifactsResponseSchema = z
  .object({
    video: ArtifactAuthorizationSchema,
    predictions: ArtifactAuthorizationSchema,
    predictionSchemaVersion: z.literal(1),
  })
  .strict();

export const ExportCsvRequestSchema = InspectionPathParamsSchema;
export const ExportCsvResponseSchema = z.string();

export const BrowserApiSchemas = {
  "GET /auth/google": {
    request: GoogleAuthRequestSchema,
    response: AuthRedirectResponseSchema,
  },
  "GET /auth/google/callback": {
    request: GoogleAuthCallbackRequestSchema,
    response: AuthRedirectResponseSchema,
  },
  "POST /auth/logout": {
    request: LogoutRequestSchema,
    response: LogoutResponseSchema,
  },
  "GET /api/me": { request: MeRequestSchema, response: MeResponseSchema },
  "POST /api/inspections": {
    request: CreateInspectionRequestSchema,
    response: CreateInspectionResponseSchema,
  },
  "POST /api/inspections/:id/upload-complete": {
    request: UploadCompleteRequestSchema,
    response: UploadCompleteResponseSchema,
  },
  "GET /api/inspections": {
    request: ListInspectionsQuerySchema,
    response: ListInspectionsResponseSchema,
  },
  "GET /api/inspections/:id": {
    request: GetInspectionRequestSchema,
    response: GetInspectionResponseSchema,
  },
  "POST /api/inspections/:id/cancel": {
    request: CancelInspectionRequestSchema,
    response: CancelInspectionResponseSchema,
  },
  "POST /api/inspections/:id/retry": {
    request: RetryInspectionRequestSchema,
    response: RetryInspectionResponseSchema,
  },
  "GET /api/inspections/:id/artifacts": {
    request: GetArtifactsRequestSchema,
    response: GetArtifactsResponseSchema,
  },
  "GET /api/inspections/:id/export.csv": {
    request: ExportCsvRequestSchema,
    response: ExportCsvResponseSchema,
  },
} as const;

export type User = z.infer<typeof UserSchema>;
export type Inspection = z.infer<typeof InspectionSchema>;
export type CreateInspectionRequest = z.infer<
  typeof CreateInspectionRequestSchema
>;
