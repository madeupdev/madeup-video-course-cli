import { spawnSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../../src/cli.js';
import type { CourseManifest } from '../../src/manifest/types.js';
import { hashBytes } from '../../src/project/hash.js';

type TreeEntry = {
  path: string;
  kind: 'directory' | 'file';
  mode: number;
  contents?: string;
};

const temporaryDirectories: string[] = [];

async function snapshotTree(root: string): Promise<TreeEntry[]> {
  const entries: TreeEntry[] = [];

  async function visit(directory: string, relativeDirectory = ''): Promise<void> {
    const names = await readdir(directory);
    names.sort();
    for (const name of names) {
      const relativePath = relativeDirectory === ''
        ? name
        : `${relativeDirectory}/${name}`;
      const path = join(directory, name);
      const entryStat = await lstat(path);
      const mode = entryStat.mode & 0o777;
      if (entryStat.isDirectory()) {
        entries.push({ path: relativePath, kind: 'directory', mode });
        await visit(path, relativePath);
      } else if (entryStat.isFile()) {
        entries.push({
          path: relativePath,
          kind: 'file',
          mode,
          contents: (await readFile(path)).toString('base64'),
        });
      } else {
        throw new Error(`Unsupported fixture entry: ${relativePath}`);
      }
    }
  }

  await visit(root);
  return entries;
}

function git(root: string, args: readonly string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe('apply --dry-run', () => {
  it('prints a deterministic preview and leaves all bytes and modes unchanged', async () => {
    const root = await realpath(
      await mkdtemp(join(tmpdir(), 'course-apply-dry-run-')),
    );
    temporaryDirectories.push(root);
    const projectRoot = join(root, 'project');
    const sourceRoot = join(root, 'package');
    const addDestination = 'apps/admin/src/app/titles-page.tsx';
    const replaceDestination = 'apps/admin/src/app/app.tsx';
    const deleteDestination = 'apps/admin/src/app/nx-welcome.tsx';
    const addTemplate = 'recipes/admin-ui/titles-page.tsx';
    const replaceTemplate = 'recipes/admin-ui/app.tsx';
    const replaceBefore = 'export const app = "Before";\n';
    const replaceAfter = 'export const app = "After";\n';
    const deleteBefore = 'export const welcome = "Remove me";\n';
    const addAfter = 'export const title = "Prepared titles";\n';

    await mkdir(join(projectRoot, 'apps', 'admin', 'src', 'app'), {
      recursive: true,
    });
    await mkdir(join(sourceRoot, 'recipes', 'admin-ui'), { recursive: true });
    await writeFile(
      join(projectRoot, 'package.json'),
      `${JSON.stringify({ name: '@madeup-video/storefront' })}\n`,
    );
    await writeFile(join(projectRoot, replaceDestination), replaceBefore);
    await chmod(join(projectRoot, replaceDestination), 0o644);
    await writeFile(join(projectRoot, deleteDestination), deleteBefore);
    await chmod(join(projectRoot, deleteDestination), 0o755);
    await writeFile(join(sourceRoot, addTemplate), addAfter);
    await chmod(join(sourceRoot, addTemplate), 0o600);
    await writeFile(join(sourceRoot, replaceTemplate), replaceAfter);
    await chmod(join(sourceRoot, replaceTemplate), 0o600);

    git(projectRoot, ['init', '-q']);
    git(projectRoot, ['config', 'user.email', 'course@example.test']);
    git(projectRoot, ['config', 'user.name', 'Course Test']);
    git(projectRoot, ['config', 'commit.gpgsign', 'false']);
    git(projectRoot, ['add', '.']);
    git(projectRoot, ['commit', '-qm', 'fixture']);
    const staleTime = new Date('2000-01-01T00:00:00.000Z');
    await utimes(join(projectRoot, replaceDestination), staleTime, staleTime);

    const hash = (value: string) => hashBytes(Buffer.from(value));
    const manifest: CourseManifest = {
      schemaVersion: 1,
      courseVersion: '1.0.0',
      project: {
        packageName: '@madeup-video/storefront',
        repository: 'https://github.com/madeupdev/madeup-video-storefront',
        localArtifacts: [],
      },
      release: {
        repository: 'https://github.com/madeupdev/madeup-video-storefront',
        tag: 'course-v1.0.0',
        maxAssetBytes: 1024 * 1024,
      },
      recoveryStates: [
        {
          id: 'before-admin-ui',
          sourceCommit: 'a'.repeat(40),
          asset: 'before-admin-ui.tar.gz',
          sha256: 'b'.repeat(64),
          tree: { algorithm: 'course-tree-v1', files: [] },
          verification: ['pnpm test'],
        },
        {
          id: 'after-admin-ui',
          sourceCommit: 'c'.repeat(40),
          asset: 'after-admin-ui.tar.gz',
          sha256: 'd'.repeat(64),
          tree: { algorithm: 'course-tree-v1', files: [] },
          verification: ['pnpm test'],
        },
      ],
      recipes: [
        {
          id: 'admin-ui',
          description: 'Install the prepared admin UI',
          expectedPackageName: '@madeup-video/storefront',
          startingState: 'before-admin-ui',
          resultState: 'after-admin-ui',
          operations: [
            {
              type: 'delete',
              destination: deleteDestination,
              beforeSha256: hash(deleteBefore),
            },
            {
              type: 'add',
              destination: addDestination,
              template: addTemplate,
              afterSha256: hash(addAfter),
              mode: 0o644,
            },
            {
              type: 'replace',
              destination: replaceDestination,
              template: replaceTemplate,
              beforeSha256: hash(replaceBefore),
              afterSha256: hash(replaceAfter),
              mode: 0o755,
            },
          ],
          verification: ['pnpm test'],
        },
      ],
    };
    const before = await snapshotTree(root);
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCli(
      ['apply', 'admin-ui', '--dry-run'],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        apply: {
          startDirectory: projectRoot,
          workingBoundary: projectRoot,
          sourceRoot,
          manifest,
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join('\n')).toBe(
      [
        'ADD apps/admin/src/app/titles-page.tsx',
        'REPLACE apps/admin/src/app/app.tsx',
        'DELETE apps/admin/src/app/nx-welcome.tsx',
      ].join('\n'),
    );
    expect(await snapshotTree(root)).toEqual(before);
  });
});
