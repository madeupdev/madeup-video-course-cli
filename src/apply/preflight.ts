import { lstat, readFile } from 'node:fs/promises';

import type { CourseManifest, Recipe } from '../manifest/types.js';
import { findProjectRoot } from '../project/find-root.js';
import { inspectGitRepository } from '../project/git.js';
import { hashBytes } from '../project/hash.js';
import {
  inspectProjectFile,
  resolveProjectPath,
} from '../project/inspect.js';
import type {
  ProjectFileFinding,
  ProjectPathFinding,
  ResolvedProjectPath,
} from '../project/inspect.js';
import {
  createApplyPlan,
} from './plan.js';
import type {
  ApplyPlan,
  PlannedOperation,
} from './plan.js';

export type ApplyPreflightOptions = {
  startDirectory: string;
  workingBoundary: string;
  sourceRoot: string;
  manifest: CourseManifest;
};

export type ApplyPreflightBehavior = Readonly<{
  acceptAfterState?: boolean;
}>;

export type ApplyPreflightFailure = Readonly<{
  kind:
    | 'unknown-recipe'
    | 'project-identity'
    | 'git-unavailable'
    | 'dirty-worktree'
    | 'unsafe-destination-path'
    | 'unsafe-template-path'
    | 'unsafe-template-source'
    | 'add-destination-exists'
    | 'replace-destination-missing'
    | 'delete-destination-missing'
    | 'destination-unavailable'
    | 'before-hash-mismatch'
    | 'template-unavailable'
    | 'after-hash-mismatch'
    | 'mixed-apply-state';
  message: string;
}>;

export type ApplyPreflightResult =
  | Readonly<{ ok: true; plan: ApplyPlan }>
  | Readonly<{ ok: false; failure: ApplyPreflightFailure }>;

type ApplyPreflightRefusal = Extract<ApplyPreflightResult, { ok: false }>;

function refusal(
  kind: ApplyPreflightFailure['kind'],
  message: string,
): ApplyPreflightRefusal {
  return Object.freeze({
    ok: false,
    failure: Object.freeze({ kind, message }),
  });
}

function pathFailure(
  role: 'destination' | 'template',
  finding: ProjectPathFinding,
): ApplyPreflightRefusal {
  const displayPath = 'relativePath' in finding
    ? finding.relativePath
    : finding.projectRoot;
  if (role === 'destination') {
    return refusal(
      'unsafe-destination-path',
      `Unsafe destination path ${displayPath}: ${finding.kind}`,
    );
  }
  if (finding.kind === 'unsafe-repository-path') {
    return refusal(
      'unsafe-template-path',
      `Unsafe template path ${finding.relativePath}: ${finding.reason}`,
    );
  }
  return refusal(
    'unsafe-template-source',
    `Unsafe template source ${displayPath}: ${finding.kind}`,
  );
}

function fileFailureMessage(finding: ProjectFileFinding): string {
  return 'relativePath' in finding
    ? `${finding.kind}: ${finding.relativePath}`
    : finding.kind;
}

async function verifiedTemplate(
  sourceRoot: string,
  template: string,
  expectedSha256: string,
): Promise<
  | Readonly<{
      ok: true;
      templatePath: string;
      templateBytesBase64: string;
    }>
  | ApplyPreflightRefusal
