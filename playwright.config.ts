import { defineConfig, devices } from "@playwright/test";

const built = process.env.QUANTUM_ROYALE_E2E_BUILT === "1";
const port = Number(process.env.QUANTUM_ROYALE_E2E_PORT ?? 4185);
const basePath = process.env.QUANTUM_ROYALE_E2E_BASE_PATH ?? "/";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://127.0.0.1:${port}${basePath}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: built
      ? `pnpm exec vite preview --host 127.0.0.1 --port ${port} --strictPort --outDir dist-test`
      : `pnpm exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}${basePath}`,
    reuseExistingServer: built ? false : !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: "desktop-chromium",
      grep: /@desktop/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1600, height: 1000 },
      },
    },
    {
      name: "narrow-chromium",
      grep: /@narrow/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 412, height: 915 },
      },
    },
  ],
});
