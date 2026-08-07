import type { ApplyPlan, PlannedOperation } from '../apply/plan.js';
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
};

export type ApplyOptions = ApplyPreflightOptions;

export type ApplyResult =
  | Readonly<{ exitCode: 0; kind: 'dry-run'; plan: ApplyPlan }>
  | Readonly<{
      exitCode: 1;
      kind: 'refused';
      failure: Extract<ApplyPreflightResult, { ok: false }>['failure'];
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

  for (const operation of previewOperations(preflight.plan)) {
    io.stdout(`${operation.type.toUpperCase()} ${operation.destination}`);
  }
  return Object.freeze({
    exitCode: 0,
    kind: 'dry-run',
    plan: preflight.plan,
  });
}
