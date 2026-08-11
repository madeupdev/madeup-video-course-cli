import type { ApplyPlan, PlannedOperation } from '../apply/plan.js';
import {
  ApplyTransactionError,
  applyTransaction,
  classifyApplyPlan,
} from '../apply/transaction.js';
import type {
  ApplyTransactionOptions,
  ApplyTransactionResult,
} from '../apply/transaction.js';
import {
  preflightApply,
} from '../apply/preflight.js';
import type {
  ApplyPreflightOptions,
  ApplyPreflightResult,
} from '../apply/preflight.js';

export type ApplyIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  confirm?: (prompt: string) => Promise<boolean>;
};

export type ApplyOptions = ApplyPreflightOptions;

export type ApplyResult =
  | Readonly<{ exitCode: 0; kind: 'dry-run'; plan: ApplyPlan }>
  | Readonly<{
      exitCode: 1;
      kind: 'refused';
      failure: Extract<ApplyPreflightResult, { ok: false }>['failure'];
    }>;

export type ApplyCommandResult =
  | ApplyTransactionResult
  | Readonly<{
      kind: 'refused';
      changedFiles: [];
      failure?: Extract<ApplyPreflightResult, { ok: false }>['failure'];
    }>
  | Readonly<{ kind: 'cancelled'; changedFiles: [] }>;

export type ApplyExecutionOptions = Readonly<{
  yes?: boolean;
  transaction?: ApplyTransactionOptions;
}>;

const previewOrder: Readonly<Record<PlannedOperation['type'], number>> = {
  add: 0,
  replace: 1,
  delete: 2,
};

function previewOperations(plan: ApplyPlan): readonly PlannedOperation[] {
  return [...plan.operations].sort((left, right) => {
    const typeDifference = previewOrder[left.type] - previewOrder[right.type];
    return typeDifference === 0
      ? left.destination < right.destination
        ? -1
        : left.destination > right.destination
          ? 1
          : 0
      : typeDifference;
  });
}

function printPreview(plan: ApplyPlan, io: ApplyIo): void {
  for (const operation of previewOperations(plan)) {
    io.stdout(`${operation.type.toUpperCase()} ${operation.destination}`);
  }
}

function printHandoff(
  changedFiles: readonly string[],
  verification: readonly string[],
  io: ApplyIo,
): void {
  io.stdout('Changed files:');
  for (const path of changedFiles) {
    io.stdout(`  ${path}`);
  }
  io.stdout('Review the prepared changes:');
  io.stdout('  git diff --stat');
  io.stdout('  git diff --check');
  io.stdout('Run the recipe verification commands:');
  for (const command of verification) {
    io.stdout(`  ${command}`);
  }
  io.stdout('You decide whether to commit these prepared changes.');
}

export async function runApply(
  recipeId: string,
  options: ApplyOptions,
  io: ApplyIo,
  execution: ApplyExecutionOptions = {},
): Promise<ApplyCommandResult> {
  const platform = execution.transaction?.platform ?? options.platform ?? process.platform;
  const preflight = await preflightApply(recipeId, { ...options, platform }, {
    acceptAfterState: true,
  });
  if (!preflight.ok) {
    io.stderr(preflight.failure.message);
    return Object.freeze({
      kind: 'refused',
      changedFiles: [] as [],
      failure: preflight.failure,
    });
  }

  if ((await classifyApplyPlan(preflight.plan, platform)) === 'after') {
    return applyTransaction(preflight.plan, { platform });
  }

  printPreview(preflight.plan, io);
  if (execution.yes !== true) {
    if (io.confirm === undefined) {
      io.stderr(
        'Interactive confirmation is unavailable. Re-run with --yes to apply the previewed changes.',
      );
      return Object.freeze({ kind: 'refused', changedFiles: [] as [] });
    }
    if (!(await io.confirm('Apply these prepared changes?'))) {
      io.stderr('Apply cancelled; no files were changed.');
      return Object.freeze({ kind: 'cancelled', changedFiles: [] as [] });
    }
  }

  try {
    const result = await applyTransaction(
      preflight.plan,
      { ...execution.transaction, platform },
    );
    if (result.kind === 'applied') {
      const recipe = options.manifest.recipes.find(
        (candidate) => candidate.id === recipeId,
      );
      printHandoff(result.changedFiles, recipe?.verification ?? [], io);
    }
    return result;
  } catch (error) {
    if (
      error instanceof ApplyTransactionError &&
      error.rollbackErrors.length > 0
    ) {
      io.stderr(`Apply failed and rollback was incomplete: ${error.message}`);
      for (const rollbackError of error.rollbackErrors) {
        io.stderr(`Rollback failure: ${rollbackError.message}`);
      }
      if (error.recoveryDirectory !== undefined) {
        io.stderr(`Recovery backups retained at: ${error.recoveryDirectory}`);
      }
      return Object.freeze({ kind: 'refused', changedFiles: [] as [] });
    }
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`Apply failed and was rolled back: ${message}`);
    return Object.freeze({ kind: 'refused', changedFiles: [] as [] });
  }
}

export async function runApplyDryRun(
  recipeId: string,
  options: ApplyOptions,
  io: ApplyIo,
): Promise<ApplyResult> {
  const preflight = await preflightApply(recipeId, options);
  if (!preflight.ok) {
    io.stderr(preflight.failure.message);
    return Object.freeze({
      exitCode: 1,
      kind: 'refused',
      failure: preflight.failure,
    });
  }

  printPreview(preflight.plan, io);
  return Object.freeze({
    exitCode: 0,
    kind: 'dry-run',
    plan: preflight.plan,
  });
}
