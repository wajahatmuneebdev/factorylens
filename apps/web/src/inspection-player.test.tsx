import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

import {
  PredictionArtifactV1Schema,
  type PredictionArtifactV1,
} from "@factorylens/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  calculateCoordinateTransform,
  eventTimelinePosition,
  filterPredictionEvents,
  filterPredictionFrame,
  loadInspectionPlayback,
  PredictionVideo,
  seekToEvent,
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

describe("local investigation filters", () => {
  it("filters classes and includes predictions and events on the confidence boundary", () => {
    const fixture = readFixture();
    const allClasses = new Set(fixture.classes);

    expect(
      filterPredictionFrame(fixture.frames[0]!, {
        confidence: 0.91,
        enabledClasses: allClasses,
      })?.predictions,
    ).toHaveLength(1);
    expect(
      filterPredictionFrame(fixture.frames[0]!, {
        confidence: 0.911,
        enabledClasses: allClasses,
      })?.predictions,
    ).toHaveLength(0);
    expect(
      filterPredictionEvents(fixture.events, {
        confidence: 0.93,
        enabledClasses: allClasses,
      }),
    ).toHaveLength(1);
    expect(
      filterPredictionEvents(fixture.events, {
        confidence: 0,
        enabledClasses: new Set(["Person", "Hardhat"]),
      }),
    ).toHaveLength(0);
  });

  it("handles empty frames and events", () => {
    expect(
      filterPredictionFrame(null, {
        confidence: 0.5,
        enabledClasses: new Set(),
      }),
    ).toBeNull();
    expect(
      filterPredictionEvents([], {
        confidence: 0.5,
        enabledClasses: new Set(["NO-Hardhat"]),
      }),
    ).toEqual([]);
  });
});

describe("event timeline", () => {
  it("scales event ranges against the complete inspection duration", () => {
    const event = {
      ...readFixture().events[0]!,
      startMs: 250,
      endMs: 750,
    };

    expect(eventTimelinePosition(event, 1_000)).toEqual({
      leftPercent: 25,
      widthPercent: 50,
    });
  });

  it("seeks video to an event start", () => {
    const video = document.createElement("video");

    seekToEvent(video, { ...readFixture().events[0]!, startMs: 400 });

    expect(video.currentTime).toBe(0.4);
  });

  it("keeps filters, visible counts, markers, and selected context in sync locally", () => {
    const fixture = readFixture();
    const fetchMock = vi.spyOn(globalThis, "fetch");

    const { container } = render(
      <PredictionVideo artifact={fixture} videoUrl="video.webm" />,
    );

    expect(screen.getByLabelText("Person")).toBeChecked();
    expect(screen.getByLabelText("Hardhat")).toBeChecked();
    expect(screen.getByLabelText("NO-Hardhat")).toBeChecked();
    expect(screen.getByLabelText("Minimum confidence")).toHaveValue("50");
    expect(screen.getByText("1 of 1 visible")).toBeInTheDocument();
    expect(
      screen.getByText(/1 visible prediction at 0.0s/),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Minimum confidence"), {
      target: { value: "92" },
    });
    expect(
      screen.getByText(/0 visible predictions at 0.0s/),
    ).toBeInTheDocument();
    expect(screen.getByText("1 of 1 visible")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Minimum confidence"), {
      target: { value: "94" },
    });
    expect(screen.getByText("0 of 1 visible")).toBeInTheDocument();
    expect(
      screen.getByText(
        "No events match the current class and confidence filters.",
      ),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Minimum confidence"), {
      target: { value: "50" },
    });
    const marker = screen.getByRole("button", {
      name: "Missing hard hat at 0.0 seconds",
    });
    fireEvent.click(marker);

    expect(marker).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("status")).toHaveTextContent(
      "0.0s–1.0s · peak confidence 93% · 3 qualifying frames",
    );
    expect(container.querySelector("video")?.currentTime).toBe(0);

    fireEvent.click(screen.getByLabelText("NO-Hardhat"));
    expect(screen.getByText("0 of 1 visible")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a useful empty state when the artifact has no predictions or events", () => {
    const fixture = readFixture();
    const emptyArtifact: PredictionArtifactV1 = {
      ...fixture,
      frames: [],
      events: [],
      summary: {
        missingHardHatEventCount: 0,
        peakConfidence: null,
        qualifyingFrameCount: 0,
      },
    };

    render(<PredictionVideo artifact={emptyArtifact} videoUrl="video.webm" />);

    expect(screen.getByText("No sampled predictions")).toBeInTheDocument();
    expect(screen.getByText("0 of 0 visible")).toBeInTheDocument();
    expect(
      screen.getByText("No documented events were found in this inspection."),
    ).toBeInTheDocument();
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
