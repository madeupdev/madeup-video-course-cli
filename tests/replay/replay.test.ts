import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  firstTreeMismatch,
  replayRecipe,
  type ReplayTreeEntry,
  validateReplayPath,
} from '../../scripts/replay-recipes.js';

const temporaryDirectories: string[] = [];
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const fixturePath = join(repositoryRoot, 'recipes/fixtures/smoke/recipe.json');
const templatePath = join(repositoryRoot, 'recipes/fixtures/smoke/files/README.md');
const replacementPath = join(repositoryRoot, 'recipes/fixtures/smoke/files/replacement.md');

function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

async function syntheticHistory(): Promise<{
  repository: string;
  startingCommit: string;
  resultCommit: string;
}> {
  const repository = await mkdtemp(join(tmpdir(), 'course-replay-source-'));
  temporaryDirectories.push(repository);
  await mkdir(join(repository, 'docs'), { recursive: true });
  await mkdir(join(repository, 'scripts'), { recursive: true });
  await writeFile(
    join(repository, 'package.json'),
    `${JSON.stringify({ name: '@madeup-video/storefront' }, null, 2)}\n`,
  );
  await writeFile(join(repository, 'docs/replace.md'), 'replace before replay\n');
  await writeFile(join(repository, 'scripts/delete.sh'), '#!/bin/sh\necho delete\n');
  await writeFile(join(repository, 'scripts/unchanged.sh'), '#!/bin/sh\necho unchanged\n');
  await chmod(join(repository, 'scripts/delete.sh'), 0o755);
  await chmod(join(repository, 'scripts/unchanged.sh'), 0o755);

  git(repository, ['init', '-q']);
  git(repository, ['config', 'user.email', 'replay@example.test']);
  git(repository, ['config', 'user.name', 'Recipe Replay']);
  git(repository, ['config', 'commit.gpgsign', 'false']);
  git(repository, ['config', 'core.filemode', 'true']);
  git(repository, ['add', '--all']);
  git(repository, ['update-index', '--chmod=+x', '--', 'scripts/delete.sh']);
  git(repository, ['update-index', '--chmod=+x', '--', 'scripts/unchanged.sh']);
  git(repository, ['commit', '-qm', 'synthetic starting state']);
  const startingCommit = git(repository, ['rev-parse', 'HEAD']);

  const template = await readFile(templatePath);
  await writeFile(join(repository, 'docs/replace.md'), await readFile(replacementPath));
  await writeFile(join(repository, 'scripts/added.sh'), template);
  await chmod(join(repository, 'docs/replace.md'), 0o644);
  await chmod(join(repository, 'scripts/added.sh'), 0o755);
  await rm(join(repository, 'scripts/delete.sh'));
  git(repository, ['add', '--all']);
  git(repository, ['update-index', '--chmod=+x', '--', 'scripts/added.sh']);
  git(repository, ['update-index', '--chmod=+x', '--', 'scripts/unchanged.sh']);
  git(repository, ['commit', '-qm', 'synthetic result state']);
  const resultCommit = git(repository, ['rev-parse', 'HEAD']);

  return { repository, startingCommit, resultCommit };
}

