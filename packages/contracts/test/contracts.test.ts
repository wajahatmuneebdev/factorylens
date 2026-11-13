import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  AuthRedirectResponseSchema,
  BrowserApiSchemas,
  CreateInspectionRequestSchema,
  ERROR_DEFINITIONS,
  ErrorCategorySchema,
  GoogleAuthRequestSchema,
  JOB_TRANSITIONS,
  PREDICTION_CSV_COLUMNS,
  ProcessTaskMessageSchema,
  PredictionArtifactV1Schema,
  SafeErrorSchema,
  UploadCompleteResponseSchema,
  canTransitionInspection,
  canTransitionJob,
} from "../src/index";

const fixturesUrl = new URL("../../../fixtures/contracts/", import.meta.url);
const predictionFixturesUrl = new URL(
  "../../../fixtures/predictions/",
  import.meta.url,
);

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, fixturesUrl), "utf8"));
}

function readPredictionFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, predictionFixturesUrl), "utf8"));
}

describe("browser API contracts", () => {
  it("defines request and response schemas for the initial browser surface", () => {
    expect(Object.keys(BrowserApiSchemas)).toEqual([
      "GET /auth/google",
      "GET /auth/google/callback",
      "POST /auth/logout",
      "GET /api/me",
      "POST /api/inspections",
      "POST /api/inspections/:id/upload-complete",
      "GET /api/inspections",
      "GET /api/inspections/:id",
      "POST /api/inspections/:id/cancel",
      "POST /api/inspections/:id/retry",
      "GET /api/inspections/:id/artifacts",
      "GET /api/inspections/:id/export.csv",
    ]);

    for (const contract of Object.values(BrowserApiSchemas)) {
      expect(contract.request).toBeDefined();
      expect(contract.response).toBeDefined();
    }
  });

  it("defines stable per-prediction CSV columns", () => {
    expect(PREDICTION_CSV_COLUMNS).toEqual([
      "inspection_id",
      "timestamp_ms",
      "prediction_id",
      "class_name",
      "confidence",
      "box_x",
      "box_y",
      "box_width",
      "box_height",
    ]);
  });

  it("accepts direct uploads and the one prepared sample", () => {
    expect(
      CreateInspectionRequestSchema.parse({
        title: "Shift 2 review",
        workflowKey: "factory-safety-v1",
        source: {
          sourceType: "upload",
          fileName: "line.webm",
          contentType: "video/webm",
          sizeBytes: 4096,
        },
      }),
    ).toBeDefined();
    expect(
      CreateInspectionRequestSchema.parse({
        title: "Prepared sample",
        workflowKey: "factory-safety-v1",
        source: {
          sourceType: "sample",
          sampleKey: "assembly-line-no-hard-hat",
        },
      }),
    ).toBeDefined();
  });

  it("rejects unknown Workflows and invalid declared media metadata", () => {
    const request = {
      title: "Shift 2 review",
      workflowKey: "unknown-workflow",
      source: {
        sourceType: "upload",
        fileName: "line.webm",
        contentType: "video/webm",
        sizeBytes: 4096,
      },
    };

    expect(CreateInspectionRequestSchema.safeParse(request).success).toBe(
      false,
    );
    expect(
      CreateInspectionRequestSchema.safeParse({
        ...request,
        workflowKey: "factory-safety-v1",
        source: { ...request.source, contentType: "text/plain" },
      }).success,
    ).toBe(false);
    expect(
      CreateInspectionRequestSchema.safeParse({
        ...request,
        workflowKey: "factory-safety-v1",
        source: { ...request.source, sizeBytes: 250 * 1024 * 1024 + 1 },
      }).success,
    ).toBe(false);
  });

  it("returns the durable job identity from upload completion", () => {
    const timestamp = "2026-11-09T08:00:00.000Z";
    const response = UploadCompleteResponseSchema.parse({
      inspection: {
        id: "323e4567-e89b-42d3-a456-426614174000",
        title: "Assembly line review",
        status: "queued",
        sourceType: "upload",
        workflowKey: "factory-safety-v1",
        progress: { stage: null, percent: 0 },
        summary: null,
        error: null,
        createdAt: timestamp,
        queuedAt: timestamp,
        startedAt: null,
        completedAt: null,
        updatedAt: timestamp,
      },
      job: {
        id: "523e4567-e89b-42d3-a456-426614174000",
        status: "queued",
      },
    });

    expect(response.job).toEqual({
      id: "523e4567-e89b-42d3-a456-426614174000",
      status: "queued",
    });
  });

  it("rejects redirect targets that browsers can normalize off-origin", () => {
    expect(
      GoogleAuthRequestSchema.safeParse({ returnTo: "/history" }).success,
    ).toBe(true);
    expect(
      GoogleAuthRequestSchema.safeParse({ returnTo: "/\\evil.example" })
        .success,
    ).toBe(false);
    expect(
      AuthRedirectResponseSchema.safeParse({ location: "/" }).success,
    ).toBe(true);
    expect(
      AuthRedirectResponseSchema.safeParse({ location: "javascript:alert(1)" })
        .success,
    ).toBe(false);
  });
});

