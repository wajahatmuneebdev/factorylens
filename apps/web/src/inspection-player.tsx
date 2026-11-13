import {
  ErrorResponseSchema,
  GetArtifactsResponseSchema,
  PredictionArtifactV1Schema,
  type PredictionArtifactV1,
} from "@factorylens/contracts";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { PageState } from "./components/PageState";

const CLASS_COLORS = {
  Hardhat: "#65d6ad",
  "NO-Hardhat": "#ff7a81",
  Person: "#d7ff65",
} as const;
const MAX_PREDICTION_BYTES = 32 * 1024 * 1024;

type PredictionFrame = PredictionArtifactV1["frames"][number];

class PlayerRequestError extends Error {}

export interface CoordinateTransform {
  canvasHeight: number;
  canvasWidth: number;
  offsetX: number;
  offsetY: number;
  scale: number;
}

export function selectPredictionFrame(
  frames: PredictionArtifactV1["frames"],
  timestampMs: number,
): PredictionFrame | null {
  if (frames.length === 0) return null;

  let lower = 0;
  let upper = frames.length - 1;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const frame = frames[middle]!;
    if (frame.timestampMs === timestampMs) return frame;
    if (frame.timestampMs < timestampMs) lower = middle + 1;
    else upper = middle - 1;
  }

  if (upper < 0) return frames[0]!;
  if (lower >= frames.length) return frames.at(-1)!;
  const before = frames[upper]!;
  const after = frames[lower]!;
  return timestampMs - before.timestampMs <= after.timestampMs - timestampMs
    ? before
    : after;
}

export function calculateCoordinateTransform(
  sourceWidth: number,
  sourceHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  devicePixelRatio: number,
): CoordinateTransform {
  const scale = Math.min(
    viewportWidth / sourceWidth,
    viewportHeight / sourceHeight,
  );
  return {
    canvasHeight: Math.round(viewportHeight * devicePixelRatio),
    canvasWidth: Math.round(viewportWidth * devicePixelRatio),
    offsetX: (viewportWidth - sourceWidth * scale) / 2,
    offsetY: (viewportHeight - sourceHeight * scale) / 2,
    scale,
  };
}

async function responseMessage(response: Response, fallback: string) {
  const body = ErrorResponseSchema.safeParse(
    await response.json().catch(() => null),
  );
  return body.success ? body.data.error.message : fallback;
}

