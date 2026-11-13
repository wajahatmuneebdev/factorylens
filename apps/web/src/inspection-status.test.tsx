import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  Inspection,
  InspectionState,
  JobState,
} from "@factorylens/contracts";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { InspectionStatus } from "./inspection-status";

const inspectionId = "10000000-0000-4000-8000-000000000027";
const timestamp = "2026-11-13T08:00:00.000Z";

function inspection(
  status: InspectionState,
  jobStatus: JobState | null = null,
): Inspection {
  return {
    id: inspectionId,
    title: `${status} inspection`,
    status,
    sourceType: "upload",
    workflowKey: "factory-safety-v1",
    progress: {
      stage: status === "processing" ? "running_workflow" : null,
      percent: status === "completed" ? 100 : status === "processing" ? 62 : 0,
    },
    job: jobStatus
      ? {
          attempt: 2,
          cancellationRequested: false,
          maxAttempts: 3,
          status: jobStatus,
        }
      : null,
    summary: null,
    error:
      status === "failed"
        ? {
            category: "retryable",
            code: "provider_unavailable",
            message: "Processing is temporarily unavailable.",
          }
        : null,
    createdAt: timestamp,
    queuedAt: status === "awaiting_upload" ? null : timestamp,
    startedAt: status === "processing" ? timestamp : null,
    completedAt: status === "completed" ? timestamp : null,
    updatedAt: timestamp,
  };
}

function response(value: Inspection, status = 200) {
  return new Response(JSON.stringify({ inspection: value }), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function renderStatus() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <InspectionStatus inspectionId={inspectionId} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("inspection processing status", () => {
  it.each([
    ["awaiting_upload", "Awaiting upload"],
    ["queued", "Queued"],
    ["processing", "Processing"],
    ["completed", "Completed"],
    ["failed", "Failed"],
    ["cancelled", "Cancelled"],
  ] as const)("renders the %s lifecycle state", async (status, label) => {
    const jobStatus =
      status === "queued"
        ? "queued"
        : status === "processing"
          ? "running"
          : null;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response(inspection(status, jobStatus)),
    );
    renderStatus();

    expect(
      await screen.findByRole("heading", { name: `${status} inspection` }),
    ).toBeInTheDocument();
    expect(screen.getByText(label)).toBeInTheDocument();
    if (status === "queued" || status === "processing") {
      expect(
        screen.getByRole("button", { name: "Cancel inspection" }),
      ).toBeEnabled();
    } else {
      expect(
        screen.queryByRole("button", { name: "Cancel inspection" }),
      ).not.toBeInTheDocument();
    }
    if (status === "failed") {
      expect(
        screen.getByText("Processing is temporarily unavailable."),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Retry inspection" }),
      ).toBeEnabled();
    }
  });

  it.each([
    ["queued", "queued"],
    ["processing", "running"],
    ["processing", "retry_wait"],
  ] as const)("polls active %s/%s state", async (status, jobStatus) => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(response(inspection(status, jobStatus)));
    renderStatus();
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it.each(["awaiting_upload", "completed", "failed", "cancelled"] as const)(
    "stops polling in %s state",
    async (status) => {
      vi.useFakeTimers();
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(response(inspection(status)));
      renderStatus();
      await vi.runOnlyPendingTimersAsync();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("pauses polling while the page is hidden", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(response(inspection("processing", "running")));
    renderStatus();
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("disables duplicate cancellation and reconciles the returned state", async () => {
    const current = inspection("processing", "running");
    const cancellationRequested = {
      ...current,
      job: { ...current.job!, cancellationRequested: true },
    };
    let resolveCommand!: (value: Response) => void;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response(current))
      .mockImplementationOnce(
        () => new Promise((resolve) => (resolveCommand = resolve)),
      );
    renderStatus();

    const cancel = await screen.findByRole("button", {
      name: "Cancel inspection",
    });
    fireEvent.click(cancel);
    expect(
      await screen.findByRole("button", { name: "Cancelling…" }),
    ).toBeDisabled();
    resolveCommand(response(cancellationRequested));

    await waitFor(() =>
      expect(screen.getByText("Cancellation requested")).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: /Cancel/ }),
    ).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/inspections/${inspectionId}/cancel`,
      { method: "POST" },
    );
  });

  it("retries eligible failures and reports command/API degradation safely", async () => {
    const failed = inspection("failed", "failed");
    const queued = inspection("queued", "pending_dispatch");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response(failed))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: "provider_unavailable",
              category: "retryable",
              message: "Retry is temporarily unavailable.",
            },
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(response(queued));
    renderStatus();

    fireEvent.click(
      await screen.findByRole("button", { name: "Retry inspection" }),
    );
    expect(
      await screen.findByText("Retry is temporarily unavailable."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry inspection" }));
    expect(await screen.findByText("Queued")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/inspections/${inspectionId}/retry`,
      { method: "POST" },
    );
  });

  it("offers recovery when the status API is unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 503 }),
    );
    renderStatus();
    expect(
      await screen.findByRole("heading", {
        name: "Inspection status is unavailable",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Try again" }),
    ).toBeInTheDocument();
  });
});
