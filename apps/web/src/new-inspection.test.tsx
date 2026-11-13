import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NewInspectionForm } from "./new-inspection";

const inspectionId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const timestamp = "2026-11-13T10:00:00.000Z";
const inspection = {
  id: inspectionId,
  title: "Line review",
  status: "awaiting_upload",
  sourceType: "upload",
  workflowKey: "factory-safety-v1",
  progress: { stage: null, percent: 0 },
  job: null,
  summary: null,
  error: null,
  createdAt: timestamp,
  queuedAt: null,
  startedAt: null,
  completedAt: null,
  updatedAt: timestamp,
};

class MockXmlHttpRequest extends EventTarget {
  static instances: MockXmlHttpRequest[] = [];
  upload = new EventTarget();
  status = 0;
  abort = vi.fn(() => this.dispatchEvent(new Event("abort")));
  open = vi.fn();
  send = vi.fn();
  setRequestHeader = vi.fn();

  constructor() {
    super();
    MockXmlHttpRequest.instances.push(this);
  }

  progress(loaded: number, total: number) {
    const event = new Event("progress") as ProgressEvent;
    Object.defineProperties(event, {
      lengthComputable: { value: true },
      loaded: { value: loaded },
      total: { value: total },
    });
    this.upload.dispatchEvent(event);
  }

  respond(status: number) {
    this.status = status;
    this.dispatchEvent(new Event("load"));
  }
}

function createResponse(expiresAt = "2099-01-01T00:00:00.000Z") {
  return new Response(
    JSON.stringify({
      inspection,
      upload: {
        method: "PUT",
        url: "https://storage.example/upload",
        headers: { "Content-Type": "video/mp4" },
        expiresAt,
      },
    }),
    { status: 201, headers: { "Content-Type": "application/json" } },
  );
}

function renderForm() {
  return render(
    <MemoryRouter initialEntries={["/inspections/new"]}>
      <Routes>
        <Route element={<NewInspectionForm />} path="/inspections/new" />
        <Route element={<h1>Created inspection</h1>} path="/inspections/:id" />
      </Routes>
    </MemoryRouter>,
  );
}

function fillForm() {
  fireEvent.change(screen.getByRole("textbox", { name: "Inspection name" }), {
    target: { value: "Line review" },
  });
  fireEvent.change(screen.getByLabelText("Video file"), {
    target: { files: [new File(["video"], "line.mp4", { type: "video/mp4" })] },
  });
}

