import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, expect, test } from 'vitest';

import {
  assertReleaseVersion,
  createBundleChecksums,
  expectedPackedTarballName,
  expectedTarballName,
  registryIntegrity,
  parseReleaseTag,
  selectExactTarball,
  validateUpstreamRun,
  validateRegistryEvidence,
  verifyBundleChecksums,
} from '../../scripts/release.js';

const temporaryDirectories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'course-release-'));
  temporaryDirectories.push(directory);
  return directory;
}

test.each([
  ['v0.0.0', '0.0.0'],
  ['v1.2.3', '1.2.3'],
  ['v999.42.7', '999.42.7'],
])('accepts exact release tag %s', (tag, version) => {
  expect(parseReleaseTag(tag)).toBe(version);
});

test('runs the release validator through native Node as workflows do', async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['scripts/release.ts', 'validate-tag', 'v1.2.3', '1.2.3'],
    { cwd: new URL('../..', import.meta.url) },
  );

  expect(stdout).toBe('1.2.3\n');
});

test.each([
  '1.2.3',
  'v1.2',
  'v1.2.3.4',
  'v01.2.3',
  'v1.02.3',
  'v1.2.03',
  'v1.2.3-beta.1',
  'v1.2.3+build',
  'prefix-v1.2.3',
  'v1x2x3',
])('rejects non-release tag %s', (tag) => {
  expect(() => parseReleaseTag(tag)).toThrow(/exact SemVer release tag/iu);
});

test('requires package version to equal the tag and rejects development versions', () => {
  expect(assertReleaseVersion('v1.2.3', '1.2.3')).toBe('1.2.3');
  expect(() => assertReleaseVersion('v1.2.3', '1.2.4')).toThrow(/does not match/iu);
  expect(() => assertReleaseVersion('v0.0.0', '0.0.0-development')).toThrow(/does not match/iu);
});

test('derives the npm tarball name without accepting unsafe package metadata', () => {
  expect(expectedTarballName('@madeup-video/course', '1.2.3')).toBe(
    'madeup-video-course-1.2.3.tgz',
  );
  expect(() => expectedTarballName('../course', '1.2.3')).toThrow(/package name/iu);
});

test('derives a safe development tarball name for non-publishing dry runs', () => {
  expect(expectedPackedTarballName('@madeup-video/course', '0.0.0-development')).toBe(
    'madeup-video-course-0.0.0-development.tgz',
  );
  expect(() => expectedPackedTarballName('@madeup-video/course', '../latest')).toThrow(
    /package version/iu,
  );
});

test('selects exactly the expected single tarball', () => {
  expect(
    selectExactTarball(
      ['madeup-video-course-1.2.3.tgz'],
      '@madeup-video/course',
      '1.2.3',
    ),
  ).toBe('madeup-video-course-1.2.3.tgz');
  expect(() =>
    selectExactTarball(
      ['madeup-video-course-1.2.3.tgz', 'other-1.2.3.tgz'],
      '@madeup-video/course',
      '1.2.3',
    ),
  ).toThrow(/exactly one/iu);
  expect(() =>
    selectExactTarball(['wrong-1.2.3.tgz'], '@madeup-video/course', '1.2.3'),
  ).toThrow(/expected tarball/iu);
});

test('creates and verifies a single portable SHA256SUMS record', async () => {
  const directory = await temporaryDirectory();
  const filename = 'madeup-video-course-1.2.3.tgz';
  const contents = Buffer.from('exact archive bytes');
  await writeFile(join(directory, filename), contents);

  const checksumPath = await createBundleChecksums(directory, filename);
  const expectedHash = createHash('sha256').update(contents).digest('hex');
  expect(await readFile(checksumPath, 'utf8')).toBe(`${expectedHash}  ${filename}\n`);
  await expect(verifyBundleChecksums(directory, filename)).resolves.toBe(expectedHash);

  await writeFile(join(directory, filename), 'changed');
  await expect(verifyBundleChecksums(directory, filename)).rejects.toThrow(/checksum/iu);
});

test('rejects checksum records that name paths or extra artifacts', async () => {
  const directory = await temporaryDirectory();
  const filename = 'madeup-video-course-1.2.3.tgz';
  await mkdir(join(directory, 'nested'));
  await writeFile(join(directory, filename), 'archive');
  await writeFile(
    join(directory, 'SHA256SUMS'),
    `${'0'.repeat(64)}  nested/${filename}\n${'1'.repeat(64)}  other.tgz\n`,
  );

  await expect(verifyBundleChecksums(directory, filename)).rejects.toThrow(/single checksum/iu);
});

test('accepts only the successful tag-push Publish run from this repository', () => {
  const trusted = {
    workflowName: 'Publish',
    event: 'push',
    conclusion: 'success',
    repository: 'madeupdev/madeup-video-course-cli',
    headBranch: 'v1.2.3',
    headSha: 'a'.repeat(40),
    runId: 123,
  } as const;

  expect(validateUpstreamRun(trusted)).toEqual({
    tag: 'v1.2.3',
    version: '1.2.3',
    headSha: 'a'.repeat(40),
    runId: 123,
  });
  for (const mutation of [
    { workflowName: 'CI' },
    { event: 'workflow_dispatch' },
    { conclusion: 'failure' },
    { repository: 'attacker/fork' },
    { headBranch: 'not-a-tag' },
    { headSha: 'main' },
    { runId: 0 },
  ]) {
    expect(() => validateUpstreamRun({ ...trusted, ...mutation })).toThrow();
  }
});

test('matches registry integrity and requires npm provenance evidence', () => {
  const tarball = Buffer.from('published archive');
  const integrity = registryIntegrity(tarball);
  expect(integrity).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/u);

  expect(
    validateRegistryEvidence(tarball, {
      integrity,
      attestations: {
        url: 'https://registry.npmjs.org/-/npm/v1/attestations/%40madeup-video%2Fcourse@1.2.3',
        provenance: { predicateType: 'https://slsa.dev/provenance/v1' },
      },
    }),
  ).toEqual({
    integrity,
    provenanceUrl:
      'https://registry.npmjs.org/-/npm/v1/attestations/%40madeup-video%2Fcourse@1.2.3',
  });

  expect(() => validateRegistryEvidence(tarball, { integrity: 'sha512-wrong' })).toThrow(
    /integrity/iu,
  );
  expect(() => validateRegistryEvidence(tarball, { integrity })).toThrow(/provenance/iu);
});
