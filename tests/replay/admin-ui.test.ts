import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { CourseManifest, Recipe } from '../../src/manifest/types.js';
import { validateManifest } from '../../src/manifest/validate.js';
import { runCli } from '../../src/cli.js';
import {
  parseReplayArguments,
  replayGitEnvironment,
  replayRecipe,
} from '../../scripts/replay-recipes.js';


const startCommit = '139ed78d70cd5349bdc9fdf820aa14624460f3c7';
const resultCommit = 'fc93b35563ec9e4a30ca59e10436026d03dc61e6';
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const recipePath = join(repositoryRoot, 'recipes/admin-ui/recipe.json');
const historyBundlePath = join(repositoryRoot, 'tests/fixtures/admin-ui-history.bundle');
const realRecipeTestTimeout = process.platform === 'win32' ? 120_000 : 30_000;
const temporaryDirectories: string[] = [];
let bundledHistoryDirectory: string | undefined;

function git(repository: string, args: readonly string[], encoding: BufferEncoding | 'buffer' = 'utf8'): string | Buffer {
  const result = spawnSync('git', args, {
    cwd: repository,
    encoding: encoding === 'buffer' ? undefined : encoding,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1' },
  });
  if (result.status !== 0) throw new Error(String(result.stderr));
  return result.stdout as string | Buffer;
}

function discoverProjectRepository(): string | undefined {
  if (process.env.COURSE_PROJECT_REPOSITORY) return resolve(process.env.COURSE_PROJECT_REPOSITORY);
  return undefined;
}

let realProjectRepository = discoverProjectRepository();

function blob(repository: string, commit: string, path: string): Buffer {
  return git(repository, ['show', `${commit}:${path}`], 'buffer') as Buffer;
}

function mode(repository: string, commit: string, path: string): number {
  const listing = String(git(repository, ['ls-tree', commit, '--', path])).trim();
  const match = /^(100644|100755) blob [a-f0-9]+\t/u.exec(listing);
  if (!match) throw new Error(`Missing regular Git blob ${commit}:${path}`);
  return match[1] === '100755' ? 0o755 : 0o644;
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function changedPaths(repository: string): Array<{ path: string; type: 'add' | 'replace' }> {
  const output = String(git(repository, [
    'diff',
    '--name-status',
    '--no-renames',
    '-z',
    startCommit,
    resultCommit,
  ]));
  const fields = output.split('\0');
  if (fields.at(-1) === '') fields.pop();
  if (fields.length % 2 !== 0) throw new Error('Malformed NUL-delimited recipe delta');
  return Array.from({ length: fields.length / 2 }, (_, index) => {
    const status = fields[index * 2];
    const path = fields[index * 2 + 1];
    if (!path || (status !== 'A' && status !== 'M')) {
      throw new Error(`Unsupported recipe delta: ${String(status)} ${String(path)}`);
    }
    return { path, type: status === 'A' ? 'add' : 'replace' };
  });
}

function inPreparedBoundary(path: string): boolean {
  return path.startsWith('apps/admin/') ||
    path.startsWith('apps/admin-e2e/') ||
    path === 'apps/api/src/app/configure-api.ts' ||
    path === 'apps/api-e2e/src/api.spec.ts' ||
    path === 'eslint.config.mjs' ||
    path === 'tests/tooling/architecture-projects.test.mjs';
}

async function manifest(): Promise<CourseManifest> {
  return JSON.parse(await readFile(recipePath, 'utf8')) as CourseManifest;
}

function requireProjectRepository(): string {
  if (realProjectRepository === undefined) throw new Error('Real project history is unavailable');
  return realProjectRepository;
}

function projectState(repository: string): string {
  return [
    ['rev-parse', 'HEAD'],
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    ['diff', '--binary', '--no-ext-diff'],
    ['diff', '--cached', '--binary', '--no-ext-diff'],
    ['ls-files', '--stage', '-z'],
  ].map((args) => String(git(repository, args))).join('\n');
}

async function refusalFixture(): Promise<{
  manifest: CourseManifest;
  projectRoot: string;
  root: string;
  sourceRoot: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'admin-ui-refusal-'));
  temporaryDirectories.push(root);
  const projectRoot = join(root, 'project');
  const sourceRoot = join(root, 'package');
  git(root, ['clone', '--quiet', '--no-checkout', requireProjectRepository(), projectRoot]);
  git(projectRoot, ['checkout', '--quiet', '--detach', startCommit]);
  await mkdir(sourceRoot, { recursive: true });
  await cp(join(repositoryRoot, 'recipes'), join(sourceRoot, 'recipes'), { recursive: true });
  return { manifest: await manifest(), projectRoot, root, sourceRoot };
}

