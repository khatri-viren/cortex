import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "live-table-safety.spec.ts",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://127.0.0.1:5175", viewport: { width: 1440, height: 900 }, trace: "off", screenshot: "off", video: "off" },
  projects: [
    { name: "webkit", use: { browserName: "webkit" } },
    { name: "chromium", use: { browserName: "chromium", channel: "chrome" } },
  ],
  webServer: { command: "bun run dev -- --host 127.0.0.1", url: "http://127.0.0.1:5175", reuseExistingServer: true },
});
