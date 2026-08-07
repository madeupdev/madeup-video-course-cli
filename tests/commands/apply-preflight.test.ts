import { spawnSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli } from '../../src/cli.js';
import type {
  CourseManifest,
  Recipe,
} from '../../src/manifest/types.js';
import { hashBytes } from '../../src/project/hash.js';

type TreeEntry = {
  path: string;
  kind: 'directory' | 'file' | 'symlink';
  mode: number;
  contents?: string;
  target?: string;
};

type Fixture = {
  root: string;
  projectRoot: string;
  sourceRoot: string;
  manifest: CourseManifest;
};

const temporaryDirectories: string[] = [];

const destinations = {
  add: 'apps/admin/src/app/titles-page.tsx',
  replace: 'apps/admin/src/app/app.tsx',
  delete: 'apps/admin/src/app/nx-welcome.tsx',
} as const;

const templates = {
  add: 'recipes/admin-ui/titles-page.tsx',
  replace: 'recipes/admin-ui/app.tsx',
} as const;

const contents = {
  addAfter: 'export const title = "Prepared titles";\n',
  replaceBefore: 'export const app = "Before";\n',
  replaceAfter: 'export const app = "After";\n',
  deleteBefore: 'export const welcome = "Remove me";\n',
} as const;

function hash(contentsToHash: string): string {
  return hashBytes(Buffer.from(contentsToHash));
}

function recipe(): Recipe {
  return {
    id: 'admin-ui',
    description: 'Install the prepared admin UI',
    expectedPackageName: '@madeup-video/storefront',
    startingState: 'before-admin-ui',
    resultState: 'after-admin-ui',
    operations: [
      {
        type: 'add',
        destination: destinations.add,
        template: templates.add,
        afterSha256: hash(contents.addAfter),
        mode: 0o644,
      },
      {
        type: 'replace',
        destination: destinations.replace,
        template: templates.replace,
        beforeSha256: hash(contents.replaceBefore),
        afterSha256: hash(contents.replaceAfter),
        mode: 0o755,
      },
      {
        type: 'delete',
        destination: destinations.delete,
        beforeSha256: hash(contents.deleteBefore),
      },
    ],
    verification: ['pnpm test'],
  };
}

function manifest(recipeValue: Recipe): CourseManifest {
  return {
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
    recipes: [recipeValue],
  };
}

function git(root: string, args: readonly string[]): void {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
}

