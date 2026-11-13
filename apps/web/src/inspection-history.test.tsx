import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Inspection, InspectionState } from "@factorylens/contracts";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppRoutes } from "./App";

const ids = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
] as const;

function inspection(
  id: string,
  status: InspectionState,
  title: string,
): Inspection {
  return {
    id,
    title,
    status,
    sourceType: status === "processing" ? "recording" : "upload",
    workflowKey: "factory-safety-v1",
    progress: {
      stage: status === "processing" ? "running_workflow" : null,
      percent: status === "processing" ? 62 : status === "completed" ? 100 : 0,
    },
    job: null,
    summary:
      status === "completed"
        ? {
            missingHardHatEventCount: 2,
            qualifyingFrameCount: 12,
            peakConfidence: 0.91,
          }
        : null,
    error:
      status === "failed"
        ? {
            code: "invalid_media",
            category: "terminal",
            message: "Video could not be decoded.",
          }
        : null,
    createdAt: `2026-11-${id.endsWith("1") ? "13" : "12"}T08:00:00.000Z`,
    queuedAt: null,
    startedAt: null,
    completedAt: status === "completed" ? "2026-11-13T08:02:00.000Z" : null,
    updatedAt: "2026-11-13T08:02:00.000Z",
  };
}

function response(inspections: Inspection[], nextCursor: string | null = null) {
  return new Response(JSON.stringify({ inspections, nextCursor }), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function renderRoute(path = "/history") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("inspection dashboard and history", () => {
  it("shows a concise recent list and a clear start action", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        response([inspection(ids[0], "completed", "Recent inspection")]),
      );
    renderRoute("/dashboard");

    expect(
      await screen.findByRole("link", { name: "Recent inspection" }),
    ).toBeInTheDocument();
    expect(
      screen
        .getAllByRole("link", { name: /New inspection/ })
        .find((link) => link.matches(".button--primary")),
    ).toHaveAttribute("href", "/inspections/new");
    expect(fetchMock).toHaveBeenCalledWith("/api/inspections?limit=5");
  });

  it("shows an intentional empty history state", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response([]));
    renderRoute();

    expect(
      await screen.findByRole("heading", { name: "No inspection history yet" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start an inspection" }),
    ).toBeInTheDocument();
  });

  it("renders mixed lifecycle states with source, progress, result, and stable created times", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response([
        inspection(ids[0], "completed", "Packaging review"),
        inspection(ids[1], "processing", "Loading bay review"),
        inspection(ids[2], "failed", "Conveyor review"),
      ]),
    );
    renderRoute();

    expect(
      await screen.findByRole("link", { name: "Packaging review" }),
    ).toBeInTheDocument();
    expect(
      screen
        .getAllByText("Completed")
        .find((element) => element.matches(".badge")),
    ).toHaveClass("badge--positive");
    expect(
      screen
        .getAllByText("Processing")
        .find((element) => element.matches(".badge")),
    ).toHaveClass("badge--info");
    expect(
      screen
        .getAllByText("Failed")
        .find((element) => element.matches(".badge")),
    ).toHaveClass("badge--critical");
    expect(screen.getByText("2 missing hard-hat events")).toBeInTheDocument();
    expect(
      screen.getByRole("progressbar", { name: "62% complete" }),
    ).toHaveAttribute("aria-valuenow", "62");
    expect(screen.getByText("Video could not be decoded.")).toBeInTheDocument();
    expect(screen.getAllByRole("time")[0]).toHaveAttribute(
      "datetime",
      "2026-11-13T08:00:00.000Z",
    );
  });

  it("opens the selected inspection detail route", async () => {
    const selected = inspection(ids[0], "completed", "Packaging review");
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response([selected]))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ inspection: selected }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      );
    renderRoute();

    fireEvent.click(
      await screen.findByRole("link", { name: "Packaging review" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Packaging review" }),
    ).toBeInTheDocument();
  });

  it("loads the next page only when the API supplies a cursor", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        response(
          [inspection(ids[0], "completed", "Newest inspection")],
          "older-page",
        ),
      )
      .mockResolvedValueOnce(
        response([inspection(ids[1], "cancelled", "Older inspection")]),
      );
    renderRoute();

    fireEvent.click(
      await screen.findByRole("button", { name: "Load older inspections" }),
    );
    expect(
      await screen.findByRole("link", { name: "Older inspection" }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/inspections?limit=20&cursor=older-page",
    );
    expect(
      screen.queryByRole("button", { name: "Load older inspections" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("You have reached the end of your history."),
    ).toBeInTheDocument();
  });

  it("offers retry after an API failure and redirects a signed-out request", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(response([]));
    const first = renderRoute();

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("heading", { name: "No inspection history yet" }),
    ).toBeInTheDocument();
    first.unmount();

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    renderRoute();
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "See every moment that matters." }),
      ).toBeInTheDocument(),
    );
  });
});
