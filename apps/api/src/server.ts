import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { z } from "zod";

import { createApp } from "./app.js";
import { PostgresAuthStore } from "./db/auth-store.js";
import * as schema from "./db/schema.js";
import { createGoogleOidcProvider } from "./google-oidc.js";

const environmentSchema = z.object({
  API_HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  APP_ORIGIN: z.url(),
  AUTH_COOKIE_SECRET: z.string().min(32),
  DATABASE_URL: z.string().startsWith("postgresql://"),
  GOOGLE_OIDC_CLIENT_ID: z.string().min(1),
  GOOGLE_OIDC_CLIENT_SECRET: z.string().min(1),
});

async function start(): Promise<void> {
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

  const databaseClient = postgres(environment.DATABASE_URL);
  const store = new PostgresAuthStore(drizzle(databaseClient, { schema }));
  let oidcProvider;
  try {
    oidcProvider = await createGoogleOidcProvider(
      environment.GOOGLE_OIDC_CLIENT_ID,
      environment.GOOGLE_OIDC_CLIENT_SECRET,
    );
  } catch (error) {
    await databaseClient.end();
    throw error;
  }
  const app = createApp({
    appOrigin,
    callbackUrl: new URL("/auth/google/callback", appOrigin),
    oidcProvider,
    store,
    transactionSecret: environment.AUTH_COOKIE_SECRET,
  });

  const server = app.listen(environment.API_PORT, environment.API_HOST, () => {
    console.log(
      `FactoryLens API listening on http://${environment.API_HOST}:${environment.API_PORT}`,
    );
  });

  const shutdown = (): void => {
    server.close(() => {
      void databaseClient.end().finally(() => process.exit(0));
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

void start().catch(() => {
  console.error("FactoryLens API failed to start");
  process.exitCode = 1;
});