describe("lifecycle contracts", () => {
  it("allows only explicit inspection and job transitions", () => {
    expect(canTransitionInspection("awaiting_upload", "queued")).toBe(true);
    expect(canTransitionInspection("failed", "queued")).toBe(true);
    expect(canTransitionInspection("completed", "processing")).toBe(false);
    expect(canTransitionJob("running", "retry_wait")).toBe(true);
    expect(canTransitionJob("retry_wait", "cancelled")).toBe(true);
    expect(canTransitionJob("completed", "running")).toBe(false);
    expect(JOB_TRANSITIONS.completed).toEqual([]);
  });
});

describe("safe errors", () => {
  it("assigns every stable error code to a supported category", () => {
    for (const category of Object.values(ERROR_DEFINITIONS)) {
      expect(ErrorCategorySchema.parse(category)).toBe(category);
    }
  });

  it("rejects a code paired with the wrong category", () => {
    expect(
      SafeErrorSchema.safeParse({
        code: "access_denied",
        category: "terminal",
        message: "You cannot view this inspection.",
      }).success,
    ).toBe(false);
  });
});

describe("worker-facing fixtures", () => {
  it("validates the task message and permits only its two fields", () => {
    const fixture = ProcessTaskMessageSchema.parse(
      readFixture("process-task-message.json"),
    );

    expect(fixture.dispatchGeneration).toBe(2);
    expect(
      ProcessTaskMessageSchema.safeParse({
        ...fixture,
        inspectionId: fixture.jobId,
      }).success,
    ).toBe(false);
  });

  it("validates prediction artifact schema version 1", () => {
    const fixture = PredictionArtifactV1Schema.parse(
      readFixture("prediction-artifact-v1.json"),
    );

    expect(fixture.schemaVersion).toBe(1);
    expect(fixture.source).toMatchObject({
      durationMs: 1000,
      timeBase: "milliseconds",
      sampleRateFps: 5,
    });
  });

  it("validates the deterministic assembly-line prediction fixture", () => {
    const fixture = PredictionArtifactV1Schema.parse(
      readPredictionFixture("assembly-line-no-hard-hat.expected.json"),
    );

    expect(fixture.frames).toHaveLength(10);
    expect(fixture.events).toMatchObject([
      { type: "missing_hard_hat", startMs: 0, endMs: 2000 },
    ]);
    expect(fixture.summary.missingHardHatEventCount).toBe(1);
  });

  it("rejects non-monotonic frame timestamps", () => {
    const fixture = readFixture("prediction-artifact-v1.json") as {
      frames: { timestampMs: number }[];
    };
    fixture.frames[1]!.timestampMs = 0;

    expect(PredictionArtifactV1Schema.safeParse(fixture).success).toBe(false);
  });

  it("allows qualifying frames that do not confirm an event", () => {
    const fixture = readFixture("prediction-artifact-v1.json") as {
      frames: { predictions: unknown[] }[];
      events: unknown[];
      summary: {
        missingHardHatEventCount: number;
        qualifyingFrameCount: number;
        peakConfidence: number | null;
      };
    };
    fixture.frames[2]!.predictions = [];
    fixture.events = [];
    fixture.summary = {
      missingHardHatEventCount: 0,
      qualifyingFrameCount: 2,
      peakConfidence: 0.93,
    };

    expect(PredictionArtifactV1Schema.safeParse(fixture).success).toBe(true);
  });
});
