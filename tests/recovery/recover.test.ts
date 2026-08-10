import { createServer } from 'node:http';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../../src/cli.js';
import { runRecover } from '../../src/commands/recover.js';
import type { CourseManifest, CourseTreeFile } from '../../src/manifest/types.js';
import { hashBytes } from '../../src/project/hash.js';
import { tarGzip, type TarFixtureEntry } from './tar-fixture.js';

const temporaryDirectories: string[] = [];
const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

function expectedFile(path: string, contents: string, mode: 0o644 | 0o755): CourseTreeFile {
  return { path, mode, sha256: hashBytes(Buffer.from(contents)) };
}

const expectedTree = [
  expectedFile('package.json', '{"name":"@madeup-video/storefront"}\n', 0o644),
  expectedFile('scripts/verify.sh', '#!/bin/sh\necho verified\n', 0o755),
];

const validEntries: TarFixtureEntry[] = [
  { name: 'package.json', contents: '{"name":"@madeup-video/storefront"}\n', mode: 0o644 },
  { name: 'scripts/', type: '5', mode: 0o755 },
  { name: 'scripts/verify.sh', contents: '#!/bin/sh\necho verified\n', mode: 0o755 },
];

async function recoveryFixture(entries: readonly TarFixtureEntry[] = validEntries) {
  const root = await mkdtemp(join(tmpdir(), 'course-recover-'));
  temporaryDirectories.push(root);
  const asset = tarGzip(entries);
  const requestedPaths: string[] = [];
  const server = createServer((request, response) => {
    requestedPaths.push(request.url ?? '');
    if (request.url === '/owner/project/releases/download/course-v1.0.0/fixture-start.tar.gz') {
      response.writeHead(200, { 'content-type': 'application/gzip' });
      response.end(asset);
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected TCP server');
  const manifest: CourseManifest = {
    schemaVersion: 1,
    courseVersion: '1.0.0',
    project: {
      packageName: '@madeup-video/storefront',
      repository: 'https://github.com/owner/project',
      localArtifacts: [],
    },
    release: {
      repository: `http://127.0.0.1:${address.port}/owner/project`,
      tag: 'course-v1.0.0',
      maxAssetBytes: 1024 * 1024,
    },
    recoveryStates: [{
      id: 'fixture-start',
      sourceCommit: 'a'.repeat(40),
      asset: 'fixture-start.tar.gz',
      sha256: hashBytes(asset),
      tree: { algorithm: 'course-tree-v1', files: structuredClone(expectedTree) },
      verification: ['pnpm test'],
    }],
    recipes: [],
  };
  return { root, destination: join(root, 'recovered'), manifest, requestedPaths };
}

async function expectCleanFailure(
  entries: readonly TarFixtureEntry[],
  mutateManifest: (manifest: CourseManifest) => void = () => undefined,
): Promise<string> {
  const fixture = await recoveryFixture(entries);
  mutateManifest(fixture.manifest);
  const stderr: string[] = [];
  const result = await runRecover('fixture-start', {
    manifest: fixture.manifest,
    destination: fixture.destination,
    platform: process.platform,
  }, { stdout: () => undefined, stderr: (line) => stderr.push(line) });

  expect(result.exitCode).toBe(1);
  await expect(lstat(fixture.destination)).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await readdir(fixture.root)).filter((name) => name !== basename(fixture.destination))).toEqual([]);
  return stderr.join('\n');
}

describe('recover command', () => {
  it('requests the exact immutable release-asset URL derived from the manifest', async () => {
    const fixture = await recoveryFixture();

    await runRecover('fixture-start', {
      manifest: fixture.manifest,
      destination: fixture.destination,
      platform: process.platform,
    }, { stdout: () => undefined, stderr: () => undefined });

    expect(fixture.requestedPaths).toEqual([
      '/owner/project/releases/download/course-v1.0.0/fixture-start.tar.gz',
    ]);
  });

  it.each([
    ['missing expected file', validEntries.slice(0, 1), () => undefined, /missing/i],
    ['unexpected file', [...validEntries, { name: 'unexpected.txt', contents: 'nope' }], () => undefined, /unexpected/i],
    ['unexpected empty directory', [...validEntries, { name: 'empty/', type: '5' }], () => undefined, /unexpected/i],
    ['modified bytes', [{ ...validEntries[0]!, contents: 'wrong' }, ...validEntries.slice(1)], () => undefined, /modified/i],
    ['wrong mode', validEntries, (manifest: CourseManifest) => { manifest.recoveryStates[0]!.tree.files[1]!.mode = 0o644; }, /mode/i],
    ['digest mismatch', validEntries, (manifest: CourseManifest) => { manifest.recoveryStates[0]!.sha256 = '0'.repeat(64); }, /digest mismatch/i],
    ['missing asset', validEntries, (manifest: CourseManifest) => { manifest.recoveryStates[0]!.asset = 'missing.tar.gz'; }, /404/i],
    ['declared maximum exceeded', validEntries, (manifest: CourseManifest) => { manifest.release.maxAssetBytes = 1; }, /maximum asset size/i],
    ['unsafe archive entry', [{ name: '../outside.txt', contents: 'nope' }], () => undefined, /unsafe recovery archive entry/i],
  ] as const)('removes every temporary and partial output after %s', async (_label, entries, mutate, message) => {
    expect(await expectCleanFailure(entries, mutate)).toMatch(message);
  });

  it('rejects a destination that already exists, including an empty directory', async () => {
    const fixture = await recoveryFixture();
    await mkdir(fixture.destination);

    const result = await runRecover('fixture-start', {
      manifest: fixture.manifest,
      destination: fixture.destination,
      platform: process.platform,
    }, { stdout: () => undefined, stderr: () => undefined });

    expect(result.exitCode).toBe(1);
    expect(await readdir(fixture.destination)).toEqual([]);
    expect(fixture.requestedPaths).toEqual([]);
  });

  it('rejects a CLI version that is not aligned with the course version', async () => {
    const fixture = await recoveryFixture();
    const result = await runRecover('fixture-start', {
      manifest: fixture.manifest,
      destination: fixture.destination,
      platform: process.platform,
      cliVersion: '2.0.0',
    }, { stdout: () => undefined, stderr: () => undefined });

    expect(result.exitCode).toBe(1);
    expect(fixture.requestedPaths).toEqual([]);
    expect(await readdir(fixture.root)).toEqual([]);
  });

  it('extracts and verifies the exact tree before publishing the destination', async () => {
    const fixture = await recoveryFixture();
    const stdout: string[] = [];
    const stderr: string[] = [];

    const result = await runRecover('fixture-start', {
      manifest: fixture.manifest,
      destination: fixture.destination,
      platform: process.platform,
    }, { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) });

    expect(stderr).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(await readFile(join(fixture.destination, 'package.json'), 'utf8')).toBe('{"name":"@madeup-video/storefront"}\n');
    expect((await lstat(join(fixture.destination, 'scripts/verify.sh'))).mode & 0o777).toBe(0o755);
    expect(await readdir(fixture.root)).toEqual(['recovered']);
    const output = stdout.join('\n');
    expect(output).toContain('Course version: 1.0.0');
    expect(output).toContain('CLI version: 1.0.0');
    expect(output).toContain(`Source commit: ${'a'.repeat(40)}`);
    expect(output).toContain(`Verified asset digest: ${fixture.manifest.recoveryStates[0]!.sha256}`);
    expect(output).toContain(
      `Destination: ${JSON.stringify(fixture.destination)}`,
    );
    expect(output).toContain(
      'From the recovered directory shown above, run:',
    );
    expect(output).toContain('pnpm install --frozen-lockfile');
    expect(output).toContain('pnpm test');
  });

  it('displays a shell-sensitive destination only as informational data', async () => {
    const fixture = await recoveryFixture();
    const destination = join(
      fixture.root,
      'recovered-$HOME-`whoami`-$(touch unexpected)',
    );
    const stdout: string[] = [];

    const result = await runRecover('fixture-start', {
      manifest: fixture.manifest,
      destination,
      platform: process.platform,
    }, { stdout: (line) => stdout.push(line), stderr: () => undefined });

    expect(result.exitCode).toBe(0);
    expect(stdout.filter((line) => line.includes(destination))).toEqual([
      `Destination: ${JSON.stringify(destination)}`,
    ]);
    const commandHeading = stdout.indexOf(
      'From the recovered directory shown above, run:',
    );
    expect(commandHeading).toBeGreaterThan(-1);
    expect(stdout.slice(commandHeading + 1)).toEqual([
      '  pnpm install --frozen-lockfile',
      'State verification:',
      '  pnpm test',
    ]);
    expect(stdout.join('\n')).not.toContain('  cd ');
  });

  it('routes recover <state> --directory <new-directory> through the CLI', async () => {
    const fixture = await recoveryFixture();
    const stderr: string[] = [];
    const exitCode = await runCli(
      ['recover', 'fixture-start', '--directory', fixture.destination],
      { stdout: () => undefined, stderr: (line) => stderr.push(line) },
      { recover: { manifest: fixture.manifest, platform: process.platform } },
    );

    expect(stderr).toEqual([]);
    expect(exitCode).toBe(0);
    expect(await readFile(join(fixture.destination, 'scripts/verify.sh'), 'utf8')).toContain('verified');
  });
});
