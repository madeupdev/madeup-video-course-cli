import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { inspectPackageTarball } from '../../scripts/inspect-pack.js';
import { tarGzip, type TarFixtureEntry } from '../recovery/tar-fixture.js';

const temporaryDirectories: string[] = [];
const expectedRecoveryContents = readFileSync(
  new URL('../../recovery/course-v1.0.0.json', import.meta.url),
);
const packageMetadata = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { files?: string[]; scripts?: Record<string, string> };
const expectedRuntimeModules = [
  'apply/plan',
  'apply/preflight',
  'apply/rollback',
  'apply/transaction',
  'cli',
  'commands/apply',
  'commands/doctor',
  'commands/recover',
  'manifest/load',
  'manifest/types',
  'manifest/validate',
  'path/portable',
  'project/find-root',
  'project/git',
  'project/hash',
  'project/inspect',
  'recovery/download',
  'recovery/extract',
  'recovery/pack',
  'recovery/register',
  'recovery/verify',
  'scripts/build-recovery-assets',
  'state/classify',
] as const;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

test('keeps replay fixtures out of packages and exposes the focused replay check', () => {
  expect(packageMetadata.files).toContain('recipes');
  expect(packageMetadata.files).toContain('!recipes/fixtures');
  expect(packageMetadata.scripts?.['test:replay']).toBe(
    'vitest run tests/replay/replay.test.ts',
  );
});

function validEntries(): TarFixtureEntry[] {
  return [
    {
      name: 'package/package.json',
      contents: JSON.stringify({
        name: '@madeup-video/course',
        version: '0.0.0-development',
        type: 'module',
        bin: { 'madeup-video-course': './dist/cli.js' },
      }),
    },
    { name: 'package/README.md', contents: '# Course CLI\n' },
    ...expectedRuntimeModules.map((moduleName) => ({
      name: `package/dist/${moduleName}.js`,
      contents: moduleName === 'cli' ? '#!/usr/bin/env node\n' : 'export {};\n',
      mode: moduleName === 'cli' ? 0o755 : 0o644,
    })),
    {
      name: 'package/recovery/course-v1.0.0.json',
      contents: expectedRecoveryContents,
    },
  ];
}

async function writeTarball(entries: readonly TarFixtureEntry[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'course-pack-inspector-'));
  temporaryDirectories.push(directory);
  const tarballPath = join(directory, 'course.tgz');
  await writeFile(tarballPath, tarGzip(entries));
  return tarballPath;
}

test('accepts a packed CLI with required runtime and recovery files', async () => {
  const tarballPath = await writeTarball(validEntries());

  const result = await inspectPackageTarball(tarballPath);

  expect(result.packageName).toBe('@madeup-video/course');
  expect(result.binPaths).toEqual(['package/dist/cli.js']);
  expect(result.files).toContain('package/recovery/course-v1.0.0.json');
});

describe.each([
  ['source file', { name: 'package/src/cli.ts', contents: 'export {};\n' }],
  ['test file', { name: 'package/tests/cli.test.js', contents: '' }],
  ['fixture', { name: 'package/fixtures/project.json', contents: '{}' }],
  ['recipe fixture', { name: 'package/recipes/fixtures/smoke/recipe.json', contents: '{}' }],
  ['environment file', { name: 'package/dist/.env.production', contents: 'TOKEN=x' }],
  ['credential file', { name: 'package/recovery/credentials.json', contents: '{}' }],
  ['secret file', { name: 'package/dist/client-secret.txt', contents: 'x' }],
  ['temporary archive', { name: 'package/recovery/leftover.tgz', contents: 'x' }],
  ['private delivery register', { name: 'package/course/delivery-states.json', contents: '{}' }],
])('forbidden package content: %s', (_label, forbiddenEntry) => {
  test(`rejects ${forbiddenEntry.name}`, async () => {
    const tarballPath = await writeTarball([...validEntries(), forbiddenEntry]);

    await expect(inspectPackageTarball(tarballPath)).rejects.toThrow(/forbidden|unexpected/iu);
  });
});

