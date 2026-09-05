import { defineConfig, devices } from '@playwright/test';
import { testDatabaseUrl } from '../../tests/helpers/environment.ts';

function readPort(name: 'ADMIN_PORT' | 'API_PORT', fallback: number): number {
  const rawPort = process.env[name] ?? String(fallback);
  const port = Number(rawPort);

  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer from 1 through 65535; received ${rawPort}.`);
  }

  return port;
}

const apiPort = readPort('API_PORT', 3333);
const adminPort = readPort('ADMIN_PORT', 3200);
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const adminOrigin = `http://127.0.0.1:${adminPort}`;
const serverEnvironment = {
  ADMIN_URL: adminOrigin,
  DATABASE_URL: testDatabaseUrl,
  TEST_DATABASE_URL: testDatabaseUrl,
};

export default defineConfig({
  testDir: './src',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  use: {
    baseURL: adminOrigin,
    ...devices['Desktop Chrome'],
  },
  webServer: [
    {
      command: 'pnpm exec nx run @madeup-video/api:dev',
      cwd: '../..',
      env: {
        ...serverEnvironment,
        API_PORT: String(apiPort),
      },
      gracefulShutdown: {
        signal: 'SIGTERM',
        timeout: 5_000,
      },
      reuseExistingServer: false,
      timeout: 120_000,
      url: `${apiOrigin}/api/health`,
    },
    {
      command: `pnpm exec nx run @madeup-video/admin:dev -- --port=${adminPort}`,
      cwd: '../..',
      env: {
        ...serverEnvironment,
        VITE_API_URL: apiOrigin,
      },
      gracefulShutdown: {
        signal: 'SIGTERM',
        timeout: 5_000,
      },
      reuseExistingServer: false,
      timeout: 120_000,
      url: adminOrigin,
    },
  ],
});
