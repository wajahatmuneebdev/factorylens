import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [react()],
    server: {
      host: environment.WEB_HOST ?? "127.0.0.1",
      port: Number(environment.WEB_PORT ?? 5173),
      proxy: {
        "/api": environment.WEB_API_TARGET ?? "http://127.0.0.1:3000",
        "/auth": environment.WEB_API_TARGET ?? "http://127.0.0.1:3000",
      },
    },
    test: {
      environment: "jsdom",
      setupFiles: "./src/setupTests.ts",
    },
  };
});