async function createFixture(): Promise<Fixture> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'course-apply-preflight-')),
  );
  temporaryDirectories.push(root);
  const projectRoot = join(root, 'project');
  const sourceRoot = join(root, 'package');

  await mkdir(join(projectRoot, 'apps', 'admin', 'src', 'app'), {
    recursive: true,
  });
  await mkdir(join(sourceRoot, 'recipes', 'admin-ui'), { recursive: true });
  await writeFile(
    join(projectRoot, 'package.json'),
    `${JSON.stringify({ name: '@madeup-video/storefront' })}\n`,
  );
  await writeFile(join(projectRoot, destinations.replace), contents.replaceBefore);
  await chmod(join(projectRoot, destinations.replace), 0o644);
  await writeFile(join(projectRoot, destinations.delete), contents.deleteBefore);
  await chmod(join(projectRoot, destinations.delete), 0o755);
  await writeFile(join(sourceRoot, templates.add), contents.addAfter);
  await chmod(join(sourceRoot, templates.add), 0o600);
  await writeFile(join(sourceRoot, templates.replace), contents.replaceAfter);
  await chmod(join(sourceRoot, templates.replace), 0o600);

  git(projectRoot, ['init', '-q']);
  git(projectRoot, ['config', 'user.email', 'course@example.test']);
  git(projectRoot, ['config', 'user.name', 'Course Test']);
  git(projectRoot, ['config', 'commit.gpgsign', 'false']);
  git(projectRoot, ['add', '.']);
  git(projectRoot, ['commit', '-qm', 'fixture']);

  const recipeValue = recipe();
  return {
    root,
    projectRoot,
    sourceRoot,
    manifest: manifest(recipeValue),
  };
}

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
      } else if (entryStat.isSymbolicLink()) {
        entries.push({
          path: relativePath,
          kind: 'symlink',
          mode,
          target: await readlink(path),
        });
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

async function expectRefusalWithoutWrites(
  fixture: Fixture,
  recipeId = 'admin-ui',
): Promise<string[]> {
  const before = await snapshotTree(fixture.root);
  const stdout: string[] = [];
  const stderr: string[] = [];

  const exitCode = await runCli(
    ['apply', recipeId, '--dry-run'],
    {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    },
    {
      apply: {
        startDirectory: fixture.projectRoot,
        workingBoundary: fixture.projectRoot,
        sourceRoot: fixture.sourceRoot,
        manifest: fixture.manifest,
      },
    },
  );

  expect(exitCode).toBe(1);
  expect(stdout).toEqual([]);
  expect(await snapshotTree(fixture.root)).toEqual(before);
  return stderr;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe('apply preflight refusal safety', () => {
  it('refuses an unknown recipe without changing the fixture tree', async () => {
    const fixture = await createFixture();

    const errors = await expectRefusalWithoutWrites(fixture, 'unknown-recipe');

    expect(errors.join('\n')).toContain('Unknown recipe: unknown-recipe');
  });

  it('refuses the wrong package identity without changing the fixture tree', async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.projectRoot, 'package.json'),
      `${JSON.stringify({ name: '@madeup-video/not-the-storefront' })}\n`,
    );
    git(fixture.projectRoot, ['add', 'package.json']);
    git(fixture.projectRoot, ['commit', '-qm', 'wrong identity']);

    const errors = await expectRefusalWithoutWrites(fixture);

    expect(errors.join('\n')).toContain('Expected @madeup-video/storefront');
  });

  it('refuses a dirty Git worktree without changing the fixture tree', async () => {
    const fixture = await createFixture();
    await writeFile(
      join(fixture.projectRoot, destinations.replace),
      `${contents.replaceBefore}// dirty\n`,
    );

    const errors = await expectRefusalWithoutWrites(fixture);

    expect(errors.join('\n')).toContain('Git worktree must be clean');
  });

  it('refuses a before-hash mismatch without changing the fixture tree', async () => {
    const fixture = await createFixture();
    const replace = fixture.manifest.recipes[0]!.operations[1]!;
    if (replace.type !== 'replace') {
      throw new Error('Expected replace operation');
    }
    replace.beforeSha256 = '0'.repeat(64);

    const errors = await expectRefusalWithoutWrites(fixture);

    expect(errors.join('\n')).toContain('beforeSha256');
  });

  it('refuses an add destination that already exists without changing the fixture tree', async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.projectRoot, destinations.add), 'already here\n');
    git(fixture.projectRoot, ['add', '.']);
    git(fixture.projectRoot, ['commit', '-qm', 'existing add destination']);

    const errors = await expectRefusalWithoutWrites(fixture);

    expect(errors.join('\n')).toContain('Add destination already exists');
  });

  it('refuses a missing replace destination without changing the fixture tree', async () => {
    const fixture = await createFixture();
    await rm(join(fixture.projectRoot, destinations.replace));
    git(fixture.projectRoot, ['add', '.']);
    git(fixture.projectRoot, ['commit', '-qm', 'missing replace destination']);

    const errors = await expectRefusalWithoutWrites(fixture);

    expect(errors.join('\n')).toContain('Replace destination is missing');
  });

  it('refuses a missing delete destination without changing the fixture tree', async () => {
    const fixture = await createFixture();
    await rm(join(fixture.projectRoot, destinations.delete));
    git(fixture.projectRoot, ['add', '.']);
    git(fixture.projectRoot, ['commit', '-qm', 'missing delete destination']);

    const errors = await expectRefusalWithoutWrites(fixture);

    expect(errors.join('\n')).toContain('Delete destination is missing');
  });

  it('refuses a template digest mismatch without changing the fixture tree', async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.sourceRoot, templates.add), 'tampered template\n');

    const errors = await expectRefusalWithoutWrites(fixture);

    expect(errors.join('\n')).toContain('afterSha256');
  });

  it('refuses an unsafe destination path without changing the fixture tree', async () => {
    const fixture = await createFixture();
    fixture.manifest.recipes[0]!.operations[0]!.destination = '../outside.ts';

    const errors = await expectRefusalWithoutWrites(fixture);

    expect(errors.join('\n')).toContain('Unsafe destination path');
  });

  it('refuses an unsafe template path without changing the fixture tree', async () => {
    const fixture = await createFixture();
    const add = fixture.manifest.recipes[0]!.operations[0]!;
    if (add.type !== 'add') {
      throw new Error('Expected add operation');
    }
    add.template = '../outside.ts';

    const errors = await expectRefusalWithoutWrites(fixture);

    expect(errors.join('\n')).toContain('Unsafe template path');
  });

  it('refuses an unsafe symlinked template source without changing the fixture tree', async () => {
    const fixture = await createFixture();
    await rm(join(fixture.sourceRoot, 'recipes'), { recursive: true });
    await mkdir(join(fixture.sourceRoot, 'actual-recipes', 'admin-ui'), {
      recursive: true,
    });
    await writeFile(
      join(fixture.sourceRoot, 'actual-recipes', 'admin-ui', 'titles-page.tsx'),
      contents.addAfter,
    );
    await writeFile(
      join(fixture.sourceRoot, 'actual-recipes', 'admin-ui', 'app.tsx'),
      contents.replaceAfter,
    );
    await symlink('actual-recipes', join(fixture.sourceRoot, 'recipes'), 'dir');

    const errors = await expectRefusalWithoutWrites(fixture);

    expect(errors.join('\n')).toContain('Unsafe template source');
  });
});
