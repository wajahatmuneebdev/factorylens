import { z } from "zod";

import { R2ObjectStorage } from "./storage.js";

const environmentSchema = z.object({
  APP_ORIGIN: z.url(),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_ACCOUNT_ID: z.string().regex(/^[0-9a-f]{32}$/i),
  R2_BUCKET: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
});

async function configure(): Promise<void> {
  const environment = environmentSchema.parse(process.env);
  const appOrigin = new URL(environment.APP_ORIGIN);
  if (
    appOrigin.protocol !== "https:" ||
    appOrigin.username ||
    appOrigin.password ||
    appOrigin.pathname !== "/" ||
    appOrigin.search ||
    appOrigin.hash
  ) {
    throw new Error("APP_ORIGIN must be an HTTPS origin");
  }

  const storage = new R2ObjectStorage({
    accessKeyId: environment.R2_ACCESS_KEY_ID,
    bucket: environment.R2_BUCKET,
    endpoint: `https://${environment.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    secretAccessKey: environment.R2_SECRET_ACCESS_KEY,
  });
  await storage.configureCors(appOrigin);
  console.log("FactoryLens R2 CORS configuration applied");
}

void configure().catch(() => {
  console.error("FactoryLens R2 configuration failed");
  process.exitCode = 1;
});
