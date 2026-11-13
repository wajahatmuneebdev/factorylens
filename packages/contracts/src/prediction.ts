import { z } from "zod";

const finiteNumber = z.number().finite();
const confidence = finiteNumber.min(0).max(1);

export const PREDICTION_CSV_COLUMNS = [
  "inspection_id",
  "timestamp_ms",
  "prediction_id",
  "class_name",
  "confidence",
  "box_x",
  "box_y",
  "box_width",
  "box_height",
] as const;

export const PredictionClassSchema = z.enum([
  "Person",
  "Hardhat",
  "NO-Hardhat",
]);

export const PredictionBoxSchema = z
  .object({
    x: finiteNumber.nonnegative(),
    y: finiteNumber.nonnegative(),
    width: finiteNumber.positive(),
    height: finiteNumber.positive(),
  })
  .strict();

export const FramePredictionSchema = z
  .object({
    id: z.string().min(1).max(128),
    className: PredictionClassSchema,
    confidence,
    box: PredictionBoxSchema,
  })
  .strict();

export const PredictionFrameSchema = z
  .object({
    timestampMs: z.number().int().nonnegative(),
    predictions: z.array(FramePredictionSchema),
  })
  .strict();

export const PredictionEventSchema = z
  .object({
    id: z.string().min(1).max(128),
    type: z.literal("missing_hard_hat"),
    label: z.literal("Missing hard hat"),
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().nonnegative(),
    peakConfidence: confidence,
    qualifyingFrameCount: z.number().int().positive(),
  })
  .strict()
  .refine((event) => event.startMs <= event.endMs, {
    message: "Event startMs must not be after endMs",
    path: ["endMs"],
  });

export const PredictionArtifactV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    inspectionId: z.uuid(),
    source: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        durationMs: z.number().int().positive(),
        timeBase: z.literal("milliseconds"),
        sampleRateFps: finiteNumber.positive(),
      })
      .strict(),
    workflow: z
      .object({
        key: z.literal("factory-safety-v1"),
        workflowId: z.literal("hard-hat-compliance-v1"),
        workflowVersion: z.literal("1"),
        modelId: z.literal("construction-site-safety/27"),
        fingerprint: z.string().regex(/^sha256:[0-9a-f]{64}$/),
      })
      .strict(),
    classes: z.tuple([
      z.literal("Person"),
      z.literal("Hardhat"),
      z.literal("NO-Hardhat"),
    ]),
    frames: z.array(PredictionFrameSchema),
    events: z.array(PredictionEventSchema),
    summary: z
      .object({
        missingHardHatEventCount: z.number().int().nonnegative(),
        qualifyingFrameCount: z.number().int().nonnegative(),
        peakConfidence: confidence.nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((artifact, context) => {
    const predictionIds = new Set<string>();
    let previousTimestamp = -1;

    artifact.frames.forEach((frame, frameIndex) => {
      if (frame.timestampMs <= previousTimestamp) {
        context.addIssue({
          code: "custom",
          message: "Frame timestamps must be strictly increasing",
          path: ["frames", frameIndex, "timestampMs"],
        });
      }
      if (frame.timestampMs > artifact.source.durationMs) {
        context.addIssue({
          code: "custom",
          message: "Frame timestamp exceeds source duration",
          path: ["frames", frameIndex, "timestampMs"],
        });
      }
      previousTimestamp = frame.timestampMs;

      frame.predictions.forEach((prediction, predictionIndex) => {
        if (predictionIds.has(prediction.id)) {
          context.addIssue({
            code: "custom",
            message: "Prediction IDs must be unique within the artifact",
            path: ["frames", frameIndex, "predictions", predictionIndex, "id"],
          });
        }
        predictionIds.add(prediction.id);

        const { box } = prediction;
        if (
          box.x - box.width / 2 < 0 ||
          box.x + box.width / 2 > artifact.source.width ||
          box.y - box.height / 2 < 0 ||
          box.y + box.height / 2 > artifact.source.height
        ) {
          context.addIssue({
            code: "custom",
            message: "Prediction box must be clipped to the source dimensions",
            path: ["frames", frameIndex, "predictions", predictionIndex, "box"],
          });
        }
      });
    });

    const eventIds = new Set<string>();
    artifact.events.forEach((event, eventIndex) => {
      if (eventIds.has(event.id)) {
        context.addIssue({
          code: "custom",
          message: "Event IDs must be unique within the artifact",
          path: ["events", eventIndex, "id"],
        });
      }
      eventIds.add(event.id);
      if (event.endMs > artifact.source.durationMs) {
        context.addIssue({
          code: "custom",
          message: "Event endMs exceeds source duration",
          path: ["events", eventIndex, "endMs"],
        });
      }
    });

    if (artifact.summary.missingHardHatEventCount !== artifact.events.length) {
      context.addIssue({
        code: "custom",
        message: "Summary event count must match the events array",
        path: ["summary", "missingHardHatEventCount"],
      });
    }

    const qualifyingPredictions = artifact.frames.flatMap((frame) =>
      frame.predictions.filter(
        (prediction) =>
          prediction.className === "NO-Hardhat" && prediction.confidence >= 0.6,
      ),
    );
    const qualifyingFrameCount = artifact.frames.filter((frame) =>
      frame.predictions.some(
        (prediction) =>
          prediction.className === "NO-Hardhat" && prediction.confidence >= 0.6,
      ),
    ).length;
    if (artifact.summary.qualifyingFrameCount !== qualifyingFrameCount) {
      context.addIssue({
        code: "custom",
        message: "Summary qualifying frame count must match the events",
        path: ["summary", "qualifyingFrameCount"],
      });
    }

    const peakConfidence = qualifyingPredictions.length
      ? Math.max(
          ...qualifyingPredictions.map((prediction) => prediction.confidence),
        )
      : null;
    if (artifact.summary.peakConfidence !== peakConfidence) {
      context.addIssue({
        code: "custom",
        message: "Summary peak confidence must match the event peak",
        path: ["summary", "peakConfidence"],
      });
    }
  });

export type PredictionArtifactV1 = z.infer<typeof PredictionArtifactV1Schema>;