async function readBoundedBytes(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_PREDICTION_BYTES) {
        throw new PlayerRequestError(
          "The prediction artifact exceeds the supported size.",
        );
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function decodePredictionResponse(response: Response): Promise<unknown> {
  if (!response.body) {
    throw new PlayerRequestError("The prediction artifact could not be read.");
  }
  const bytes = await readBoundedBytes(response.body);
  const isGzip = bytes[0] === 0x1f && bytes[1] === 0x8b;
  let decoded = bytes;

  if (isGzip) {
    if (typeof DecompressionStream === "undefined") {
      throw new PlayerRequestError(
        "This browser cannot open compressed inspection results.",
      );
    }
    const compressedStream = new Response(new Uint8Array(bytes)).body;
    if (!compressedStream) {
      throw new PlayerRequestError(
        "The compressed inspection result could not be read.",
      );
    }
    try {
      const stream = compressedStream.pipeThrough(
        new DecompressionStream("gzip"),
      );
      decoded = await readBoundedBytes(stream);
    } catch (error) {
      if (error instanceof PlayerRequestError) throw error;
      throw new PlayerRequestError(
        "The prediction artifact could not be decompressed.",
      );
    }
  }

  try {
    return JSON.parse(new TextDecoder().decode(decoded));
  } catch {
    throw new PlayerRequestError("The prediction artifact is not valid JSON.");
  }
}

export async function loadInspectionPlayback(inspectionId: string) {
  const authorizationResponse = await fetch(
    `/api/inspections/${inspectionId}/artifacts`,
  );
  if (!authorizationResponse.ok) {
    throw new PlayerRequestError(
      await responseMessage(
        authorizationResponse,
        "Inspection playback is temporarily unavailable.",
      ),
    );
  }

  const authorization = GetArtifactsResponseSchema.safeParse(
    await authorizationResponse.json().catch(() => null),
  );
  if (!authorization.success) {
    throw new PlayerRequestError(
      "Inspection playback authorization is invalid.",
    );
  }

  const predictionResponse = await fetch(authorization.data.predictions.url);
  if (!predictionResponse.ok) {
    throw new PlayerRequestError(
      "The prediction artifact could not be downloaded.",
    );
  }
  const document = await decodePredictionResponse(predictionResponse);
  if (
    !document ||
    typeof document !== "object" ||
    !("schemaVersion" in document) ||
    document.schemaVersion !== authorization.data.predictionSchemaVersion
  ) {
    throw new PlayerRequestError(
      "This inspection uses an unsupported prediction format.",
    );
  }

  const artifact = PredictionArtifactV1Schema.safeParse(document);
  if (!artifact.success || artifact.data.inspectionId !== inspectionId) {
    throw new PlayerRequestError(
      "The prediction artifact does not match this inspection.",
    );
  }

  return {
    artifact: artifact.data,
    videoUrl: authorization.data.video.url,
  };
}

type VideoWithFrameCallback = HTMLVideoElement & {
  cancelVideoFrameCallback?: (handle: number) => void;
  requestVideoFrameCallback?: (
    callback: (
      now: DOMHighResTimeStamp,
      metadata: { mediaTime: number },
    ) => void,
  ) => number;
};

/**
 * Uses decoded-frame presentation timestamps when the browser exposes them.
 * The fallback samples currentTime on animation frames during playback and
 * also redraws on every media state event so pause, seek, and ended states are
 * correct even when requestAnimationFrame is throttled.
 */
export function synchronizeVideo(
  video: VideoWithFrameCallback,
  onTimestamp: (timestampMs: number) => void,
): () => void {
  let animationHandle: number | null = null;
  let videoFrameHandle: number | null = null;

  const updateFromElement = () => onTimestamp(video.currentTime * 1000);
  const schedule = () => {
    if (video.paused || video.ended) return;
    if (video.requestVideoFrameCallback) {
      if (videoFrameHandle !== null) return;
      videoFrameHandle = video.requestVideoFrameCallback((_now, metadata) => {
        videoFrameHandle = null;
        onTimestamp(metadata.mediaTime * 1000);
        schedule();
      });
      return;
    }
    if (animationHandle !== null) return;
    animationHandle = requestAnimationFrame(() => {
      animationHandle = null;
      updateFromElement();
      schedule();
    });
  };
  const updateAndSchedule = () => {
    updateFromElement();
    schedule();
  };
  const events: Array<keyof HTMLMediaElementEventMap> = [
    "loadedmetadata",
    "play",
    "pause",
    "seeking",
    "seeked",
    "timeupdate",
    "ended",
  ];
  events.forEach((event) => video.addEventListener(event, updateAndSchedule));
  updateFromElement();

  return () => {
    events.forEach((event) =>
      video.removeEventListener(event, updateAndSchedule),
    );
    if (animationHandle !== null) cancelAnimationFrame(animationHandle);
    if (videoFrameHandle !== null) {
      video.cancelVideoFrameCallback?.(videoFrameHandle);
    }
  };
}

function drawOverlay(
  canvas: HTMLCanvasElement,
  artifact: PredictionArtifactV1,
  frame: PredictionFrame | null,
) {
  const bounds = canvas.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0) return;
  const ratio = window.devicePixelRatio || 1;
  const transform = calculateCoordinateTransform(
    artifact.source.width,
    artifact.source.height,
    bounds.width,
    bounds.height,
    ratio,
  );
  if (
    canvas.width !== transform.canvasWidth ||
    canvas.height !== transform.canvasHeight
  ) {
    canvas.width = transform.canvasWidth;
    canvas.height = transform.canvasHeight;
  }

  const context = canvas.getContext("2d");
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, bounds.width, bounds.height);
  if (!frame) return;

  context.font = "600 12px Aptos, Segoe UI, sans-serif";
  context.textBaseline = "top";
  for (const prediction of frame.predictions) {
    const color = CLASS_COLORS[prediction.className];
    const x =
      transform.offsetX +
      (prediction.box.x - prediction.box.width / 2) * transform.scale;
    const y =
      transform.offsetY +
      (prediction.box.y - prediction.box.height / 2) * transform.scale;
    const width = prediction.box.width * transform.scale;
    const height = prediction.box.height * transform.scale;
    const label = `${prediction.className} ${Math.round(prediction.confidence * 100)}%`;
    const labelWidth = context.measureText(label).width + 12;
    const labelY = Math.max(transform.offsetY, y - 22);

    context.lineWidth = 2;
    context.strokeStyle = color;
    context.strokeRect(x, y, width, height);
    context.fillStyle = color;
    context.fillRect(x, labelY, labelWidth, 20);
    context.fillStyle = "#101a17";
    context.fillText(label, x + 6, labelY + 3);
  }
}

