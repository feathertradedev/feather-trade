import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.PLAYWRIGHT_WEB_PORT ?? "5176");
const baseURL = `http://127.0.0.1:${port}`;
const testReownProjectId = process.env.VITE_REOWN_PROJECT_ID ?? "public_wallet_project_0123456789";

export default defineConfig({
  testDir: "./e2e",
  testIgnore: ["localnet/**"],
  fullyParallel: true,
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]] : "list",
  timeout: 30_000,
  snapshotPathTemplate: "{testDir}/{testFilePath}-snapshots/{arg}-{platform}{ext}",
  expect: {
    timeout: 7_500
  },
  use: {
    baseURL,
    trace: "retain-on-failure"
  },
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${port}`,
    env: {
      VITE_ANALYTICS_LOCALNET_URL: "http://127.0.0.1:8787/graphql",
      VITE_REOWN_PROJECT_ID: testReownProjectId,
      VITE_WALLET_MODAL_OPEN_TIMEOUT_MS: "3000",
      VITE_WALLET_MODAL_READY_GRACE_MS: "0"
    },
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    url: baseURL
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 5"] }
    }
  ]
});
