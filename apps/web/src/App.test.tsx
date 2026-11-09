import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

afterEach(cleanup);

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
  it("keeps the sign-in preview honest while authentication is out of scope", () => {
    renderRoute("/sign-in");

    fireEvent.click(
      screen.getByRole("button", { name: "Continue with Google" }),
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Sign-in is not connected yet",
    );
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

  it("demonstrates form and notification primitives without creating data", () => {
    renderRoute("/inspections/new");

    fireEvent.change(screen.getByRole("textbox", { name: "Inspection name" }), {
      target: { value: "Line review" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue to media" }));

    expect(screen.getByRole("status")).toHaveTextContent(
      "Form interaction confirmed",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "does not create or upload",
    );
  });

  it("opens and closes the shared confirmation dialog", () => {
    renderRoute("/account");

    fireEvent.click(screen.getByRole("button", { name: "Sign out preview" }));
    expect(screen.getByRole("dialog")).toHaveAccessibleName(
      "Leave FactoryLens?",
    );

    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
