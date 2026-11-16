import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { app, createApp } from "../src/app.js";

describe("GET /health", () => {
  it("returns the API health placeholder", async () => {
    const response = await request(app).get("/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ service: "api", status: "ok" });
  });
});

describe("production static application", () => {
  it("serves assets and the SPA fallback without masking API routes", async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), "factorylens-web-"));
    try {
      await writeFile(
        join(staticRoot, "index.html"),
        "<main>FactoryLens</main>",
      );
      await writeFile(join(staticRoot, "asset.js"), "console.log('asset')");
      const staticApp = createApp(undefined, staticRoot);

      await request(staticApp)
        .get("/asset.js")
        .expect(200, "console.log('asset')");
      await request(staticApp)
        .get("/inspections/example")
        .set("Accept", "text/html")
        .expect(200, "<main>FactoryLens</main>");
      await request(staticApp).get("/api/missing").expect(404);
    } finally {
      await rm(staticRoot, { force: true, recursive: true });
    }
  });
});
