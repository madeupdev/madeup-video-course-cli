import { spawnSync } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createApplyPlan } from '../../src/apply/plan.js';
import {
  ApplyTransactionError,
  applyTransaction,
  type TransactionFailurePoint,
} from '../../src/apply/transaction.js';
import { hashBytes } from '../../src/project/hash.js';

type Snapshot = Readonly<Record<string, Readonly<{ bytes: string; mode: number }>>>;

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
  const projectRoot = await mkdtemp(join(tmpdir(), 'course-transaction-'));
  temporaryDirectories.push(projectRoot);
  const destinations = {
    add: 'src/a-added.ts',
    replace: 'src/b-replaced.ts',
    delete: 'src/c-deleted.ts',
  } as const;
  const contents = {
    addAfter: 'export const added = true;\n',
    replaceBefore: 'export const version = "before";\n',
    replaceAfter: 'export const version = "after";\n',
    deleteBefore: 'export const obsolete = true;\n',
  } as const;

  await mkdir(join(projectRoot, 'src'));
  await writeFile(join(projectRoot, destinations.replace), contents.replaceBefore);
  await chmod(join(projectRoot, destinations.replace), 0o644);
  await writeFile(join(projectRoot, destinations.delete), contents.deleteBefore);
  await chmod(join(projectRoot, destinations.delete), 0o755);
  await writeFile(
    join(projectRoot, 'package.json'),
    `${JSON.stringify({ name: '@madeup-video/storefront' })}\n`,
  );
  git(projectRoot, ['init', '-q']);
  git(projectRoot, ['config', 'user.email', 'course@example.test']);
  git(projectRoot, ['config', 'user.name', 'Course Test']);
  git(projectRoot, ['config', 'commit.gpgsign', 'false']);
  git(projectRoot, ['add', '.']);
  git(projectRoot, ['commit', '-qm', 'fixture']);

  const hash = (value: string) => hashBytes(Buffer.from(value));
  return {
    projectRoot,
    destinations,
    contents,
    plan: createApplyPlan({
      recipeId: 'transaction-test',
      projectRoot,
      operations: [
        {
          type: 'delete',
          destination: destinations.delete,
          destinationPath: join(projectRoot, destinations.delete),
          beforeSha256: hash(contents.deleteBefore),
        },
        {
          type: 'replace',
          destination: destinations.replace,
          destinationPath: join(projectRoot, destinations.replace),
          template: 'recipes/replaced.ts',
          templatePath: join(projectRoot, '.unused-replaced-template'),
          templateBytesBase64: Buffer.from(contents.replaceAfter).toString('base64'),
          beforeSha256: hash(contents.replaceBefore),
          afterSha256: hash(contents.replaceAfter),
          mode: 0o755,
        },
        {
          type: 'add',
          destination: destinations.add,
          destinationPath: join(projectRoot, destinations.add),
          template: 'recipes/added.ts',
          templatePath: join(projectRoot, '.unused-added-template'),
          templateBytesBase64: Buffer.from(contents.addAfter).toString('base64'),
          afterSha256: hash(contents.addAfter),
          mode: 0o644,
        },
      ],
    }),
  };
}

async function snapshotWorkingTree(root: string): Promise<Snapshot> {
  const snapshot: Record<string, { bytes: string; mode: number }> = {};

  async function visit(directory: string, relativeDirectory = ''): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      if (relativeDirectory === '' && name === '.git') {
        continue;
      }
      const relativePath = relativeDirectory === '' ? name : `${relativeDirectory}/${name}`;
      const path = join(directory, name);
      const entry = await lstat(path);
      if (entry.isDirectory()) {
        await visit(path, relativePath);
      } else if (entry.isFile()) {
        snapshot[relativePath] = {
          bytes: (await readFile(path)).toString('base64'),
          mode: entry.mode & 0o777,
        };
      }
    }
  }

  await visit(root);
  return snapshot;
}

