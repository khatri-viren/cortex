import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5175",
    trace: "on-first-retry",
    ...devices["Desktop Chrome"],
  },
  webServer: [
    {
      command: "cd .. && bun run dev -- --vault ../cortex-sample-vault --port 4170",
      url: "http://127.0.0.1:4170/api/health",
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: "bun run dev -- --host 127.0.0.1",
      url: "http://127.0.0.1:5175",
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
