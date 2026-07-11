import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

const webRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(webRoot, "../..");
const artifactDir = process.env.E2E_BROWSER_ARTIFACT_DIR ?? resolve(repositoryRoot, ".local/browser-e2e");
const port = Number(process.env.E2E_BROWSER_WEB_PORT ?? "5276");

export default defineConfig({
  testDir: "./e2e/localnet",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: {
    timeout: 15_000
  },
  outputDir: resolve(artifactDir, "test-results"),
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: resolve(artifactDir, "playwright-report") }]
  ],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure"
  },
  webServer: {
    command: `pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    reuseExistingServer: false,
    timeout: 60_000,
    url: `http://127.0.0.1:${port}`
  },
  projects: [
    {
      name: "localnet-chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
