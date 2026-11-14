import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

import {
  PredictionArtifactV1Schema,
  type PredictionArtifactV1,
} from "@factorylens/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  calculateCoordinateTransform,
  loadInspectionPlayback,
  selectPredictionFrame,
  synchronizeVideo,
} from "./inspection-player";

const fixturePath = resolve(
  process.cwd(),
  "../../fixtures/contracts/prediction-artifact-v1.json",
);

function readFixture(): PredictionArtifactV1 {
  return PredictionArtifactV1Schema.parse(
    JSON.parse(readFileSync(fixturePath, "utf8")),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("prediction frame selection", () => {
  it("selects the nearest fixture timestamp and resolves ties to the earlier frame", () => {
    const fixture = readFixture();

    expect(selectPredictionFrame(fixture.frames, 112)?.timestampMs).toBe(200);
    expect(selectPredictionFrame(fixture.frames, 100)?.timestampMs).toBe(0);
    expect(selectPredictionFrame(fixture.frames, 10_000)?.timestampMs).toBe(
      800,
    );
  });

  it("handles artifacts with no sampled frames and frames with no predictions", () => {
    const fixture = readFixture();

    expect(selectPredictionFrame([], 200)).toBeNull();
    expect(
      selectPredictionFrame(fixture.frames, 650)?.predictions,
    ).toHaveLength(0);
  });
});

describe("Canvas coordinate transforms", () => {
  it("scales source pixels into a responsive letterboxed viewport and DPR backing store", () => {
    const fixture = readFixture();
    const transform = calculateCoordinateTransform(
      fixture.source.width,
      fixture.source.height,
      640,
      480,
      2,
    );
    const box = fixture.frames[0]!.predictions[0]!.box;

    expect(transform).toEqual({
      canvasHeight: 960,
      canvasWidth: 1280,
      offsetX: 0,
      offsetY: 60,
      scale: 0.5,
    });
    expect({
      height: box.height * transform.scale,
      width: box.width * transform.scale,
      x: transform.offsetX + (box.x - box.width / 2) * transform.scale,
      y: transform.offsetY + (box.y - box.height / 2) * transform.scale,
    }).toEqual({ height: 54, width: 46, x: 284, y: 152 });
  });
});

describe("authorized playback loading", () => {
  it("uses only authorized references and downloads the compressed fixture once", async () => {
    const fixture = readFixture();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            video: {
              expiresAt: "2026-11-13T09:00:00.000Z",
              url: "https://objects.example/video",
            },
            predictions: {
              expiresAt: "2026-11-13T09:00:00.000Z",
              url: "https://objects.example/predictions",
            },
            predictionSchemaVersion: 1,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(gzipSync(JSON.stringify(fixture)), { status: 200 }),
      );

    const playback = await loadInspectionPlayback(fixture.inspectionId);

    expect(playback.artifact).toEqual(fixture);
    expect(playback.videoUrl).toBe("https://objects.example/video");
    expect(fetchMock.mock.calls).toEqual([
      [`/api/inspections/${fixture.inspectionId}/artifacts`],
      ["https://objects.example/predictions"],
    ]);
  });

  it("rejects an unsupported artifact schema", async () => {
    const fixture = { ...readFixture(), schemaVersion: 2 };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            video: {
              expiresAt: "2026-11-13T09:00:00.000Z",
              url: "https://objects.example/video",
            },
            predictions: {
              expiresAt: "2026-11-13T09:00:00.000Z",
              url: "https://objects.example/predictions",
            },
            predictionSchemaVersion: 1,
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(fixture), { status: 200 }),
      );

    await expect(
      loadInspectionPlayback(readFixture().inspectionId),
    ).rejects.toThrow("unsupported prediction format");
  });
});

describe("video timing synchronization", () => {
  it("uses decoded video frame timestamps when available", () => {
    const video = document.createElement("video");
    let callback:
      | ((now: DOMHighResTimeStamp, metadata: { mediaTime: number }) => void)
      | undefined;
    const requestVideoFrameCallback = vi.fn((next: typeof callback) => {
      callback = next;
      return 7;
    });
    const cancelVideoFrameCallback = vi.fn();
    Object.defineProperties(video, {
      cancelVideoFrameCallback: { value: cancelVideoFrameCallback },
      currentTime: { configurable: true, value: 0.25, writable: true },
      ended: { configurable: true, get: () => false },
      paused: { configurable: true, get: () => false },
      requestVideoFrameCallback: { value: requestVideoFrameCallback },
    });
    const timestamps: number[] = [];

    const stop = synchronizeVideo(video, (timestamp) =>
      timestamps.push(timestamp),
    );
    video.dispatchEvent(new Event("play"));
    callback!(0, { mediaTime: 0.4 });
    stop();

    expect(timestamps).toEqual([250, 250, 400]);
    expect(requestVideoFrameCallback).toHaveBeenCalledTimes(2);
    expect(cancelVideoFrameCallback).toHaveBeenCalledWith(7);
  });

  it("falls back to animation timing and media events for play, seek, pause, and end", () => {
    const video = document.createElement("video");
    let paused = true;
    let ended = false;
    let animationCallback: FrameRequestCallback | undefined;
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      animationCallback = callback;
      return 11;
    });
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal("requestAnimationFrame", requestAnimationFrame);
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
    Object.defineProperties(video, {
      currentTime: { configurable: true, value: 0, writable: true },
      ended: { configurable: true, get: () => ended },
      paused: { configurable: true, get: () => paused },
    });
    const timestamps: number[] = [];
    const stop = synchronizeVideo(video, (timestamp) =>
      timestamps.push(timestamp),
    );

    paused = false;
    video.currentTime = 0.2;
    video.dispatchEvent(new Event("play"));
    video.currentTime = 0.35;
    animationCallback!(0);
    video.currentTime = 0.6;
    video.dispatchEvent(new Event("seeking"));
    paused = true;
    video.currentTime = 0.7;
    video.dispatchEvent(new Event("pause"));
    ended = true;
    video.currentTime = 1;
    video.dispatchEvent(new Event("ended"));
    stop();

    expect(timestamps).toEqual([0, 200, 350, 600, 700, 1000]);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(11);
  });
});
