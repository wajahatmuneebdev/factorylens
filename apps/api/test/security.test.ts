import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import {
  browserCsrfProtection,
  redactLogValue,
  writeStructuredLog,
} from "../src/security.js";

const appOrigin = new URL("https://factorylens.example");

describe("application security controls", () => {
  it("sets browser security headers without enabling application CORS", async () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await request(createApp()).get("/health");

    expect(response.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers["x-powered-by"]).toBeUndefined();
    expect(response.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f-]{27}$/,
    );
    const entry = JSON.parse(String(output.mock.calls[0]![0]));
    expect(entry).toMatchObject({
      event: "request_completed",
      level: "info",
      method: "GET",
      path: "/health",
      requestId: response.headers["x-request-id"],
      service: "api",
      status: 200,
    });
    output.mockRestore();
  });

  it("requires same-origin browser metadata on state-changing API requests", async () => {
    const app = express();
    app.use(browserCsrfProtection(appOrigin));
    app.post("/api/change", (_request, response) => response.sendStatus(204));

    const missing = await request(app).post("/api/change");
    const crossSite = await request(app)
      .post("/api/change")
      .set("Origin", appOrigin.origin)
      .set("Sec-Fetch-Site", "cross-site");
    const allowed = await request(app)
      .post("/api/change")
      .set("Origin", appOrigin.origin)
      .set("Sec-Fetch-Site", "same-origin");

    expect(missing.status).toBe(403);
    expect(crossSite.status).toBe(403);
    expect(allowed.status).toBe(204);
  });

  it("redacts secrets, sessions, signed URLs, and private predictions", () => {
    const signedUrl =
      "https://storage.example/private?X-Amz-Credential=private-credential&X-Amz-Signature=private-signature";
    const redacted = redactLogValue({
      credentials: "database-password",
      sessionToken: "raw-session-token",
      artifactUrl: signedUrl,
      rawPredictions: [{ class: "person", confidence: 0.99 }],
    });
    const serialized = JSON.stringify(redacted);

    for (const privateValue of [
      "database-password",
      "raw-session-token",
      "private-credential",
      "private-signature",
      "confidence",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(serialized).toContain("[REDACTED]");
  });

  it("applies redaction before structured log output", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => {});

    writeStructuredLog("error", "request_failed", {
      authorization: "Bearer private-token",
      signedUrl:
        "https://storage.example/private?X-Amz-Signature=private-signature",
    });

    expect(output).toHaveBeenCalledOnce();
    const logged = String(output.mock.calls[0]![0]);
    expect(logged).not.toContain("private-token");
    expect(logged).not.toContain("private-signature");
    output.mockRestore();
  });
});
