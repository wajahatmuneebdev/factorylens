import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { App } from "./App";

describe("App", () => {
  it("shows the web health placeholder", () => {
    render(<App />);

    expect(screen.getByRole("status")).toHaveTextContent("Health: ok");
  });
});
