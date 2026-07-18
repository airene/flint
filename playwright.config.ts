import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.e2e.ts",
  globalSetup: "./tests/e2e/global-setup.ts",
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4302",
    trace: "retain-on-failure",
  },
});