async function fixtureState(root: string): Promise<string> {
  const entries: Array<{
    path: string;
    kind: 'directory' | 'file' | 'symlink';
    mode: number;
    value?: string;
  }> = [];

  async function visit(directory: string, relativeDirectory = ''): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const path = relativeDirectory === '' ? name : `${relativeDirectory}/${name}`;
      const absolutePath = join(directory, name);
      const metadata = await lstat(absolutePath);
      const mode = metadata.mode & 0o777;
      if (metadata.isDirectory()) {
        entries.push({ path, kind: 'directory', mode });
        await visit(absolutePath, path);
      } else if (metadata.isFile()) {
        entries.push({
          path,
          kind: 'file',
          mode,
          value: (await readFile(absolutePath)).toString('base64'),
        });
      } else if (metadata.isSymbolicLink()) {
        entries.push({ path, kind: 'symlink', mode, value: await readlink(absolutePath) });
      } else {
        throw new Error(`Unsupported fixture entry: ${path}`);
      }
    }
  }

  await visit(root);
  return JSON.stringify(entries);
}

async function expectRefusalWithoutWrites(
  fixture: Awaited<ReturnType<typeof refusalFixture>>,
): Promise<string> {
  const beforeProject = projectState(fixture.projectRoot);
  const beforeFixture = await fixtureState(fixture.root);
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(
    ['apply', 'admin-ui', '--yes'],
    { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
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
  expect(projectState(fixture.projectRoot)).toBe(beforeProject);
  expect(await fixtureState(fixture.root)).toBe(beforeFixture);
  return stderr.join('\n');
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

beforeAll(async () => {
  if (realProjectRepository !== undefined) return;
  bundledHistoryDirectory = await mkdtemp(join(tmpdir(), 'admin-ui-history-'));
  realProjectRepository = join(bundledHistoryDirectory, 'project');
  git(bundledHistoryDirectory, ['clone', '--quiet', historyBundlePath, realProjectRepository]);
  git(realProjectRepository, ['checkout', '--quiet', '--detach', resultCommit]);
});

afterAll(async () => {
  if (bundledHistoryDirectory !== undefined) {
    await rm(bundledHistoryDirectory, { recursive: true, force: true });
  }
});

describe('real admin-ui recipe', () => {
  it('requires explicit closed private replay arguments and package entrypoint', async () => {
    const project = requireProjectRepository();
    const args = [
      '--manifest', recipePath,
      '--recipe', 'admin-ui',
      '--project-repository', project,
    ];
    expect(parseReplayArguments(args)).toEqual({
      manifestPath: recipePath,
      recipeId: 'admin-ui',
      sourceRepository: project,
    });
    expect(() => parseReplayArguments(args.slice(0, -1))).toThrow(/invalid replay arguments/iu);
    expect(() => parseReplayArguments([...args, '--recipe', 'admin-ui'])).toThrow(/invalid replay arguments/iu);
    expect(() => parseReplayArguments([...args, '--unknown', 'value'])).toThrow(/invalid replay arguments/iu);
    const packageJson = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    expect(packageJson.scripts).toMatchObject({
      replay: 'node --import tsx scripts/replay-recipes.ts',
      'test:replay': 'vitest run tests/replay',
    });
    const entrypoint = spawnSync(process.execPath, [
      '--import',
      'tsx',
      'scripts/replay-recipes.ts',
      ...args,
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { ...process.env, COURSE_PROJECT_REPOSITORY: project },
      timeout: realRecipeTestTimeout,
    });
    expect(entrypoint.status, entrypoint.stderr).toBe(0);
    expect(entrypoint.stderr).not.toMatch(/error|invalid/iu);
    expect(entrypoint.stdout).toContain('Replayed 13 prepared files');
  }, realRecipeTestTimeout);

  it('is a valid closed manifest for the exact S06-L02 to S06-L03 transition', async () => {
    const value = await manifest();
    expect(validateManifest(value)).toEqual({ ok: true, manifest: value });
    expect(value.recoveryStates.map(({ id, sourceCommit }) => ({ id, sourceCommit }))).toEqual([
      { id: 'S06-L02-start', sourceCommit: startCommit },
      { id: 'S06-L03-start', sourceCommit: resultCommit },
    ]);
    expect(value.recipes).toHaveLength(1);
    expect(value.recipes[0]).toMatchObject({
      id: 'admin-ui',
      startingState: 'S06-L02-start',
      resultState: 'S06-L03-start',
    });
  });

  it('keeps every prepared template byte-exact across Git platforms', async () => {
    expect(await readFile(join(repositoryRoot, '.gitattributes'), 'utf8'))
      .toContain('recipes/admin-ui/files/** -text');
  });

  it('mechanically matches every path, byte, hash, and Git mode in the exact full-SHA diff', async () => {
    const repository = requireProjectRepository();
    const value = await manifest();
    const recipe = value.recipes[0] as Recipe;
    const delta = changedPaths(repository);
    expect(delta).toHaveLength(13);
    expect(delta.filter(({ type }) => type === 'add')).toHaveLength(2);
    expect(new Set(delta.map(({ path }) => path)).size).toBe(delta.length);
    expect(delta.every(({ path }) => inPreparedBoundary(path))).toBe(true);
    expect(recipe.operations.map(({ destination }) => destination)).toEqual(delta.map(({ path }) => path));

    for (const [index, change] of delta.entries()) {
      const operation = recipe.operations[index]!;
      const after = blob(repository, resultCommit, change.path);
      expect(operation.type).toBe(change.type);
      if (operation.type === 'delete') throw new Error(`Unexpected delete operation: ${operation.destination}`);
      expect(operation.afterSha256).toBe(sha256(after));
      expect(operation.mode).toBe(mode(repository, resultCommit, change.path));
      if (operation.type === 'add' || operation.type === 'replace') {
        expect(await readFile(join(repositoryRoot, operation.template))).toEqual(after);
      }
      if (operation.type === 'replace') {
        expect(operation.beforeSha256).toBe(sha256(blob(repository, startCommit, change.path)));
      }
    }
  });

  it.each([
    ['native filesystem modes', undefined],
    ['Windows Git-index modes', 'win32' as const],
  ])('replays to the exact result tree and is idempotent with %s', async (_label, platform) => {
    const sourceRepository = requireProjectRepository();
    const sourceState = {
      head: String(git(sourceRepository, ['rev-parse', 'HEAD'])),
      status: String(git(sourceRepository, ['status', '--porcelain=v1', '-z'])),
    };
    const result = await replayRecipe({
      sourceRepository,
      sourceRoot: repositoryRoot,
      manifestPath: recipePath,
      recipeId: 'admin-ui',
      platform,
    });
    expect(result.firstApply.changedFiles).toEqual(changedPaths(requireProjectRepository()).map(({ path }) => path));
    expect(result.dryRunStdout).toHaveLength(13);
    expect(result.secondApply).toEqual({ kind: 'already-applied', changedFiles: [] });
    const effectivePlatform = platform ?? process.platform;
    expect(result.modeComparison).toBe(
      effectivePlatform === 'win32' ? 'git-index-projection' : 'native-filesystem',
    );
    expect({
      head: String(git(sourceRepository, ['rev-parse', 'HEAD'])),
      status: String(git(sourceRepository, ['status', '--porcelain=v1', '-z'])),
    }).toEqual(sourceState);
  }, realRecipeTestTimeout);

  it('refuses real dirty, wrong-project, mixed, missing, hash-mismatch, unsafe-path, and symlink cases without writes', async () => {
    const cases: Array<{
      label: string;
      expected: RegExp;
      mutate: (fixture: Awaited<ReturnType<typeof refusalFixture>>) => Promise<void>;
    }> = [
      {
        label: 'dirty',
        expected: /git worktree must be clean/iu,
        mutate: async ({ projectRoot }) => {
          await writeFile(join(projectRoot, 'apps/admin/src/app/app.tsx'), '// dirty\n', { flag: 'a' });
        },
      },
      {
        label: 'wrong-project',
        expected: /expected @madeup-video\/storefront/iu,
        mutate: async ({ projectRoot }) => {
          const path = join(projectRoot, 'package.json');
          const packageJson = JSON.parse(await readFile(path, 'utf8')) as { name: string };
          packageJson.name = '@madeup-video/not-the-storefront';
          await writeFile(path, `${JSON.stringify(packageJson, null, 2)}\n`);
          git(projectRoot, ['add', 'package.json']);
          git(projectRoot, ['-c', 'user.name=Recipe Test', '-c', 'user.email=recipe@example.test', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'wrong project']);
        },
      },
      {
        label: 'mixed',
        expected: /mixed/iu,
        mutate: async ({ projectRoot }) => {
          const path = 'apps/admin/src/app/app.tsx';
          await writeFile(join(projectRoot, path), blob(requireProjectRepository(), resultCommit, path));
          git(projectRoot, ['add', path]);
          git(projectRoot, ['-c', 'user.name=Recipe Test', '-c', 'user.email=recipe@example.test', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'mixed state']);
        },
      },
      {
        label: 'missing',
        expected: /replace destination is missing/iu,
        mutate: async ({ projectRoot }) => {
          const path = 'apps/admin/project.json';
          await rm(join(projectRoot, path));
          git(projectRoot, ['add', path]);
          git(projectRoot, ['-c', 'user.name=Recipe Test', '-c', 'user.email=recipe@example.test', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'missing destination']);
        },
      },
      {
        label: 'hash-mismatch',
        expected: /beforeSha256/iu,
        mutate: async ({ manifest: value }) => {
          const operation = value.recipes[0]!.operations.find(({ type }) => type === 'replace');
          if (operation?.type !== 'replace') throw new Error('Expected a replace operation');
          operation.beforeSha256 = '0'.repeat(64);
        },
      },
      {
        label: 'unsafe-path',
        expected: /unsafe destination path/iu,
        mutate: async ({ manifest: value }) => {
          value.recipes[0]!.operations[0]!.destination = '../outside.ts';
        },
      },
      {
        label: 'symlink',
        expected: /unsafe template source/iu,
        mutate: async ({ sourceRoot }) => {
          await mkdir(join(sourceRoot, 'actual-recipes'), { recursive: true });
          await cp(join(sourceRoot, 'recipes', 'admin-ui'), join(sourceRoot, 'actual-recipes', 'admin-ui'), { recursive: true });
          await rm(join(sourceRoot, 'recipes'), { recursive: true });
          await symlink('actual-recipes', join(sourceRoot, 'recipes'), 'dir');
        },
      },
    ];

    for (const scenario of cases) {
      const fixture = await refusalFixture();
      await scenario.mutate(fixture);
      expect(await expectRefusalWithoutWrites(fixture), scenario.label).toMatch(scenario.expected);
    }
  }, 60_000);
});

describe('replay Git process boundary', () => {
  it('cannot be overridden to honor local replace refs', () => {
    expect(replayGitEnvironment({ GIT_NO_REPLACE_OBJECTS: '0' })).toMatchObject({
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_TERMINAL_PROMPT: '0',
    });
  });
});