async function declaredManifest(
  directory: string,
  startingCommit: string,
  resultCommit: string,
  mutate?: (manifest: Record<string, unknown>) => void,
): Promise<string> {
  const manifest = JSON.parse(await readFile(fixturePath, 'utf8')) as Record<string, unknown> & {
    recoveryStates: Array<{ id: string; sourceCommit: string }>;
  };
  const startingState = manifest.recoveryStates.find(({ id }) => id === 'smoke-start');
  const resultState = manifest.recoveryStates.find(({ id }) => id === 'smoke-result');
  if (startingState === undefined || resultState === undefined) {
    throw new Error('Smoke fixture states are missing');
  }
  startingState.sourceCommit = startingCommit;
  resultState.sourceCommit = resultCommit;
  mutate?.(manifest);
  const manifestPath = join(directory, 'recipe.json');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifestPath;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe('exact recipe replay', () => {
  it.each([
    ['native filesystem modes', undefined],
    ['Windows Git-index modes', 'win32' as const],
  ])('replays add, replace, and delete exactly and proves a second apply is a no-op with %s', async (_label, platform) => {
    const history = await syntheticHistory();
    const controlDirectory = await mkdtemp(join(tmpdir(), 'course-replay-control-'));
    const replayParent = await mkdtemp(join(tmpdir(), 'course-replay-parent-'));
    temporaryDirectories.push(controlDirectory, replayParent);
    const manifestPath = await declaredManifest(
      controlDirectory,
      history.startingCommit,
      history.resultCommit,
    );
    const sourceStateBefore = {
      head: git(history.repository, ['rev-parse', 'HEAD']),
      status: git(history.repository, ['status', '--porcelain=v1', '-z']),
    };
    expect(git(history.repository, ['ls-tree', '-r', history.startingCommit]))
      .toMatch(/100755 blob [a-f0-9]+\tscripts\/unchanged\.sh/u);
    expect(git(history.repository, ['ls-tree', '-r', history.resultCommit]))
      .toMatch(/100755 blob [a-f0-9]+\tscripts\/added\.sh/u);

    const result = await replayRecipe({
      sourceRepository: history.repository,
      sourceRoot: repositoryRoot,
      manifestPath,
      recipeId: 'smoke-replay',
      temporaryParent: replayParent,
      platform,
      trustedVerification: [
        {
          command: process.execPath,
          args: [
            '--input-type=module',
            '--eval',
            "import { readFileSync } from 'node:fs'; if (!readFileSync('scripts/added.sh', 'utf8').includes('Exact replay')) process.exit(9); process.stdout.write('trusted replay verification passed\\n');",
          ],
        },
      ],
    });

    expect(result.firstApply).toEqual({
      kind: 'applied',
      changedFiles: ['scripts/added.sh', 'docs/replace.md', 'scripts/delete.sh'],
    });
    expect(result.secondApply).toEqual({ kind: 'already-applied', changedFiles: [] });
    expect(result.modeComparison).toBe(
      platform === 'win32' ? 'git-index-projection' : 'native-filesystem',
    );
    expect(result.verifiedPaths).toEqual([
      'docs/replace.md',
      'package.json',
      'scripts/added.sh',
      'scripts/unchanged.sh',
    ]);
    expect(result.verification).toEqual([
      expect.objectContaining({
        command: process.execPath,
        stdout: 'trusted replay verification passed\n',
        stderr: '',
      }),
    ]);
    expect(result.firstStdout.join('\n')).toContain('Run the recipe verification commands:');
    expect(result.firstStdout.join('\n')).toContain('manifest-command-ran');
    expect(result.secondStdout).toEqual([]);
    expect(await readdir(replayParent)).toEqual([]);
    expect({
      head: git(history.repository, ['rev-parse', 'HEAD']),
      status: git(history.repository, ['status', '--porcelain=v1', '-z']),
    }).toEqual(sourceStateBefore);
  });

  it('rejects an incorrect executable declaration through Windows Git-index modes', async () => {
    const history = await syntheticHistory();
    const controlDirectory = await mkdtemp(join(tmpdir(), 'course-replay-control-'));
    const replayParent = await mkdtemp(join(tmpdir(), 'course-replay-parent-'));
    temporaryDirectories.push(controlDirectory, replayParent);
    const manifestPath = await declaredManifest(
      controlDirectory,
      history.startingCommit,
      history.resultCommit,
      (manifest) => {
        const recipes = manifest.recipes as Array<{ operations: Array<{ mode?: number }> }>;
        recipes[0]!.operations[0]!.mode = 0o644;
      },
    );

    await expect(replayRecipe({
      sourceRepository: history.repository,
      sourceRoot: repositoryRoot,
      manifestPath,
      recipeId: 'smoke-replay',
      temporaryParent: replayParent,
      platform: 'win32',
    })).rejects.toThrow(
      'mode mismatch: scripts/added.sh (expected 100755, received 100644)',
    );
    expect(await readdir(replayParent)).toEqual([]);
  });
});

describe('replay Git path safety', () => {
  it('preserves smoke template bytes across Git checkouts', async () => {
    expect(await readFile(join(repositoryRoot, '.gitattributes'), 'utf8'))
      .toContain('recipes/fixtures/smoke/files/*.md -text');
  });

  it.each([
    '../outside',
    'C:/alternate-stream',
    'folder/bad:name',
    'folder/CON',
    'folder/NUL.txt',
    'folder/trailing.',
  ])('rejects the non-portable path %s before Git use', (path) => {
    expect(() => validateReplayPath(path)).toThrow(/unsafe git tree path/iu);
  });
});

describe('exact tree mismatch diagnostics', () => {
  const bytes = Buffer.from('same');
  const entry = (path: string, mode: 0o644 | 0o755 = 0o644): ReplayTreeEntry => ({
    path,
    mode,
    bytes,
  });

  it('reports the first missing path', () => {
    expect(firstTreeMismatch([entry('a'), entry('b')], [entry('b')]))
      .toBe('missing path: a');
  });

  it('reports the first unexpected path', () => {
    expect(firstTreeMismatch([entry('a')], [entry('a'), entry('b')]))
      .toBe('unexpected path: b');
  });

  it('reports the first byte mismatch', () => {
    expect(firstTreeMismatch([entry('a')], [{ ...entry('a'), bytes: Buffer.from('other') }]))
      .toBe('byte mismatch: a');
  });

  it('reports the first mode mismatch', () => {
    expect(firstTreeMismatch([entry('a', 0o755)], [entry('a', 0o644)]))
      .toBe('mode mismatch: a (expected 100755, received 100644)');
  });
});
