import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AppRoutes } from "./App";
import { currentUserQueryKey } from "./current-user";

const currentUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "wajahat@example.com",
  displayName: "Wajahat Muneeb",
  avatarUrl: null,
};

function currentUserResponse() {
  return new Response(JSON.stringify({ user: currentUser }), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

function renderRoute(path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <AppRoutes />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...rendered, queryClient };
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
    ["/dashboard", "Inspection dashboard"],
    ["/inspections/new", "New inspection"],
    ["/history", "Inspection history"],
    ["/account", "Account"],
  ])("renders %s", (path, heading) => {
    renderRoute(path);

    expect(
      screen.getByRole("heading", { level: 1, name: heading }),
    ).toBeInTheDocument();
  });

  it("renders the inspection status loading state", () => {
    renderRoute("/inspections/example-id");
    expect(
      screen.getByRole("heading", { name: "Loading inspection status" }),
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

  it("provides landmarks, keyboard entry, current navigation, and a loading state", () => {
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
      screen.getByRole("heading", { name: "Loading recent inspections" }),
    ).toBeInTheDocument();
  });

  it("shows the authenticated Google profile in the shell and account page", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(currentUserResponse());
    renderRoute("/account");

    expect(await screen.findAllByText(currentUser.displayName)).toHaveLength(2);
    expect(screen.getAllByText(currentUser.email)).toHaveLength(2);
    expect(screen.queryByText("Factory member")).not.toBeInTheDocument();
    expect(screen.queryByText("member@example.com")).not.toBeInTheDocument();
  });

  it("returns an expired session to sign-in", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 401 }),
    );
    renderRoute("/dashboard");

    expect(
      await screen.findByRole("heading", {
        name: "See every moment that matters.",
      }),
    ).toBeInTheDocument();
  });

  it("moves focus to main content after client-side navigation", async () => {
    renderRoute("/dashboard");

    await waitFor(() => expect(screen.getByRole("main")).toHaveFocus());
    fireEvent.click(
      screen.getAllByRole("link", { name: "New inspection" })[0]!,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { level: 1, name: "New inspection" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("main")).toHaveFocus();
    });
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

    const trigger = screen.getByRole("button", { name: "Sign out" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog")).toHaveAccessibleName(
      "Leave FactoryLens?",
    );

    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("revokes the session before returning to sign-in", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        input === "/api/me"
          ? currentUserResponse()
          : new Response(null, { status: 200 }),
      );
    const { queryClient } = renderRoute("/account");

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
    expect(queryClient.getQueryData(currentUserQueryKey)).toBeUndefined();
  });
});
