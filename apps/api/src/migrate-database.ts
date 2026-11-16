import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { z } from "zod";

import { writeStructuredLog } from "./security.js";

const environmentSchema = z.object({
  MIGRATION_DATABASE_URL: z.string().startsWith("postgresql://"),
});

async function run(): Promise<void> {
  const environment = environmentSchema.parse(process.env);
  const migrationUrl = new URL(environment.MIGRATION_DATABASE_URL);
  if (migrationUrl.hostname.includes("-pooler.")) {
    throw new Error("MIGRATION_DATABASE_URL must use a direct Neon endpoint");
  }

  const client = postgres(environment.MIGRATION_DATABASE_URL, { max: 1 });
  try {
    await migrate(drizzle(client), {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    writeStructuredLog("info", "database_migrations_applied");
  } finally {
    await client.end();
  }
}

void run().catch((error: unknown) => {
  writeStructuredLog("error", "database_migration_failed", {
    errorType: error instanceof Error ? error.constructor.name : "UnknownError",
  });
  process.exitCode = 1;
});