async function transactionArtifacts(root: string): Promise<string[]> {
  const gitDirectory = join(root, '.git');
  const [rootEntries, gitEntries] = await Promise.all([
    readdir(root),
    readdir(gitDirectory),
  ]);
  return [...rootEntries, ...gitEntries].filter((name) =>
    name.startsWith('.madeup-video-course-transaction-') ||
    name.startsWith('madeup-video-course-transaction'),
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe('apply transaction', () => {
  it('adds, replaces, and deletes files with verified hashes and modes', async () => {
    const fixture = await createFixture();

    const result = await applyTransaction(fixture.plan);

    expect(result).toEqual({
      kind: 'applied',
      changedFiles: Object.values(fixture.destinations).sort(),
    });
    expect(await readFile(join(fixture.projectRoot, fixture.destinations.add), 'utf8'))
      .toBe(fixture.contents.addAfter);
    expect((await stat(join(fixture.projectRoot, fixture.destinations.add))).mode & 0o777)
      .toBe(0o644);
    expect(await readFile(join(fixture.projectRoot, fixture.destinations.replace), 'utf8'))
      .toBe(fixture.contents.replaceAfter);
    expect((await stat(join(fixture.projectRoot, fixture.destinations.replace))).mode & 0o777)
      .toBe(0o755);
    await expect(lstat(join(fixture.projectRoot, fixture.destinations.delete))).rejects
      .toMatchObject({ code: 'ENOENT' });
    expect(await transactionArtifacts(fixture.projectRoot)).toEqual([]);
  });

  it.each([
    { label: 'the first write', point: { kind: 'after-write', position: 0 } },
    { label: 'the second write', point: { kind: 'after-write', position: 1 } },
    { label: 'the third write', point: { kind: 'after-write', position: 2 } },
    { label: 'final verification', point: { kind: 'final-verification' } },
  ] satisfies Array<{ label: string; point: TransactionFailurePoint }>) (
    'rolls back in reverse order after a failure at $label',
    async ({ point }) => {
      const fixture = await createFixture();
      const beforeTree = await snapshotWorkingTree(fixture.projectRoot);
      const beforeStatus = git(fixture.projectRoot, ['status', '--porcelain=v1', '-z']);
      const rollbackOrder: string[] = [];

      await expect(
        applyTransaction(fixture.plan, {
          injectFailure(currentPoint) {
            if (
              currentPoint.kind === point.kind &&
              (currentPoint.kind !== 'after-write' ||
                (point.kind === 'after-write' && currentPoint.position === point.position))
            ) {
              throw new Error(`injected ${point.kind}`);
            }
          },
          onRollback(operation) {
            rollbackOrder.push(operation.destination);
          },
        }),
      ).rejects.toThrow(`injected ${point.kind}`);

      const completedCount = point.kind === 'final-verification' ? 3 : point.position + 1;
      expect(rollbackOrder).toEqual(
        fixture.plan.operations.slice(0, completedCount).map((operation) => operation.destination).reverse(),
      );
      expect(await snapshotWorkingTree(fixture.projectRoot)).toEqual(beforeTree);
      expect(git(fixture.projectRoot, ['status', '--porcelain=v1', '-z'])).toBe(beforeStatus);
      expect(await transactionArtifacts(fixture.projectRoot)).toEqual([]);
    },
  );

  it.each([
    {
      label: 'hash',
      corrupt: async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
        await writeFile(
          join(fixture.projectRoot, fixture.destinations.add),
          'corrupted after write\n',
        );
      },
    },
    {
      label: 'mode',
      corrupt: async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
        await chmod(
          join(fixture.projectRoot, fixture.destinations.replace),
          0o644,
        );
      },
    },
  ])('rolls back when final verification detects a wrong $label', async ({ corrupt }) => {
    const fixture = await createFixture();
    const beforeTree = await snapshotWorkingTree(fixture.projectRoot);
    const beforeStatus = git(fixture.projectRoot, ['status', '--porcelain=v1', '-z']);

    await expect(
      applyTransaction(fixture.plan, {
        async injectFailure(point) {
          if (point.kind === 'final-verification') {
            await corrupt(fixture);
          }
        },
      }),
    ).rejects.toThrow('Final verification failed');

    expect(await snapshotWorkingTree(fixture.projectRoot)).toEqual(beforeTree);
    expect(git(fixture.projectRoot, ['status', '--porcelain=v1', '-z'])).toBe(beforeStatus);
    expect(await transactionArtifacts(fixture.projectRoot)).toEqual([]);
  });

  it('preserves the original error and attaches rollback failures', async () => {
    const fixture = await createFixture();
    const originalError = new Error('original write failure');
    let received: unknown;

    try {
      await applyTransaction(fixture.plan, {
        injectFailure(point) {
          if (point.kind === 'after-write' && point.position === 0) {
            throw originalError;
          }
        },
        onRollback() {
          throw new Error('simulated rollback failure');
        },
      });
    } catch (error) {
      received = error;
    }

    expect(received).toBeInstanceOf(ApplyTransactionError);
    expect(received).toMatchObject({
      cause: originalError,
      rollbackErrors: [expect.objectContaining({ message: 'simulated rollback failure' })],
      recoveryDirectory: expect.stringContaining(
        '.madeup-video-course-transaction-',
      ),
    });
    const recoveryDirectory = (received as ApplyTransactionError).recoveryDirectory;
    await expect(lstat(recoveryDirectory!)).resolves.toMatchObject({});
  });
});
