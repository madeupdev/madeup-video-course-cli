import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    clearMocks: true,
    exclude: [...configDefaults.exclude, 'recipes/**/files/**'],
    restoreMocks: true,
    testTimeout: process.platform === 'win32' ? 15_000 : 5_000,
  },
});
