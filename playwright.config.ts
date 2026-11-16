import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "npx tsx e2e/support/server.ts",
      port: 3100,
      reuseExistingServer: false,
    },
    {
      command:
        "npm run dev --workspace @factorylens/web -- --host 127.0.0.1 --port 5173",
      env: { WEB_API_TARGET: "http://127.0.0.1:3100" },
      port: 5173,
      reuseExistingServer: false,
    },
  ],
});
