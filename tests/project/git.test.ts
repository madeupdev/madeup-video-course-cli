import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { inspectGitRepository } from '../../src/project/git.js';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), prefix)),
  );
  temporaryDirectories.push(directory);
  return directory;
}

async function runGit(
  repository: string,
  args: readonly string[],
): Promise<void> {
  await execFileAsync('git', ['-C', repository, ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: join(
        repository,
        '.course-cli-no-global-config',
      ),
      GIT_CONFIG_NOSYSTEM: '1',
    },
    windowsHide: true,
  });
}

async function initializedRepository(): Promise<string> {
  const repository = await temporaryDirectory('course-project-git-');
  await runGit(repository, ['init', '--quiet']);
  await runGit(repository, ['config', 'user.name', 'Course CLI Tests']);
  await runGit(repository, [
    'config',
    'user.email',
    'course-cli@example.invalid',
  ]);

  for (const name of [
    'staged file.txt',
    'unstaged file.txt',
    'deleted file.txt',
    'unchanged file.txt',
  ]) {
    await writeFile(join(repository, name), `${name}\n`, 'utf8');
  }
  await runGit(repository, ['add', '--all']);
  await runGit(repository, ['commit', '--quiet', '-m', 'test fixture']);
  return repository;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe('inspectGitRepository', () => {
  it('initializes fixtures without inheriting hostile global Git configuration', async () => {
    const configDirectory = await temporaryDirectory(
      'course-project-git-config-',
    );
    const hostileGlobalConfig = join(
      configDirectory,
      'hostile-global.gitconfig',
    );
    await writeFile(
      hostileGlobalConfig,
      [
        '[commit]',
        '\tgpgSign = true',
        '[gpg]',
        '\tprogram = course-cli-test-missing-gpg-program',
        '[user]',
        '\tsigningKey = course-cli-test-key',
        '',
      ].join('\n'),
      'utf8',
    );
    const originalGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = hostileGlobalConfig;

    try {
      const repository = await initializedRepository();

      await expect(
        inspectGitRepository(repository),
      ).resolves.toMatchObject({
        ok: true,
        clean: true,
      });
    } finally {
      if (originalGlobalConfig === undefined) {
        delete process.env.GIT_CONFIG_GLOBAL;
      } else {
        process.env.GIT_CONFIG_GLOBAL = originalGlobalConfig;
      }
    }
  });

  it('reports a clean worktree with its repository root', async () => {
    const repository = await initializedRepository();

    const result = await inspectGitRepository(repository);

    expect(result).toEqual({
      ok: true,
      repositoryRoot: repository,
      clean: true,
      changes: [],
    });
  });

  it('identifies staged, unstaged, deleted, and untracked changes', async () => {
    const repository = await initializedRepository();
    await writeFile(
      join(repository, 'staged file.txt'),
      'staged change\n',
      'utf8',
    );
    await runGit(repository, ['add', 'staged file.txt']);
    await writeFile(
      join(repository, 'unstaged file.txt'),
      'unstaged change\n',
      'utf8',
    );
    await unlink(join(repository, 'deleted file.txt'));
    await writeFile(
      join(repository, 'untracked file.txt'),
      'untracked\n',
      'utf8',
    );

    const result = await inspectGitRepository(repository);

    expect(result).toMatchObject({
      ok: true,
      repositoryRoot: repository,
      clean: false,
    });
    if (!result.ok) {
      throw new Error('Expected Git inspection to succeed');
    }
    expect(result.changes).toEqual(
      expect.arrayContaining([
        {
          path: 'staged file.txt',
          index: 'modified',
          worktree: null,
        },
        {
          path: 'unstaged file.txt',
          index: null,
          worktree: 'modified',
        },
        {
          path: 'deleted file.txt',
          index: null,
          worktree: 'deleted',
        },
        {
          path: 'untracked file.txt',
          index: null,
          worktree: 'untracked',
        },
      ]),
    );
  });

  it('parses ordinary filenames containing spaces without shell interpretation', async () => {
    const repository = await initializedRepository();
    const path = 'ordinary name with spaces.txt';
    await writeFile(join(repository, path), 'contents\n', 'utf8');

    const result = await inspectGitRepository(repository);

    expect(result).toMatchObject({
      ok: true,
      changes: [
        {
          path,
          index: null,
          worktree: 'untracked',
        },
      ],
    });
  });

  it('reports a directory that is not a Git repository without crashing', async () => {
    const directory = await temporaryDirectory('course-project-not-git-');
    await mkdir(join(directory, 'nested'));

    const result = await inspectGitRepository(join(directory, 'nested'));

    expect(result).toMatchObject({
      ok: false,
      finding: {
        kind: 'not-git-repository',
        directory: join(directory, 'nested'),
      },
    });
  });
});