beforeEach(() => {
  MockXmlHttpRequest.instances = [];
  vi.stubGlobal("XMLHttpRequest", MockXmlHttpRequest);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("new inspection upload", () => {
  it("validates title and source metadata with the shared rules", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    renderForm();
    fireEvent.click(screen.getByRole("button", { name: "Create and upload" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose a supported video file",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports byte progress and prevents a duplicate submission", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(createResponse());
    renderForm();
    fillForm();
    const submit = screen.getByRole("button", { name: "Create and upload" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => expect(MockXmlHttpRequest.instances).toHaveLength(1));
    MockXmlHttpRequest.instances[0]!.progress(5, 10);
    expect(
      await screen.findByRole("progressbar", { name: /Uploading video/ }),
    ).toHaveAttribute("aria-valuenow", "50");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(submit).toBeDisabled();
  });

  it("cancels before completion without confirming the upload", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(createResponse());
    renderForm();
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Create and upload" }));
    await waitFor(() => expect(MockXmlHttpRequest.instances).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Cancel upload" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Upload cancelled",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("distinguishes expired authorization and permits a fresh attempt", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(createResponse("2020-01-01T00:00:00.000Z"));
    renderForm();
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Create and upload" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Authorization expired",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    fireEvent.click(screen.getByRole("button", { name: "Create and upload" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("retries a recoverable creation failure", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "Try later" } }), {
          status: 503,
        }),
      )
      .mockResolvedValueOnce(createResponse());
    renderForm();
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Create and upload" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Try later");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    fireEvent.click(screen.getByRole("button", { name: "Create and upload" }));
    await waitFor(() => expect(MockXmlHttpRequest.instances).toHaveLength(1));
  });

  it("verifies the upload and navigates to the queued inspection", async () => {
    const queued = { ...inspection, status: "queued", queuedAt: timestamp };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createResponse())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            inspection: queued,
            job: { id: jobId, status: "queued" },
          }),
          { status: 200 },
        ),
      );
    renderForm();
    fillForm();
    fireEvent.click(screen.getByRole("button", { name: "Create and upload" }));
    await waitFor(() => expect(MockXmlHttpRequest.instances).toHaveLength(1));
    MockXmlHttpRequest.instances[0]!.respond(200);
    expect(
      await screen.findByRole("heading", { name: "Created inspection" }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/inspections/${inspectionId}/upload-complete`,
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("recording and prepared sample inputs", () => {
  it("requests camera permission only after the user starts recording", async () => {
    const getUserMedia = vi
      .fn()
      .mockRejectedValue(new DOMException("denied", "NotAllowedError"));
    class RecordingCapability {
      static isTypeSupported = vi.fn(() => true);
    }
    vi.stubGlobal("MediaRecorder", RecordingCapability);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    renderForm();
    fireEvent.click(screen.getByRole("radio", { name: /Record now/i }));
    expect(getUserMedia).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "permission was denied",
    );
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: true });
  });

  it("previews and uploads the browser-supported recording format", async () => {
    class MockMediaRecorder extends EventTarget {
      static instance: MockMediaRecorder;
      static isTypeSupported = vi.fn((type: string) => type.includes("vp9"));
      mimeType: string;
      state = "inactive";
      constructor(_stream: MediaStream, options: MediaRecorderOptions) {
        super();
        this.mimeType = options.mimeType ?? "";
        MockMediaRecorder.instance = this;
      }
      start = vi.fn(() => {
        this.state = "recording";
      });
      stop = vi.fn(() => {
        this.state = "inactive";
        const event = new Event("dataavailable") as BlobEvent;
        Object.defineProperty(event, "data", {
          value: new Blob(["recorded video"], { type: this.mimeType }),
        });
        this.dispatchEvent(event);
        this.dispatchEvent(new Event("stop"));
      });
    }
    const stopTrack = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({
      getTracks: () => [{ stop: stopTrack }],
    });
    vi.stubGlobal("MediaRecorder", MockMediaRecorder);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:recording");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(createResponse())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            inspection: {
              ...inspection,
              sourceType: "recording",
              status: "queued",
              queuedAt: timestamp,
            },
            job: { id: jobId, status: "queued" },
          }),
          { status: 200 },
        ),
      );
    renderForm();
    fireEvent.change(screen.getByRole("textbox", { name: "Inspection name" }), {
      target: { value: "Camera check" },
    });
    fireEvent.click(screen.getByRole("radio", { name: /Record now/i }));
    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));
    expect(
      await screen.findByLabelText("Recorded video preview"),
    ).toHaveAttribute("src", "blob:recording");
    fireEvent.click(screen.getByRole("button", { name: "Create and upload" }));
    await waitFor(() => expect(MockXmlHttpRequest.instances).toHaveLength(1));
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(requestBody.source).toMatchObject({
      sourceType: "recording",
      contentType: "video/webm;codecs=vp9,opus",
      fileName: "factorylens-recording.webm",
    });
    MockXmlHttpRequest.instances[0]!.respond(200);
    expect(
      await screen.findByRole("heading", { name: "Created inspection" }),
    ).toBeInTheDocument();
    expect(stopTrack).toHaveBeenCalled();
  });

  it("creates the prepared sample through the inspection contract without uploading", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          inspection: { ...inspection, sourceType: "sample", status: "queued" },
          upload: null,
        }),
        { status: 201 },
      ),
    );
    renderForm();
    fireEvent.change(screen.getByRole("textbox", { name: "Inspection name" }), {
      target: { value: "Prepared sample" },
    });
    fireEvent.click(screen.getByRole("radio", { name: /Prepared sample/i }));
    expect(
      screen.getByText("2-second, 1840 × 1080 WebM", { exact: false }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Inspect sample" }));
    expect(
      await screen.findByRole("heading", { name: "Created inspection" }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({
      source: {
        sourceType: "sample",
        sampleKey: "assembly-line-no-hard-hat",
      },
    });
    expect(MockXmlHttpRequest.instances).toHaveLength(0);
  });
});
