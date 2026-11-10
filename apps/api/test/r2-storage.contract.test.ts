import { createServer, type IncomingMessage, type Server } from "node:http";
import { Readable } from "node:stream";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  R2ObjectStorage,
  StorageObjectNotFoundError,
  factoryLensR2CorsConfiguration,
  sourceObjectKey,
} from "../src/storage.js";

const bucket = "factorylens-test";
const inspectionId = "323e4567-e89b-42d3-a456-426614174000";
const key = sourceObjectKey(inspectionId);
const appOrigin = new URL("https://factorylens.example");

interface AllowedRequest {
  headers: Record<string, string>;
  method: "GET" | "PUT";
}

class R2TestDouble {
  corsConfigurationXml: string | null = null;
  endpoint = "";

  private readonly allowedRequests = new Map<string, AllowedRequest>();
  private readonly objects = new Map<string, Buffer>();
  private server: Server | null = null;

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handle(request).then(({ body, headers, status }) => {
        response.writeHead(status, headers);
        response.end(body);
      });
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("R2 test double did not bind to a TCP port");
    }
    this.endpoint = `http://127.0.0.1:${address.port}`;
  }

  allow(
    method: AllowedRequest["method"],
    url: string,
    headers: Record<string, string> = {},
  ): void {
    const parsed = new URL(url);
    this.allowedRequests.set(`${parsed.pathname}${parsed.search}`, {
      headers,
      method,
    });
  }

  async close(): Promise<void> {
    if (!this.server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this.server!.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private async handle(request: IncomingMessage): Promise<{
    body?: Buffer | string;
    headers?: Record<string, string>;
    status: number;
  }> {
    const requestUrl = new URL(
      request.url ?? "/",
      `http://${request.headers.host}`,
    );
    if (!this.isAuthorized(request, requestUrl)) {
      return this.error(403, "AccessDenied");
    }

    const pathSegments = requestUrl.pathname
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    if (pathSegments.shift() !== bucket) {
      return this.error(404, "NoSuchBucket");
    }

    if (requestUrl.searchParams.has("cors")) {
      if (request.method !== "PUT") {
        return this.error(405, "MethodNotAllowed");
      }
      this.corsConfigurationXml = (await this.readBody(request)).toString(
        "utf8",
      );
      return { status: 200 };
    }

    const objectKey = pathSegments.join("/");
    if (!objectKey) {
      return this.error(400, "InvalidRequest");
    }

    if (request.method === "PUT") {
      this.objects.set(objectKey, await this.readBody(request));
      return { headers: { etag: '"test-etag"' }, status: 200 };
    }
    if (request.method === "DELETE") {
      this.objects.delete(objectKey);
      return { status: 204 };
    }

    const object = this.objects.get(objectKey);
    if (!object) {
      return this.error(404, "NoSuchKey");
    }
    if (request.method === "HEAD") {
      return {
        headers: { "content-length": String(object.byteLength) },
        status: 200,
      };
    }
    if (request.method === "GET") {
      return {
        body: object,
        headers: {
          "content-length": String(object.byteLength),
          "content-type": "application/octet-stream",
        },
        status: 200,
      };
    }
    return this.error(405, "MethodNotAllowed");
  }

  private isAuthorized(request: IncomingMessage, requestUrl: URL): boolean {
    if (typeof request.headers.authorization === "string") {
      return true;
    }

    const signature = requestUrl.searchParams.get("X-Amz-Signature");
    const signedAt = requestUrl.searchParams.get("X-Amz-Date");
    const expiresIn = Number(requestUrl.searchParams.get("X-Amz-Expires"));
    if (!signature || !signedAt || !Number.isFinite(expiresIn)) {
      return false;
    }

    const allowed = this.allowedRequests.get(
      `${requestUrl.pathname}${requestUrl.search}`,
    );
    if (!allowed || request.method !== allowed.method) {
      return false;
    }
    for (const [name, value] of Object.entries(allowed.headers)) {
      if (request.headers[name.toLowerCase()] !== value) {
        return false;
      }
    }

    const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(
      signedAt,
    );
    if (!match) {
      return false;
    }
    const signedAtMilliseconds = Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    );
    return Date.now() <= signedAtMilliseconds + expiresIn * 1000;
  }

  private async readBody(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  private error(status: number, code: string) {
    return {
      body: `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`,
      headers: { "content-type": "application/xml" },
      status,
    };
  }
}

describe("R2 storage contract", () => {
  const testDouble = new R2TestDouble();
  let storage: R2ObjectStorage;

  beforeAll(async () => {
    await testDouble.start();
    storage = createStorage();
  });

  afterAll(async () => {
    await testDouble.close();
  });

  function createStorage(
    now: () => Date = () => new Date(),
    authorizationTtlSeconds = 600,
  ): R2ObjectStorage {
    return new R2ObjectStorage({
      accessKeyId: "test-access-key",
      authorizationTtlSeconds,
      bucket,
      endpoint: testDouble.endpoint,
      forcePathStyle: true,
      now,
      secretAccessKey: "test-secret-key",
    });
  }

  it("stores private objects and reports metadata and missing keys", async () => {
    const content = "private factory video";
    await expect(storage.put(key, Readable.from([content]))).resolves.toEqual({
      key,
      sizeBytes: Buffer.byteLength(content),
    });
    await expect(storage.metadata(key)).resolves.toEqual({
      key,
      sizeBytes: Buffer.byteLength(content),
    });

    const stored = await storage.read(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stored) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).toString("utf8")).toBe(content);
    expect(
      (await fetch(`${testDouble.endpoint}/${bucket}/${key}`)).status,
    ).toBe(403);

    const missingKey = `inspections/${inspectionId}/generations/1/prediction`;
    await expect(storage.metadata(missingKey)).rejects.toBeInstanceOf(
      StorageObjectNotFoundError,
    );
    await expect(storage.exists(missingKey)).resolves.toBe(false);
  });

  it("authorizes one upload method, key, and content type", async () => {
    const uploadKey = `inspections/${inspectionId}/generations/2/normalized`;
    const authorization = await storage.authorizeUpload(uploadKey, "video/mp4");
    testDouble.allow(
      authorization.method,
      authorization.url,
      authorization.headers,
    );

    expect(authorization).toMatchObject({
      method: "PUT",
      headers: { "Content-Type": "video/mp4" },
    });
    expect(
      new URL(authorization.url).searchParams.get("X-Amz-SignedHeaders"),
    ).toContain("content-type");
    expect((authorization.expiresAt.getTime() - Date.now()) / 1000).toBeCloseTo(
      600,
      -1,
    );

    expect(
      (
        await fetch(authorization.url, {
          headers: authorization.headers,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(authorization.url, {
          body: "wrong content type",
          headers: { "Content-Type": "video/webm" },
          method: authorization.method,
        })
      ).status,
    ).toBe(403);

    const wrongKeyUrl = new URL(authorization.url);
    wrongKeyUrl.pathname = wrongKeyUrl.pathname.replace(
      "/normalized",
      "/prediction",
    );
    expect(
      (
        await fetch(wrongKeyUrl, {
          body: "wrong target",
          headers: authorization.headers,
          method: authorization.method,
        })
      ).status,
    ).toBe(403);

    const uploaded = await fetch(authorization.url, {
      body: "normalized video",
      headers: authorization.headers,
      method: authorization.method,
    });
    expect(uploaded.status).toBe(200);
    await expect(storage.metadata(uploadKey)).resolves.toEqual({
      key: uploadKey,
      sizeBytes: Buffer.byteLength("normalized video"),
    });
  });

  it("authorizes one private download and rejects expired authorization", async () => {
    const authorization = await storage.authorizeDownload(key);
    testDouble.allow("GET", authorization.url);
    const downloaded = await fetch(authorization.url);
    expect(downloaded.status).toBe(200);
    await expect(downloaded.text()).resolves.toBe("private factory video");

    const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
    const expiredStorage = createStorage(() => twentyMinutesAgo, 60);
    const expired = await expiredStorage.authorizeDownload(key);
    testDouble.allow("GET", expired.url);
    expect(expired.expiresAt.getTime()).toBe(
      twentyMinutesAgo.getTime() + 60 * 1000,
    );
    expect((await fetch(expired.url)).status).toBe(403);
  });

  it("configures browser CORS only for the configured origin and methods", async () => {
    expect(factoryLensR2CorsConfiguration(appOrigin)).toEqual({
      CORSRules: [
        {
          AllowedHeaders: ["content-type", "range"],
          AllowedMethods: ["GET", "PUT"],
          AllowedOrigins: [appOrigin.origin],
          ExposeHeaders: [
            "accept-ranges",
            "content-length",
            "content-range",
            "etag",
          ],
          MaxAgeSeconds: 3600,
        },
      ],
    });

    await storage.configureCors(appOrigin);
    expect(testDouble.corsConfigurationXml).toContain(appOrigin.origin);
    expect(testDouble.corsConfigurationXml).toContain(
      "<AllowedMethod>GET</AllowedMethod>",
    );
    expect(testDouble.corsConfigurationXml).toContain(
      "<AllowedMethod>PUT</AllowedMethod>",
    );
    expect(testDouble.corsConfigurationXml).not.toContain("attacker.example");
  });
});
