import { describe, expect, it } from "vitest";

import { createHealthResponse } from "../src/index";

describe("createHealthResponse", () => {
  it("creates the shared health contract", () => {
    expect(createHealthResponse("web")).toEqual({
      service: "web",
      status: "ok",
    });
  });
});
