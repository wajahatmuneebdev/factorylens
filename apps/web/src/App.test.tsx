import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AppRoutes } from "./App";

function renderRoute(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function showModal(
    this: HTMLDialogElement,
  ) {
    this.open = true;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("application routes", () => {
  it.each([
    ["/sign-in", "See every moment that matters."],
    ["/dashboard", "Good morning"],
    ["/inspections/new", "New inspection"],
    ["/inspections/example-id", "Packaging line check"],
    ["/history", "Inspection history"],
    ["/account", "Account"],
  ])("renders %s", (path, heading) => {
    renderRoute(path);

    expect(
      screen.getByRole("heading", { level: 1, name: heading }),
    ).toBeInTheDocument();
  });

  it("renders a not-found state inside the shell", () => {
    renderRoute("/not-a-route");

    expect(
      screen.getByRole("heading", { name: "This view is out of frame" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
  });
});

describe("application shell", () => {
  it("starts Google sign-in through the same-origin auth endpoint", () => {
    renderRoute("/sign-in");

    expect(
      screen.getByRole("link", { name: "Continue with Google" }),
    ).toHaveAttribute("href", "/auth/google?returnTo=/dashboard");
  });

  it("provides landmarks, keyboard entry, current navigation, and generic page states", () => {
    renderRoute("/dashboard");

    expect(
      screen.getByRole("link", { name: "Skip to main content" }),
    ).toHaveAttribute("href", "#main-content");
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(
      screen.getAllByRole("navigation", { name: "Primary" }),
    ).not.toHaveLength(0);
    expect(
      screen.getAllByRole("link", { name: "Dashboard" })[0],
    ).toHaveAttribute("aria-current", "page");
    expect(
      screen.getByRole("heading", { name: "Gathering the latest view" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "A clear place to begin" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Showing what is available" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "Something interrupted the request",
      }),
    ).toBeInTheDocument();
  });

  it("offers the approved video sources and workflow", () => {
    renderRoute("/inspections/new");

    expect(screen.getByRole("combobox", { name: "Workflow" })).toHaveValue(
      "factory-safety-v1",
    );
    expect(screen.getByLabelText("Video file")).toHaveAttribute(
      "accept",
      "video/*",
    );
    expect(screen.getByRole("radio", { name: /Upload a file/i })).toBeChecked();
    expect(
      screen.getByRole("radio", { name: /Record now/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: /Prepared sample/i }),
    ).toBeInTheDocument();
  });

  it("opens and closes the shared confirmation dialog", () => {
    renderRoute("/account");

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(screen.getByRole("dialog")).toHaveAccessibleName(
      "Leave FactoryLens?",
    );

    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("revokes the session before returning to sign-in", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 200 }));
    renderRoute("/account");

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    fireEvent.click(
      screen.getAllByRole("button", { name: "Sign out" }).at(-1)!,
    );

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/auth/logout", {
        method: "POST",
      });
      expect(
        screen.getByRole("heading", { name: "See every moment that matters." }),
      ).toBeInTheDocument();
    });
  });
});
