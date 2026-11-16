import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

import { z } from "zod";

import { writeStructuredLog } from "./security.js";
import { R2ObjectStorage, sourceObjectKey } from "./storage.js";

const environmentSchema = z.object({
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_ACCOUNT_ID: z.string().regex(/^[0-9a-f]{32}$/i),
  R2_BUCKET: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
});

async function smoke(): Promise<void> {
  const environment = environmentSchema.parse(process.env);
  const endpoint = `https://${environment.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const storage = new R2ObjectStorage({
    accessKeyId: environment.R2_ACCESS_KEY_ID,
    bucket: environment.R2_BUCKET,
    endpoint,
    secretAccessKey: environment.R2_SECRET_ACCESS_KEY,
  });
  const key = sourceObjectKey(randomUUID());
  const content = `factorylens-r2-smoke-${randomUUID()}`;

  try {
    await storage.put(key, Readable.from([content]));
    const authorization = await storage.authorizeDownload(key);
    const anonymousUrl = new URL(authorization.url);
    anonymousUrl.search = "";
    if ((await fetch(anonymousUrl)).status !== 403) {
      throw new Error(
        "R2 disposable object was readable without authorization",
      );
    }
    const response = await fetch(authorization.url);
    if (!response.ok || (await response.text()) !== content) {
      throw new Error(
        "R2 authorized read did not return the disposable object",
      );
    }
  } finally {
    await storage.delete(key);
  }

  if (await storage.exists(key)) {
    throw new Error("R2 disposable object still exists after deletion");
  }
  writeStructuredLog("info", "r2_smoke_check_passed");
}

void smoke().catch((error: unknown) => {
  writeStructuredLog("error", "r2_smoke_check_failed", {
    errorType: error instanceof Error ? error.constructor.name : "UnknownError",
  });
  process.exitCode = 1;
});
