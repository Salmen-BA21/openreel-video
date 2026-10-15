import { defineConfig } from "@playwright/test";

/**
 * Viewport validation for the responsive editor redesign.
 *
 * These specs boot the real dev server and assert the editor at real device
 * sizes: layout tier, no horizontal overflow, comfortable touch targets, and
 * screenshot capture for visual review.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: true,
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:5173",
    headless: true,
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm dev",
    port: 5173,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
