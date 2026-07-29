import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  inspectProjectFile,
  resolveProjectPath,
} from '../../src/project/inspect.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), prefix)),
  );
  temporaryDirectories.push(directory);
  return directory;
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

describe('resolveProjectPath', () => {
  it.each([
    ['', 'empty-path'],
    ['/absolute/file', 'absolute-posix-path'],
    ['C:\\absolute\\file', 'windows-drive-path'],
    ['C:/absolute/file', 'windows-drive-path'],
    ['\\\\server\\share\\file', 'leading-backslash-path'],
    ['\\rooted\\file', 'leading-backslash-path'],
    ['apps\\admin\\file.ts', 'backslash-separator'],
    ['apps//admin/file.ts', 'empty-segment'],
    ['apps/admin/', 'empty-segment'],
    ['./apps/admin/file.ts', 'current-directory-segment'],
    ['apps/./admin/file.ts', 'current-directory-segment'],
    ['../outside', 'parent-directory-segment'],
    ['apps/admin/../../../outside', 'parent-directory-segment'],
  ])('rejects %j as %s', async (relativePath, reason) => {
    const root = await temporaryDirectory('course-project-unsafe-path-');

    const result = await resolveProjectPath(root, relativePath);

    expect(result).toMatchObject({
      ok: false,
      finding: {
        kind: 'unsafe-repository-path',
        relativePath,
        reason,
      },
    });
  });

  it('allows an ordinary repository-relative path inside the root', async () => {
    const root = await temporaryDirectory('course-project-safe-path-');
    await mkdir(join(root, 'apps', 'admin'), { recursive: true });

    const result = await resolveProjectPath(
      root,
      'apps/admin/new-file.ts',
    );

    expect(result).toEqual({
      ok: true,
      projectRoot: root,
      relativePath: 'apps/admin/new-file.ts',
      path: join(root, 'apps', 'admin', 'new-file.ts'),
    });
  });

  it('distinguishes an inaccessible project root', async () => {
    const parent = await temporaryDirectory('course-project-missing-root-');
    const missingRoot = join(parent, 'missing');

    const result = await resolveProjectPath(
      missingRoot,
      'apps/admin/file.ts',
    );

    expect(result).toMatchObject({
      ok: false,
      finding: {
        kind: 'project-root-inaccessible',
        projectRoot: missingRoot,
        code: 'ENOENT',
      },
    });
  });

  it('rejects a symlink parent that points outside the project', async () => {
    const root = await temporaryDirectory('course-project-link-root-');
    const outside = await temporaryDirectory('course-project-link-outside-');
    const link = join(root, 'linked');
    if (!(await tryCreateDirectorySymlink(outside, link))) {
      return;
    }

    const result = await resolveProjectPath(root, 'linked/secret.txt');

    expect(result).toMatchObject({
      ok: false,
      finding: {
        kind: 'symlink-component',
        relativePath: 'linked/secret.txt',
        component: 'linked',
        path: link,
      },
    });
  });

  it('rejects symlink traversal even when the target remains inside the project', async () => {
    const root = await temporaryDirectory('course-project-internal-link-');
    const target = join(root, 'packages', 'shared');
    const link = join(root, 'shared-link');
    await mkdir(target, { recursive: true });
    if (!(await tryCreateDirectorySymlink(target, link))) {
      return;
    }

    const result = await resolveProjectPath(
      root,
      'shared-link/future-file.ts',
    );

    expect(result).toMatchObject({
      ok: false,
      finding: {
        kind: 'symlink-component',
        component: 'shared-link',
      },
    });
  });

  it('rejects an existing final-file symlink before inspection', async () => {
    const root = await temporaryDirectory('course-project-final-link-');
    const target = join(root, 'target.txt');
    const link = join(root, 'alias.txt');
    await writeFile(target, 'contents', 'utf8');
    try {
      await symlink(target, link, 'file');
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        ['EACCES', 'EPERM', 'ENOTSUP'].includes(String(error.code))
      ) {
        return;
      }
      throw error;
    }

    const result = await inspectProjectFile(root, 'alias.txt');

    expect(result).toMatchObject({
      ok: false,
      finding: {
        kind: 'symlink-component',
        component: 'alias.txt',
      },
    });
  });
});
