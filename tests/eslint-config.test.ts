import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

describe('ESLint packaging boundary', () => {
  it('does not lint packaged recipe templates as CLI source', async () => {
    const source = await readFile(
      new URL('../eslint.config.mjs', import.meta.url),
      'utf8',
    );

    expect(source).toContain("'recipes/**/files/**'");
  });
});
