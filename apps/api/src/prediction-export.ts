import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

import {
  PREDICTION_CSV_COLUMNS,
  PredictionArtifactV1Schema,
  type PredictionArtifactV1,
} from "@factorylens/contracts";

import type { ObjectStorage } from "./storage.js";

export const MAX_DECOMPRESSED_PREDICTION_BYTES = 32 * 1024 * 1024;

export class InvalidPredictionArtifactError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidPredictionArtifactError";
  }
}

export async function readPredictionArtifact(
  storage: ObjectStorage,
  key: string,
  expectedInspectionId: string,
): Promise<PredictionArtifactV1> {
  const source = await storage.read(key);
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    await pipeline(source, createGunzip(), async (decompressed) => {
      for await (const chunk of decompressed) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.byteLength;
        if (totalBytes > MAX_DECOMPRESSED_PREDICTION_BYTES) {
          throw new InvalidPredictionArtifactError(
            "Prediction artifact exceeds the supported export size",
          );
        }
        chunks.push(buffer);
      }
    });
  } catch (error) {
    if (error instanceof InvalidPredictionArtifactError) {
      throw error;
    }
    throw new InvalidPredictionArtifactError(
      "Prediction artifact could not be decompressed",
      { cause: error },
    );
  }

  let untrustedArtifact: unknown;
  try {
    untrustedArtifact = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new InvalidPredictionArtifactError(
      "Prediction artifact is not valid JSON",
      { cause: error },
    );
  }

  const parsed = PredictionArtifactV1Schema.safeParse(untrustedArtifact);
  if (!parsed.success || parsed.data.inspectionId !== expectedInspectionId) {
    throw new InvalidPredictionArtifactError(
      "Prediction artifact does not match the committed contract",
    );
  }
  return parsed.data;
}

function csvText(value: string): string {
  const spreadsheetSafeValue = /^[=+@-]/.test(value) ? `'${value}` : value;
  return `"${spreadsheetSafeValue.replaceAll('"', '""')}"`;
}

export function* predictionCsvRows(
  artifact: PredictionArtifactV1,
): Generator<string> {
  yield `${PREDICTION_CSV_COLUMNS.join(",")}\r\n`;
  for (const frame of artifact.frames) {
    for (const prediction of frame.predictions) {
      yield [
        csvText(artifact.inspectionId),
        frame.timestampMs,
        csvText(prediction.id),
        csvText(prediction.className),
        prediction.confidence,
        prediction.box.x,
        prediction.box.y,
        prediction.box.width,
        prediction.box.height,
      ].join(",") + "\r\n";
    }
  }
}
