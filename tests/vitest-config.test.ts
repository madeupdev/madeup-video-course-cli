import { describe, expect, it } from 'vitest';

import vitestConfig from '../vitest.config.js';

describe('Vitest timeout policy', () => {
  it('allows slower Windows filesystem and Git operations without relaxing other platforms', () => {
    const config = vitestConfig as { test?: { testTimeout?: number } };

    expect(config.test?.testTimeout).toBe(process.platform === 'win32' ? 15_000 : 5_000);
  });
});