> {
  const resolved = await resolveProjectPath(sourceRoot, template);
  if (!resolved.ok) {
    return pathFailure('template', resolved.finding);
  }
  const inspected = await inspectProjectFile(sourceRoot, template);
  if (!inspected.ok) {
    if (
      inspected.finding.kind === 'unsafe-repository-path' ||
      inspected.finding.kind === 'symlink-component' ||
      inspected.finding.kind === 'path-inaccessible' ||
      inspected.finding.kind === 'project-root-inaccessible'
    ) {
      return pathFailure('template', inspected.finding);
    }
    return refusal(
      'template-unavailable',
      `Template source unavailable: ${fileFailureMessage(inspected.finding)}`,
    );
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(resolved.path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return refusal(
      'template-unavailable',
      `Template source unavailable: ${template}: ${message}`,
    );
  }
  const actualSha256 = hashBytes(bytes);
  if (actualSha256 !== expectedSha256) {
    return refusal(
      'after-hash-mismatch',
      `Template ${template} does not match afterSha256 ${expectedSha256}; found ${actualSha256}`,
    );
  }

  return Object.freeze({
    ok: true,
    templatePath: resolved.path,
    templateBytesBase64: bytes.toString('base64'),
  });
}

async function destinationExists(
  resolved: ResolvedProjectPath,
): Promise<{ exists: boolean; error?: string }> {
  try {
    await lstat(resolved.path);
    return { exists: true };
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      return { exists: false };
    }
    return {
      exists: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function planOperation(
  projectRoot: string,
  sourceRoot: string,
  operation: Recipe['operations'][number],
  acceptAfterState: boolean,
): Promise<
  | Readonly<{
      ok: true;
      operation: PlannedOperation;
      state: 'before' | 'after';
    }>
  | ApplyPreflightRefusal
> {
  const destination = await resolveProjectPath(
    projectRoot,
    operation.destination,
  );
  if (!destination.ok) {
    return pathFailure('destination', destination.finding);
  }

  if (operation.type === 'add') {
    const existence = await destinationExists(destination);
    if (existence.error !== undefined) {
      return refusal(
        'destination-unavailable',
        `Unable to inspect add destination ${operation.destination}: ${existence.error}`,
      );
    }
    const template = await verifiedTemplate(
      sourceRoot,
      operation.template,
      operation.afterSha256,
    );
    if (!template.ok) {
      return template;
    }
    let state: 'before' | 'after' = 'before';
    if (existence.exists) {
      const inspected = await inspectProjectFile(
        projectRoot,
        operation.destination,
      );
      if (
        !acceptAfterState ||
        !inspected.ok ||
        inspected.file.sha256 !== operation.afterSha256 ||
        inspected.file.mode !== operation.mode
      ) {
        return refusal(
          'add-destination-exists',
          `Add destination already exists: ${operation.destination}`,
        );
      }
      state = 'after';
    }
    return Object.freeze({
      ok: true,
      state,
      operation: Object.freeze({
        ...operation,
        destinationPath: destination.path,
        templatePath: template.templatePath,
        templateBytesBase64: template.templateBytesBase64,
      }),
    });
  }

  const inspected = await inspectProjectFile(
    projectRoot,
    operation.destination,
  );
  if (!inspected.ok) {
    if (inspected.finding.kind === 'missing-file') {
      if (operation.type === 'delete' && acceptAfterState) {
        return Object.freeze({
          ok: true,
          state: 'after',
          operation: Object.freeze({
            ...operation,
            destinationPath: destination.path,
          }),
        });
      }
      const label = operation.type === 'replace' ? 'Replace' : 'Delete';
      return refusal(
        operation.type === 'replace'
          ? 'replace-destination-missing'
          : 'delete-destination-missing',
        `${label} destination is missing: ${operation.destination}`,
      );
    }
    return refusal(
      'destination-unavailable',
      `Destination unavailable: ${fileFailureMessage(inspected.finding)}`,
    );
  }
  const state = inspected.file.sha256 === operation.beforeSha256
    ? 'before'
    : acceptAfterState &&
        operation.type === 'replace' &&
        inspected.file.sha256 === operation.afterSha256 &&
        inspected.file.mode === operation.mode
      ? 'after'
      : undefined;
  if (state === undefined) {
    return refusal(
      'before-hash-mismatch',
      `Destination ${operation.destination} does not match beforeSha256 ${operation.beforeSha256}; found ${inspected.file.sha256}`,
    );
  }

  if (operation.type === 'delete') {
    return Object.freeze({
      ok: true,
      state,
      operation: Object.freeze({
        ...operation,
        destinationPath: destination.path,
      }),
    });
  }

  const template = await verifiedTemplate(
    sourceRoot,
    operation.template,
    operation.afterSha256,
  );
  if (!template.ok) {
    return template;
  }
  return Object.freeze({
    ok: true,
    state,
    operation: Object.freeze({
      ...operation,
      destinationPath: destination.path,
      templatePath: template.templatePath,
      templateBytesBase64: template.templateBytesBase64,
    }),
  });
}

export async function preflightApply(
  recipeId: string,
  options: ApplyPreflightOptions,
  behavior: ApplyPreflightBehavior = {},
): Promise<ApplyPreflightResult> {
  const recipe = options.manifest.recipes.find(
    (candidate) => candidate.id === recipeId,
  );
  if (recipe === undefined) {
    return refusal('unknown-recipe', `Unknown recipe: ${recipeId}`);
  }

  const project = await findProjectRoot(
    options.startDirectory,
    options.workingBoundary,
  );
  if (!project.ok) {
    const message = project.finding.kind === 'wrong-package-name'
      ? `Expected ${project.finding.expectedPackageName}, found ${project.finding.actualPackageName}.`
      : `Unable to locate the course project: ${project.finding.kind}`;
    return refusal('project-identity', message);
  }
  if (project.packageName !== recipe.expectedPackageName) {
    return refusal(
      'project-identity',
      `Expected ${recipe.expectedPackageName}, found ${project.packageName}.`,
    );
  }

  const git = await inspectGitRepository(project.root);
  if (!git.ok) {
    return refusal(
      'git-unavailable',
      `Unable to inspect Git worktree: ${git.finding.kind}`,
    );
  }
  if (!behavior.acceptAfterState && !git.clean) {
    return refusal(
      'dirty-worktree',
      `Git worktree must be clean; found ${git.changes.length} change${git.changes.length === 1 ? '' : 's'}.`,
    );
  }
  const operations: PlannedOperation[] = [];
  const states: Array<'before' | 'after'> = [];
  for (const operation of recipe.operations) {
    const planned = await planOperation(
      project.root,
      options.sourceRoot,
      operation,
      behavior.acceptAfterState === true,
    );
    if (!planned.ok) {
      if (!git.clean) {
        return refusal(
          'dirty-worktree',
          `Git worktree must be clean; found ${git.changes.length} change${git.changes.length === 1 ? '' : 's'}.`,
        );
      }
      return planned;
    }
    operations.push(planned.operation);
    states.push(planned.state);
  }

  if (
    behavior.acceptAfterState &&
    states.includes('before') &&
    states.includes('after')
  ) {
    return refusal(
      'mixed-apply-state',
      'Recipe is partially applied; refusing to write a mixed before/after state.',
    );
  }
  if (states.includes('before') && !git.clean) {
    return refusal(
      'dirty-worktree',
      `Git worktree must be clean; found ${git.changes.length} change${git.changes.length === 1 ? '' : 's'}.`,
    );
  }

  return Object.freeze({
    ok: true,
    plan: createApplyPlan({
      recipeId,
      projectRoot: project.root,
      operations,
    }),
  });
}