function PredictionVideo({
  artifact,
  videoUrl,
}: {
  artifact: PredictionArtifactV1;
  videoUrl: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [frame, setFrame] = useState<PredictionFrame | null>(() =>
    selectPredictionFrame(artifact.frames, 0),
  );
  const frameRef = useRef(frame);

  const renderTimestamp = useCallback(
    (timestampMs: number) => {
      const selected = selectPredictionFrame(artifact.frames, timestampMs);
      frameRef.current = selected;
      setFrame(selected);
      if (canvasRef.current) drawOverlay(canvasRef.current, artifact, selected);
    },
    [artifact],
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    return synchronizeVideo(video, renderTimestamp);
  }, [renderTimestamp]);

  useEffect(() => {
    const stage = stageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas) return;
    const redraw = () => drawOverlay(canvas, artifact, frameRef.current);
    redraw();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", redraw);
      return () => window.removeEventListener("resize", redraw);
    }
    const observer = new ResizeObserver(redraw);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [artifact]);

  return (
    <section aria-labelledby="playback-title" className="inspection-player">
      <div
        className="inspection-player__stage"
        ref={stageRef}
        style={{
          aspectRatio: `${artifact.source.width} / ${artifact.source.height}`,
        }}
      >
        <video controls playsInline ref={videoRef} src={videoUrl}>
          Your browser does not support HTML video playback.
        </video>
        <canvas aria-hidden="true" ref={canvasRef} />
      </div>
      <div className="inspection-player__caption">
        <div>
          <p className="eyebrow">Synchronized playback</p>
          <strong id="playback-title">
            {frame
              ? `${frame.predictions.length} prediction${frame.predictions.length === 1 ? "" : "s"} at ${(frame.timestampMs / 1000).toFixed(1)}s`
              : "No sampled predictions"}
          </strong>
        </div>
        <span>
          {artifact.source.width} × {artifact.source.height}
        </span>
      </div>
    </section>
  );
}

export function InspectionPlayer({ inspectionId }: { inspectionId: string }) {
  const playback = useQuery({
    queryKey: ["inspection-playback", inspectionId],
    queryFn: () => loadInspectionPlayback(inspectionId),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  if (playback.isPending) {
    return <PageState kind="loading" title="Loading inspection playback" />;
  }
  if (playback.isError) {
    return (
      <PageState
        actionLabel="Try again"
        kind="error"
        onAction={() => void playback.refetch()}
        title="Inspection playback is unavailable"
      >
        {playback.error.message}
      </PageState>
    );
  }
  return <PredictionVideo {...playback.data} />;
}
