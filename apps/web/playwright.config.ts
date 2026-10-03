import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run against the production build (`vite preview`), the same files GitHub Pages serves.
// Run `npm run build` first; `npm run test:e2e` does both.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: /screenshots\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, ...launchOptions() },
    },
    {
      // `npm run screenshots` regenerates the README images in docs/img.
      name: 'screenshots',
      testMatch: /screenshots\.spec\.ts/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2, colorScheme: 'light', ...launchOptions() },
    },
  ],
  webServer: {
    command: 'npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
  },
});

/** Lets a sandbox with a preinstalled Chromium skip `playwright install`. */
function launchOptions() {
  const executablePath = process.env.PW_CHROMIUM_PATH;
  return executablePath ? { launchOptions: { executablePath } } : {};
}
