import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createApplyPlan } from '../../src/apply/plan.js';
import { applyTransaction } from '../../src/apply/transaction.js';
import { hashBytes } from '../../src/project/hash.js';

const temporaryDirectories: string[] = [];

async function createPlan() {
  const projectRoot = await mkdtemp(join(tmpdir(), 'course-idempotence-'));
  temporaryDirectories.push(projectRoot);
  await mkdir(join(projectRoot, 'src'));
  const before = 'before\n';
  const after = 'after\n';
  const added = 'added\n';
  await writeFile(join(projectRoot, 'src/replaced.ts'), before);
  const hash = (value: string) => hashBytes(Buffer.from(value));
  return {
    projectRoot,
    plan: createApplyPlan({
      recipeId: 'idempotence-test',
      projectRoot,
      operations: [
        {
          type: 'add',
          destination: 'src/added.ts',
          destinationPath: join(projectRoot, 'src/added.ts'),
          template: 'recipes/added.ts',
          templatePath: join(projectRoot, '.unused-added-template'),
          templateBytesBase64: Buffer.from(added).toString('base64'),
          afterSha256: hash(added),
          mode: 0o644,
        },
        {
          type: 'replace',
          destination: 'src/replaced.ts',
          destinationPath: join(projectRoot, 'src/replaced.ts'),
          template: 'recipes/replaced.ts',
          templatePath: join(projectRoot, '.unused-replaced-template'),
          templateBytesBase64: Buffer.from(after).toString('base64'),
          beforeSha256: hash(before),
          afterSha256: hash(after),
          mode: 0o755,
        },
      ],
    }),
  };
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of (await readdir(join(root, 'src'))).sort()) {
    result[name] = (await readFile(join(root, 'src', name))).toString('base64');
  }
  return result;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe('apply transaction idempotence', () => {
  it('returns already-applied without writes on a second application', async () => {
    const fixture = await createPlan();
    await applyTransaction(fixture.plan);
    const beforeSecondApply = await snapshot(fixture.projectRoot);

    const result = await applyTransaction(fixture.plan);

    expect(result).toEqual({ kind: 'already-applied', changedFiles: [] });
    expect(await snapshot(fixture.projectRoot)).toEqual(beforeSecondApply);
  });

  it('refuses a mixed before/after state without writes', async () => {
    const fixture = await createPlan();
    const addOperation = fixture.plan.operations.find(
      (operation) => operation.type === 'add',
    );
    if (addOperation === undefined || addOperation.type !== 'add') {
      throw new Error('Expected add operation');
    }
    await writeFile(
      addOperation.destinationPath,
      Buffer.from(addOperation.templateBytesBase64, 'base64'),
      { mode: addOperation.mode },
    );
    const beforeAttempt = await snapshot(fixture.projectRoot);

    await expect(applyTransaction(fixture.plan)).rejects.toMatchObject({
      name: 'MixedApplyStateError',
    });

    expect(await snapshot(fixture.projectRoot)).toEqual(beforeAttempt);
  });
});
