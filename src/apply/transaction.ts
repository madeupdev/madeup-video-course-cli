import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

import { hashBytes } from '../project/hash.js';
import type { ApplyPlan, PlannedOperation } from './plan.js';
import {
  rollbackOperations,
  type OperationBackup,
} from './rollback.js';

export type ApplyTransactionResult =
  | Readonly<{ kind: 'applied'; changedFiles: string[] }>
  | Readonly<{ kind: 'already-applied'; changedFiles: [] }>;

export type TransactionFailurePoint =
  | Readonly<{ kind: 'after-write'; position: number }>
  | Readonly<{ kind: 'final-verification' }>;

export type ApplyTransactionOptions = Readonly<{
  injectFailure?: (point: TransactionFailurePoint) => void | Promise<void>;
  onRollback?: (operation: PlannedOperation) => void;
}>;

type OperationState = 'before' | 'after' | 'invalid';

export class MixedApplyStateError extends Error {
  constructor() {
    super('Recipe is partially applied; refusing to write a mixed before/after state.');
    this.name = 'MixedApplyStateError';
  }
}

export class ApplyStateError extends Error {
  constructor(destination: string) {
    super(`Destination does not match the recipe before or after state: ${destination}`);
    this.name = 'ApplyStateError';
  }
}

export class ApplyTransactionError extends Error {
  readonly rollbackErrors: readonly Error[];
  readonly recoveryDirectory?: string;

  constructor(
    originalError: Error,
    rollbackErrors: readonly Error[],
    recoveryDirectory?: string,
  ) {
    super(originalError.message, { cause: originalError });
    this.name = 'ApplyTransactionError';
    this.rollbackErrors = Object.freeze([...rollbackErrors]);
    this.recoveryDirectory = recoveryDirectory;
  }
}

async function pathState(path: string): Promise<'missing' | 'file' | 'other'> {
  try {
    const entry = await lstat(path);
    return entry.isFile() ? 'file' : 'other';
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return 'missing';
    }
    throw error;
  }
}

async function fileFingerprint(path: string): Promise<{ hash: string; mode: number }> {
  const [bytes, fileStat] = await Promise.all([readFile(path), stat(path)]);
  return { hash: hashBytes(bytes), mode: fileStat.mode & 0o777 };
}

async function operationState(operation: PlannedOperation): Promise<OperationState> {
  const kind = await pathState(operation.destinationPath);
  if (operation.type === 'add') {
    if (kind === 'missing') {
      return 'before';
    }
    if (kind !== 'file') {
      return 'invalid';
    }
    const fingerprint = await fileFingerprint(operation.destinationPath);
    return fingerprint.hash === operation.afterSha256 && fingerprint.mode === operation.mode
      ? 'after'
      : 'invalid';
  }

  if (operation.type === 'delete') {
    if (kind === 'missing') {
      return 'after';
    }
    if (kind !== 'file') {
      return 'invalid';
    }
    return (await fileFingerprint(operation.destinationPath)).hash === operation.beforeSha256
      ? 'before'
      : 'invalid';
  }

  if (kind !== 'file') {
    return 'invalid';
  }
  const fingerprint = await fileFingerprint(operation.destinationPath);
  if (
    fingerprint.hash === operation.afterSha256 &&
    fingerprint.mode === operation.mode
  ) {
    return 'after';
  }
  return fingerprint.hash === operation.beforeSha256 ? 'before' : 'invalid';
}

export async function classifyApplyPlan(
  plan: ApplyPlan,
): Promise<'before' | 'after'> {
  const states = await Promise.all(plan.operations.map(operationState));
  const invalidPosition = states.indexOf('invalid');
  if (invalidPosition !== -1) {
    throw new ApplyStateError(plan.operations[invalidPosition]!.destination);
  }
  const hasBefore = states.includes('before');
  const hasAfter = states.includes('after');
  if (hasBefore && hasAfter) {
    throw new MixedApplyStateError();
  }
  return hasAfter ? 'after' : 'before';
}

