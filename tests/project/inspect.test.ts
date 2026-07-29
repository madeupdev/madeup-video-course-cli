import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { findProjectRoot } from '../../src/project/find-root.js';
import { hashBytes } from '../../src/project/hash.js';
import { inspectProjectFile } from '../../src/project/inspect.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function writePackage(
  directory: string,
  value: unknown,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify(value),
    'utf8',
  );
}

async function tryCreateDirectorySymlink(
  target: string,
  path: string,
): Promise<boolean> {
  try {
    await symlink(
      target,
      path,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      ['EACCES', 'EPERM', 'ENOTSUP'].includes(String(error.code))
    ) {
      return false;
    }
    throw error;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe('findProjectRoot', () => {
  it('walks upward and accepts the nearest expected package', async () => {
    const boundary = await temporaryDirectory('course-project-root-');
    const project = join(boundary, 'storefront');
    const start = join(project, 'apps', 'admin');
    await writePackage(project, {
      name: '@madeup-video/storefront',
    });
    await mkdir(start, { recursive: true });

    const result = await findProjectRoot(start, boundary);

    expect(result).toEqual({
      ok: true,
      root: await realpath(project),
      packageJsonPath: join(await realpath(project), 'package.json'),
      packageName: '@madeup-video/storefront',
    });
  });

  it('allows the working boundary itself to be the project root', async () => {
    const boundary = await temporaryDirectory('course-project-boundary-');
    await writePackage(boundary, {
      name: '@madeup-video/storefront',
    });

    const result = await findProjectRoot(boundary, boundary);

    expect(result).toMatchObject({
      ok: true,
      root: await realpath(boundary),
    });
  });

  it('reports when no package manifest exists within the boundary', async () => {
    const boundary = await temporaryDirectory('course-project-missing-');
    const start = join(boundary, 'apps', 'admin');
    await mkdir(start, { recursive: true });

    const result = await findProjectRoot(start, boundary);

    expect(result).toMatchObject({
      ok: false,
      finding: {
        kind: 'package-manifest-not-found',
        start: await realpath(start),
        boundary: await realpath(boundary),
      },
    });
  });

  it('reports malformed JSON at the nearest package candidate', async () => {
    const boundary = await temporaryDirectory('course-project-malformed-');
    const candidateRoot = join(boundary, 'storefront');
    const start = join(candidateRoot, 'apps');
    await mkdir(start, { recursive: true });
    await writeFile(
      join(candidateRoot, 'package.json'),
      '{"name":',
      'utf8',
    );

    const result = await findProjectRoot(start, boundary);

    expect(result).toMatchObject({
      ok: false,
      finding: {
        kind: 'malformed-package-json',
        candidateRoot: await realpath(candidateRoot),
      },
    });
  });

  it.each([null, [], 'package', { version: '1.0.0' }, { name: 42 }])(
    'reports an invalid package object for %j',
    async (packageValue) => {
      const boundary = await temporaryDirectory(
        'course-project-invalid-package-',
      );
      const candidateRoot = join(boundary, 'storefront');
      const start = join(candidateRoot, 'apps');
      await writePackage(candidateRoot, packageValue);
      await mkdir(start, { recursive: true });

      const result = await findProjectRoot(start, boundary);

      expect(result).toMatchObject({
        ok: false,
        finding: {
          kind: 'invalid-package-object',
          candidateRoot: await realpath(candidateRoot),
        },
      });
    },
  );

  it('reports the nearest wrong package instead of selecting a valid ancestor', async () => {
    const boundary = await temporaryDirectory('course-project-wrong-name-');
    const candidateRoot = join(boundary, 'nested');
    const start = join(candidateRoot, 'apps');
    await writePackage(boundary, {
      name: '@madeup-video/storefront',
    });
    await writePackage(candidateRoot, {
      name: '@madeup-video/unrelated',
    });
    await mkdir(start, { recursive: true });

    const result = await findProjectRoot(start, boundary);

    expect(result).toMatchObject({
      ok: false,
      finding: {
        kind: 'wrong-package-name',
        candidateRoot: await realpath(candidateRoot),
        actualPackageName: '@madeup-video/unrelated',
        expectedPackageName: '@madeup-video/storefront',
      },
    });
  });

  it('rejects a start directory whose canonical path is outside the boundary', async () => {
    const boundary = await temporaryDirectory('course-project-inside-');
    const outside = await temporaryDirectory('course-project-outside-');
    await writePackage(outside, {
      name: '@madeup-video/storefront',
    });

    const result = await findProjectRoot(outside, boundary);

    expect(result).toMatchObject({
      ok: false,
      finding: {
        kind: 'start-outside-boundary',
        start: await realpath(outside),
        boundary: await realpath(boundary),
      },
    });
  });

  it('cannot use a symlink alias to move the start outside the boundary', async () => {
    const boundary = await temporaryDirectory('course-project-link-boundary-');
    const outside = await temporaryDirectory('course-project-link-outside-');
    const alias = join(boundary, 'linked-project');
    await writePackage(outside, {
      name: '@madeup-video/storefront',
    });
    if (!(await tryCreateDirectorySymlink(outside, alias))) {
      return;
    }

    const result = await findProjectRoot(alias, boundary);

    expect(result).toMatchObject({
      ok: false,
      finding: {
        kind: 'start-outside-boundary',
        start: await realpath(outside),
        boundary: await realpath(boundary),
      },
    });
  });

  it('canonicalizes a boundary alias without changing its safety semantics', async () => {
    const parent = await temporaryDirectory('course-project-alias-parent-');
    const boundary = join(parent, 'real-boundary');
    const boundaryAlias = join(parent, 'boundary-alias');
    const start = join(boundary, 'apps');
    await writePackage(boundary, {
      name: '@madeup-video/storefront',
    });
    await mkdir(start, { recursive: true });
    if (!(await tryCreateDirectorySymlink(boundary, boundaryAlias))) {
      return;
    }

    const result = await findProjectRoot(
      join(boundaryAlias, 'apps'),
      boundaryAlias,
    );

    expect(result).toMatchObject({
      ok: true,
      root: await realpath(boundary),
    });
  });

  it('reports inaccessible start and boundary paths structurally', async () => {
    const parent = await temporaryDirectory('course-project-inaccessible-');
    const missingStart = join(parent, 'missing-start');
    const missingBoundary = join(parent, 'missing-boundary');

    await expect(
      findProjectRoot(missingStart, parent),
    ).resolves.toMatchObject({
      ok: false,
      finding: {
        kind: 'path-inaccessible',
        role: 'start',
        path: missingStart,
        code: 'ENOENT',
      },
    });
    await expect(
      findProjectRoot(parent, missingBoundary),
    ).resolves.toMatchObject({
      ok: false,
      finding: {
        kind: 'path-inaccessible',
        role: 'boundary',
        path: missingBoundary,
        code: 'ENOENT',
      },
    });
  });
});

describe('project file fingerprints', () => {
  it('hashes known raw bytes with SHA-256', () => {
    expect(hashBytes(Buffer.from('hello'))).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    );
  });

  it('hashes binary data without decoding or line-ending normalization', async () => {
    const root = await temporaryDirectory('course-project-binary-');
    const bytes = Uint8Array.from([0, 255, 128, 13, 10, 0, 65]);
    await writeFile(join(root, 'binary.dat'), bytes);

    const result = await inspectProjectFile(root, 'binary.dat');

    expect(result).toMatchObject({
      ok: true,
      file: {
        relativePath: 'binary.dat',
        sha256:
          '3d1245b47763d9ebf86aa9059e473585ecd2975dc1ea655b8e9f9c98f76d1ed5',
        size: bytes.byteLength,
      },
    });
  });

  it('changes the fingerprint when any byte changes', () => {
    expect(hashBytes(Uint8Array.from([0, 1, 2]))).not.toBe(
      hashBytes(Uint8Array.from([0, 1, 3])),
    );
  });

  it('distinguishes missing files and directories from fingerprints', async () => {
    const root = await temporaryDirectory('course-project-file-kinds-');
    await mkdir(join(root, 'directory'));

    await expect(
      inspectProjectFile(root, 'missing.txt'),
    ).resolves.toMatchObject({
      ok: false,
      finding: {
        kind: 'missing-file',
        relativePath: 'missing.txt',
      },
    });
    await expect(
      inspectProjectFile(root, 'directory'),
    ).resolves.toMatchObject({
      ok: false,
      finding: {
        kind: 'not-a-file',
        relativePath: 'directory',
      },
    });
  });

  it('distinguishes an inaccessible file when the platform enforces its mode', async () => {
    if (process.platform === 'win32') {
      return;
    }

    const root = await temporaryDirectory('course-project-file-access-');
    const file = join(root, 'private.txt');
    await writeFile(file, 'private', 'utf8');
    await chmod(file, 0);

    const result = await inspectProjectFile(root, 'private.txt');
    await chmod(file, 0o600);

    if (result.ok) {
      // Privileged test users can retain read access despite mode 000.
      expect(await readFile(file, 'utf8')).toBe('private');
      return;
    }
    expect(result).toMatchObject({
      ok: false,
      finding: {
        kind: 'file-inaccessible',
        relativePath: 'private.txt',
        code: 'EACCES',
      },
    });
  });
});
