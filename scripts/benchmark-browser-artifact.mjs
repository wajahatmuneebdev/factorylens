#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import process from "node:process";

import { chromium } from "@playwright/test";

const artifactPath = process.argv[2];
if (!artifactPath) {
  throw new Error("Usage: benchmark-browser-artifact.mjs <artifact.json.gz>");
}

const artifact = await readFile(artifactPath);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route("https://benchmark.factorylens/artifact", (route) =>
    route.fulfill({
      body: artifact,
      contentType: "application/gzip",
      status: 200,
    }),
  );
  await page.goto("about:blank");
  const session = await page.context().newCDPSession(page);
  const iterations = [];
  for (let index = 0; index < 5; index += 1) {
    await session.send("HeapProfiler.collectGarbage");
    const before = await session.send("Runtime.getHeapUsage");
    const timing = await page.evaluate(async () => {
      const started = performance.now();
      const response = await fetch("https://benchmark.factorylens/artifact");
      const fetched = performance.now();
      if (!response.body) throw new Error("Artifact response has no body");
      const decompressed = await new Response(
        response.body.pipeThrough(new DecompressionStream("gzip")),
      ).arrayBuffer();
      const decoded = performance.now();
      const document = JSON.parse(new TextDecoder().decode(decompressed));
      const parsed = performance.now();
      return {
        artifactBytesJson: decompressed.byteLength,
        frameCount: document.frames.length,
        fetchMs: fetched - started,
        decompressMs: decoded - fetched,
        parseMs: parsed - decoded,
        totalMs: parsed - started,
      };
    });
    const after = await session.send("Runtime.getHeapUsage");
    iterations.push({
      ...timing,
      heapDeltaBytes: Math.max(0, after.usedSize - before.usedSize),
      heapUsedAfterBytes: after.usedSize,
    });
  }
  const median = (field) =>
    [...iterations].sort((left, right) => left[field] - right[field])[2][field];
  process.stdout.write(
    `${JSON.stringify({
      artifactBytesGzip: artifact.byteLength,
      artifactBytesJson: iterations[0].artifactBytesJson,
      frameCount: iterations[0].frameCount,
      iterations: iterations.length,
      medianMs: {
        fetch: median("fetchMs"),
        decompress: median("decompressMs"),
        parse: median("parseMs"),
        total: median("totalMs"),
      },
      medianHeapDeltaBytes: median("heapDeltaBytes"),
      medianHeapUsedAfterBytes: median("heapUsedAfterBytes"),
    })}\n`,
  );
} finally {
  await browser.close();
}