async function createBackups(
  plan: ApplyPlan,
  transactionDirectory: string,
): Promise<Map<string, OperationBackup>> {
  const backups = new Map<string, OperationBackup>();
  for (const [position, operation] of plan.operations.entries()) {
    if (operation.type === 'add') {
      if ((await pathState(operation.destinationPath)) !== 'missing') {
        throw new ApplyStateError(operation.destination);
      }
      backups.set(operation.destination, Object.freeze({ operation }));
      continue;
    }

    const fingerprint = await fileFingerprint(operation.destinationPath);
    if (fingerprint.hash !== operation.beforeSha256) {
      throw new ApplyStateError(operation.destination);
    }
    const backupPath = join(transactionDirectory, `backup-${position}`);
    await copyFile(operation.destinationPath, backupPath);
    await chmod(backupPath, fingerprint.mode);
    const backupFingerprint = await fileFingerprint(backupPath);
    if (
      backupFingerprint.hash !== fingerprint.hash ||
      backupFingerprint.mode !== fingerprint.mode
    ) {
      throw new Error(`Backup verification failed for ${operation.destination}`);
    }
    backups.set(
      operation.destination,
      Object.freeze({
        operation,
        path: backupPath,
        mode: fingerprint.mode,
        sha256: fingerprint.hash,
      }),
    );
  }
  return backups;
}

async function replaceWithTemporaryFile(
  operation: Extract<PlannedOperation, { type: 'add' | 'replace' }>,
  transactionDirectory: string,
  position: number,
): Promise<void> {
  const temporaryPath = join(transactionDirectory, `write-${position}`);
  await writeFile(
    temporaryPath,
    Buffer.from(operation.templateBytesBase64, 'base64'),
    { flag: 'wx', mode: operation.mode },
  );
  await chmod(temporaryPath, operation.mode);
  await rename(temporaryPath, operation.destinationPath);
  await chmod(operation.destinationPath, operation.mode);
}

async function writeOperation(
  operation: PlannedOperation,
  transactionDirectory: string,
  position: number,
): Promise<void> {
  if (operation.type === 'delete') {
    await rm(operation.destinationPath);
    return;
  }
  await replaceWithTemporaryFile(operation, transactionDirectory, position);
}

async function verifyAfterState(plan: ApplyPlan): Promise<void> {
  for (const operation of plan.operations) {
    if ((await operationState(operation)) !== 'after') {
      throw new Error(`Final verification failed for ${operation.destination}`);
    }
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export async function applyTransaction(
  plan: ApplyPlan,
  options: ApplyTransactionOptions = {},
): Promise<ApplyTransactionResult> {
  const state = await classifyApplyPlan(plan);
  if (state === 'after') {
    return Object.freeze({
      kind: 'already-applied',
      changedFiles: [] as [],
    });
  }

  await mkdir(plan.projectRoot, { recursive: false }).catch((error: unknown) => {
    if (
      typeof error !== 'object' ||
      error === null ||
      !('code' in error) ||
      error.code !== 'EEXIST'
    ) {
      throw error;
    }
  });
  const transactionDirectory = await mkdtemp(
    join(plan.projectRoot, '.madeup-video-course-transaction-'),
  );
  const completedOperations: PlannedOperation[] = [];
  let backups = new Map<string, OperationBackup>();

  try {
    backups = await createBackups(plan, transactionDirectory);
    for (const [position, operation] of plan.operations.entries()) {
      completedOperations.push(operation);
      await writeOperation(operation, transactionDirectory, position);
      await options.injectFailure?.({ kind: 'after-write', position });
    }
    await options.injectFailure?.({ kind: 'final-verification' });
    await verifyAfterState(plan);
    await rm(transactionDirectory, { force: true, recursive: true });
    return Object.freeze({
      kind: 'applied',
      changedFiles: plan.operations.map((operation) => operation.destination),
    });
  } catch (error) {
    const rollbackErrors = [
      ...(await rollbackOperations(
        completedOperations,
        backups,
        transactionDirectory,
        { onRollback: options.onRollback },
      )),
    ];
    if (rollbackErrors.length === 0) {
      try {
        await rm(transactionDirectory, { force: true, recursive: true });
      } catch (cleanupError) {
        rollbackErrors.push(asError(cleanupError));
      }
    }
    throw new ApplyTransactionError(
      asError(error),
      rollbackErrors,
      rollbackErrors.length === 0 ? undefined : transactionDirectory,
    );
  }
}
