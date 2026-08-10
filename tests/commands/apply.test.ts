import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli } from '../../src/cli.js';
import { runApply } from '../../src/commands/apply.js';
import type { CourseManifest } from '../../src/manifest/types.js';
import { hashBytes } from '../../src/project/hash.js';

const temporaryDirectories: string[] = [];

function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout;
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'course-apply-command-'));
  temporaryDirectories.push(root);
  const projectRoot = join(root, 'project');
  const sourceRoot = join(root, 'package');
  const destination = 'src/app.ts';
  const template = 'recipes/app.ts';
  const before = 'export const state = "before";\n';
  const after = 'export const state = "after";\n';
  await mkdir(join(projectRoot, 'src'), { recursive: true });
  await mkdir(join(sourceRoot, 'recipes'), { recursive: true });
  await writeFile(
    join(projectRoot, 'package.json'),
    `${JSON.stringify({ name: '@madeup-video/storefront' })}\n`,
  );
  await writeFile(join(projectRoot, destination), before);
  await chmod(join(projectRoot, destination), 0o644);
  await writeFile(join(sourceRoot, template), after);
  git(projectRoot, ['init', '-q']);
  git(projectRoot, ['config', 'user.email', 'course@example.test']);
  git(projectRoot, ['config', 'user.name', 'Course Test']);
  git(projectRoot, ['config', 'commit.gpgsign', 'false']);
  git(projectRoot, ['add', '.']);
  git(projectRoot, ['commit', '-qm', 'fixture']);

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
    },
    recoveryStates: [
      {
        id: 'before',
        sourceCommit: 'a'.repeat(40),
        asset: 'before.tar.gz',
        sha256: 'b'.repeat(64),
        tree: { algorithm: 'course-tree-v1', files: [] },
        verification: ['pnpm test'],
      },
      {
        id: 'after',
        sourceCommit: 'c'.repeat(40),
        asset: 'after.tar.gz',
        sha256: 'd'.repeat(64),
        tree: { algorithm: 'course-tree-v1', files: [] },
        verification: ['pnpm test'],
      },
    ],
    recipes: [
      {
        id: 'prepared-app',
        description: 'Apply the prepared app',
        expectedPackageName: '@madeup-video/storefront',
        startingState: 'before',
        resultState: 'after',
        operations: [
          {
            type: 'replace',
            destination,
            template,
            beforeSha256: hashBytes(Buffer.from(before)),
            afterSha256: hashBytes(Buffer.from(after)),
            mode: 0o755,
          },
        ],
        verification: ['pnpm test', 'pnpm typecheck'],
      },
    ],
  };

  return {
    projectRoot,
    destination,
    before,
    after,
    options: {
      startDirectory: projectRoot,
      workingBoundary: projectRoot,
      sourceRoot,
      manifest,
    },
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe('apply command', () => {
  it('previews before interactive confirmation and prints the post-success handoff', async () => {
    const fixture = await createFixture();
    const events: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCli(
      ['apply', 'prepared-app'],
      {
        stdout: (line) => events.push(`stdout:${line}`),
        stderr: (line) => stderr.push(line),
        confirm: async (prompt) => {
          events.push(`confirm:${prompt}`);
          return true;
        },
      },
      { apply: fixture.options },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(events[0]).toBe('stdout:REPLACE src/app.ts');
    expect(events[1]).toContain('confirm:Apply these prepared changes?');
    expect(events.join('\n')).toContain('Changed files:\n');
    expect(events.join('\n')).toContain('src/app.ts');
    expect(events.join('\n')).toContain('git diff --stat');
    expect(events.join('\n')).toContain('git diff --check');
    expect(events.join('\n')).toContain('pnpm test');
    expect(events.join('\n')).toContain('pnpm typecheck');
    expect(events.join('\n')).toContain('You decide whether to commit');
    expect(await readFile(join(fixture.projectRoot, fixture.destination), 'utf8'))
      .toBe(fixture.after);
  });

  it('does not write when interactive confirmation is declined', async () => {
    const fixture = await createFixture();
    const stdout: string[] = [];
    const confirm = vi.fn(async () => false);

    const exitCode = await runCli(
      ['apply', 'prepared-app'],
      {
        stdout: (line) => stdout.push(line),
        stderr: () => undefined,
        confirm,
      },
      { apply: fixture.options },
    );

    expect(exitCode).toBe(1);
    expect(stdout[0]).toBe('REPLACE src/app.ts');
    expect(confirm).toHaveBeenCalledOnce();
    expect(await readFile(join(fixture.projectRoot, fixture.destination), 'utf8'))
      .toBe(fixture.before);
  });

  it('requires --yes when no interactive confirmation is available', async () => {
    const fixture = await createFixture();
    const stderr: string[] = [];

    const exitCode = await runCli(
      ['apply', 'prepared-app'],
      { stdout: () => undefined, stderr: (line) => stderr.push(line) },
      { apply: fixture.options },
    );

    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toContain('--yes');
    expect(await readFile(join(fixture.projectRoot, fixture.destination), 'utf8'))
      .toBe(fixture.before);
  });

  it('accepts explicit --yes without asking for inferred terminal consent', async () => {
    const fixture = await createFixture();
    const confirm = vi.fn(async () => false);

    const exitCode = await runCli(
      ['apply', 'prepared-app', '--yes'],
      { stdout: () => undefined, stderr: () => undefined, confirm },
      { apply: fixture.options },
    );

    expect(exitCode).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(await readFile(join(fixture.projectRoot, fixture.destination), 'utf8'))
      .toBe(fixture.after);
  });

  it('returns the exact idempotent result on a second command application', async () => {
    const fixture = await createFixture();
    const io = { stdout: () => undefined, stderr: () => undefined };
    await runApply('prepared-app', fixture.options, io, { yes: true });

    const result = await runApply('prepared-app', fixture.options, io, { yes: true });

    expect(result).toEqual({ kind: 'already-applied', changedFiles: [] });
  });

  it('warns when rollback is incomplete instead of claiming restoration', async () => {
    const fixture = await createFixture();
    const stderr: string[] = [];

    const result = await runApply(
      'prepared-app',
      fixture.options,
      { stdout: () => undefined, stderr: (line) => stderr.push(line) },
      {
        yes: true,
        transaction: {
          injectFailure(point) {
            if (point.kind === 'after-write') {
              throw new Error('injected write failure');
            }
          },
          onRollback() {
            throw new Error('injected rollback failure');
          },
        },
      },
    );

    expect(result.kind).toBe('refused');
    expect(stderr.join('\n')).toContain('rollback was incomplete');
    expect(stderr.join('\n')).toContain('injected rollback failure');
    expect(stderr.join('\n')).not.toContain('was rolled back');
  });

  it('recognises a mode-only replacement as already applied on the second run', async () => {
    const fixture = await createFixture();
    const operation = fixture.options.manifest.recipes[0]!.operations[0]!;
    if (operation.type !== 'replace') {
      throw new Error('Expected replace operation');
    }
    await writeFile(
      join(fixture.options.sourceRoot, operation.template),
      fixture.before,
    );
    operation.afterSha256 = operation.beforeSha256;
    git(fixture.projectRoot, ['config', 'core.filemode', 'true']);
    const io = { stdout: () => undefined, stderr: () => undefined };

    const firstResult = await runApply(
      'prepared-app',
      fixture.options,
      io,
      { yes: true },
    );

    expect(firstResult).toEqual({
      kind: 'applied',
      changedFiles: [fixture.destination],
    });
    expect(await readFile(join(fixture.projectRoot, fixture.destination), 'utf8'))
      .toBe(fixture.before);
    expect((await stat(join(fixture.projectRoot, fixture.destination))).mode & 0o777)
      .toBe(0o755);
    const beforeSecondRun = {
      bytes: await readFile(join(fixture.projectRoot, fixture.destination)),
      mode: (await stat(join(fixture.projectRoot, fixture.destination))).mode & 0o777,
      gitStatus: git(fixture.projectRoot, ['status', '--porcelain=v1', '-z']),
    };

    const secondResult = await runApply(
      'prepared-app',
      fixture.options,
      io,
      { yes: true },
    );

    expect(secondResult).toEqual({ kind: 'already-applied', changedFiles: [] });
    expect(await readFile(join(fixture.projectRoot, fixture.destination)))
      .toEqual(beforeSecondRun.bytes);
    expect((await stat(join(fixture.projectRoot, fixture.destination))).mode & 0o777)
      .toBe(beforeSecondRun.mode);
    expect(git(fixture.projectRoot, ['status', '--porcelain=v1', '-z']))
      .toBe(beforeSecondRun.gitStatus);
  });
});
