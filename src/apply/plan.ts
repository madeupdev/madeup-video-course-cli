export type PlannedAddOperation = Readonly<{
  type: 'add';
  destination: string;
  destinationPath: string;
  template: string;
  templatePath: string;
  templateBytesBase64: string;
  afterSha256: string;
  mode: number;
}>;

export type PlannedReplaceOperation = Readonly<{
  type: 'replace';
  destination: string;
  destinationPath: string;
  template: string;
  templatePath: string;
  templateBytesBase64: string;
  beforeSha256: string;
  afterSha256: string;
  mode: number;
}>;

export type PlannedDeleteOperation = Readonly<{
  type: 'delete';
  destination: string;
  destinationPath: string;
  beforeSha256: string;
}>;

export type PlannedOperation =
  | PlannedAddOperation
  | PlannedReplaceOperation
  | PlannedDeleteOperation;

export type ApplyPlan = Readonly<{
  recipeId: string;
  projectRoot: string;
  operations: readonly PlannedOperation[];
}>;

export function createApplyPlan(input: {
  recipeId: string;
  projectRoot: string;
  operations: PlannedOperation[];
}): ApplyPlan {
  const operations = input.operations
    .map((operation) => Object.freeze({ ...operation }))
    .sort((left, right) =>
      left.destination < right.destination
        ? -1
        : left.destination > right.destination
          ? 1
          : 0,
    );

  return Object.freeze({
    recipeId: input.recipeId,
    projectRoot: input.projectRoot,
    operations: Object.freeze(operations),
  });
}
