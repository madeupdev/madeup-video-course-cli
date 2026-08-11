import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import type { CourseManifest } from '../../src/manifest/types.js';
import { loadManifest } from '../../src/manifest/load.js';

const validFixtureUrl = new URL(
  '../fixtures/manifests/valid.json',
  import.meta.url,
);
const temporaryDirectories: string[] = [];

async function temporaryFile(
  name: string,
  contents: string,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'course-manifest-test-'));
  temporaryDirectories.push(directory);
  const path = join(directory, name);
  await writeFile(path, contents, 'utf8');
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe('loadManifest', () => {
  it('loads and returns a validated manifest from an explicit file URL', async () => {
    const result = await loadManifest(validFixtureUrl);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('Expected manifest loading to succeed');
    }

    const manifest: CourseManifest = result.manifest;
    expect(manifest.courseVersion).toBe('1.0.0');
  });

  it('loads a validated manifest from an explicit file path', async () => {
    const result = await loadManifest(fileURLToPath(validFixtureUrl));

    expect(result.ok).toBe(true);
  });

  it('distinguishes malformed JSON with structured information', async () => {
    const path = await temporaryFile('malformed.json', '{"schemaVersion":');

    const result = await loadManifest(path);

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'json-syntax',
        path,
      },
    });
  });

  it('preserves manifest-validation issues for valid JSON', async () => {
    const path = await temporaryFile(
      'invalid.json',
      JSON.stringify({ schemaVersion: 2 }),
    );

    const result = await loadManifest(path);

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'manifest-validation',
        path,
      },
    });
    if (result.ok || result.error.kind !== 'manifest-validation') {
      throw new Error('Expected a manifest-validation error');
    }
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: '$.schemaVersion' }),
      ]),
    );
  });

  it('distinguishes a missing file without hiding the cause', async () => {
    const missingPath = join(
      tmpdir(),
      `missing-course-manifest-${crypto.randomUUID()}.json`,
    );

    const result = await loadManifest(missingPath);

    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: 'file-read',
        path: missingPath,
        code: 'ENOENT',
      },
    });
  });
});
