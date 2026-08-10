import {
  chmod,
  lstat,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { hashBytes } from '../project/hash.js';
import type { PlannedOperation } from './plan.js';

export type OperationBackup = Readonly<{
  operation: PlannedOperation;
  path?: string;
  mode?: number;
  sha256?: string;
}>;

export type RollbackOptions = Readonly<{
  onRollback?: (operation: PlannedOperation) => void;
}>;

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return false;
    }
    throw error;
  }
}

async function restoreBackup(
  backup: OperationBackup,
  transactionDirectory: string,
  position: number,
): Promise<void> {
  if (
    backup.path === undefined ||
    backup.mode === undefined ||
    backup.sha256 === undefined
  ) {
    throw new Error(`Missing rollback backup for ${backup.operation.destination}`);
  }
  const restorePath = join(transactionDirectory, `restore-${position}`);
  await writeFile(restorePath, await readFile(backup.path), {
    flag: 'wx',
    mode: backup.mode,
  });
  await chmod(restorePath, backup.mode);
  await rename(restorePath, backup.operation.destinationPath);
  await chmod(backup.operation.destinationPath, backup.mode);
  const [restoredBytes, restoredStat] = await Promise.all([
    readFile(backup.operation.destinationPath),
    lstat(backup.operation.destinationPath),
  ]);
  if (
    hashBytes(restoredBytes) !== backup.sha256 ||
    (restoredStat.mode & 0o777) !== backup.mode
  ) {
    throw new Error(`Rollback verification failed for ${backup.operation.destination}`);
  }
}

export async function rollbackOperations(
  completedOperations: readonly PlannedOperation[],
  backups: ReadonlyMap<string, OperationBackup>,
  transactionDirectory: string,
  options: RollbackOptions = {},
): Promise<readonly Error[]> {
  const failures: Error[] = [];
  const reversed = [...completedOperations].reverse();

  for (const [position, operation] of reversed.entries()) {
    try {
      options.onRollback?.(operation);
      if (operation.type === 'add') {
        await rm(operation.destinationPath, { force: true });
        if (await pathExists(operation.destinationPath)) {
          throw new Error(`Rollback verification failed for ${operation.destination}`);
        }
      } else {
        const backup = backups.get(operation.destination);
        if (backup === undefined) {
          throw new Error(`Missing rollback record for ${operation.destination}`);
        }
        await restoreBackup(backup, transactionDirectory, position);
      }
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }

  return Object.freeze(failures);
}
