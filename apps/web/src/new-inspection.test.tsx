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