test.each([
  'package/../outside.txt',
  '/package/dist/absolute.js',
  'C:/package/dist/cli.js',
  'package/C:/dist/cli.js',
])(
  'rejects unsafe tar path %s',
  async (name) => {
    const tarballPath = await writeTarball([...validEntries(), { name, contents: 'x' }]);

    await expect(inspectPackageTarball(tarballPath)).rejects.toThrow(/unsafe tar path/iu);
  },
);

test('rejects a forbidden development-only directory entry', async () => {
  const tarballPath = await writeTarball([
    ...validEntries(),
    { name: 'package/src/', type: '5' },
  ]);

  await expect(inspectPackageTarball(tarballPath)).rejects.toThrow(/forbidden/iu);
});

test('rejects unmistakable credential material in an allowed runtime file', async () => {
  const entries = validEntries().map((entry) =>
    entry.name === 'package/dist/cli.js'
      ? { ...entry, contents: `#!/usr/bin/env node\nconst token = "ghp_${'a'.repeat(36)}";\n` }
      : entry,
  );
  const tarballPath = await writeTarball([
    ...entries,
  ]);

  await expect(inspectPackageTarball(tarballPath)).rejects.toThrow(/credential|secret/iu);
});

test('rejects NUL bytes in expected text files instead of skipping scans', async () => {
  const entries = validEntries().map((entry) =>
    entry.name === 'package/dist/cli.js'
      ? { ...entry, contents: Buffer.from('#!/usr/bin/env node\n\0hidden\n') }
      : entry,
  );
  const tarballPath = await writeTarball(entries);

  await expect(inspectPackageTarball(tarballPath)).rejects.toThrow(/NUL|binary/iu);
});

test.each([
  '/opt/build/project',
  '/var/lib/runner/project',
  'D:\\work\\repository',
  '\\\\build-server\\share\\repository',
])('rejects additional embedded local path form %s', async (localPath) => {
  const entries = validEntries();
  entries.push({
    name: 'package/dist/cli.js.map',
    contents: JSON.stringify({ version: 3, sources: [localPath] }),
  });
  const tarballPath = await writeTarball(entries);

  await expect(inspectPackageTarball(tarballPath)).rejects.toThrow(/absolute local filesystem path/iu);
});

test.each([
  { name: 'package/recipes/debug.log', contents: 'debug' },
  { name: 'package/recovery/internal-debug.json', contents: '{}' },
  { name: 'package/dist/token.json', contents: '{}' },
])('rejects unexpected allowlist entry $name', async (unexpectedEntry) => {
  const tarballPath = await writeTarball([...validEntries(), unexpectedEntry]);

  await expect(inspectPackageTarball(tarballPath)).rejects.toThrow(/unexpected/iu);
});

test('rejects corrupt public recovery data at the expected path', async () => {
  const entries = validEntries().map((entry) =>
    entry.name === 'package/recovery/course-v1.0.0.json'
      ? { ...entry, contents: '{}\n' }
      : entry,
  );
  const tarballPath = await writeTarball(entries);

  await expect(inspectPackageTarball(tarballPath)).rejects.toThrow(/public recovery data/iu);
});

test.each(['/Users/developer/course', '/home/developer/course', 'C:\\Users\\dev\\course'])(
  'rejects embedded absolute local path %s',
  async (localPath) => {
    const entries = validEntries();
    entries.push({
      name: 'package/dist/cli.js.map',
      contents: JSON.stringify({ version: 3, sources: [localPath] }),
    });
    const tarballPath = await writeTarball(entries);

    await expect(inspectPackageTarball(tarballPath)).rejects.toThrow(/absolute local filesystem path/iu);
  },
);

test('rejects a missing executable referenced by package.json', async () => {
  const entries = validEntries().filter((entry) => entry.name !== 'package/dist/cli.js');
  const tarballPath = await writeTarball(entries);

  await expect(inspectPackageTarball(tarballPath)).rejects.toThrow(/bin.*missing/iu);
});

test('rejects a missing compiled runtime command module', async () => {
  const entries = validEntries().filter(
    (entry) => entry.name !== 'package/dist/commands/apply.js',
  );
  const tarballPath = await writeTarball(entries);

  await expect(inspectPackageTarball(tarballPath)).rejects.toThrow(
    /required runtime file.*commands\/apply\.js.*missing/iu,
  );
});
