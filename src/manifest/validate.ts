import { z } from 'zod';

import type {
  CourseManifest,
  ManifestIssue,
  ManifestValidationResult,
} from './types.js';
import {
  containsAsciiControl,
  findPortableFilenameIssue,
  filesystemCollisionKey,
} from '../path/portable.js';

const stableIdentifierPattern =
  /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const commitPattern = /^[A-Fa-f0-9]{40}$/;
const sha256Pattern = /^[A-Fa-f0-9]{64}$/;
const semanticVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const githubRepositoryPathPattern =
  /^\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+\/?$/;
const githubRepositoryUrlPattern =
  /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+\/?$/;

const stableIdentifier = z
  .string()
  .regex(
    stableIdentifierPattern,
    'Must use only ASCII letters, digits, and internal hyphens',
  );

const nonEmptyText = z.string().refine(
  (value) => value.trim().length > 0,
  'Must not be empty or whitespace',
);

const verificationCommands = z
  .array(nonEmptyText)
  .min(1, 'Must contain at least one verification command');

const sha256 = z
  .string()
  .regex(sha256Pattern, 'Must be exactly 64 hexadecimal characters');

const lowercaseSha256 = z
  .string()
  .regex(
    /^[a-f0-9]{64}$/,
    'Must be exactly 64 lowercase hexadecimal characters',
  );

const repositoryUrl = z.string().refine((value) => {
  if (!githubRepositoryUrlPattern.test(value)) {
    return false;
  }

  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      githubRepositoryPathPattern.test(url.pathname)
    );
  } catch {
    return false;
  }
}, 'Must be an HTTPS GitHub repository URL without a query or fragment');

const portablePath = z.string().superRefine((value, context) => {
  let message: string | undefined;

  if (value.length === 0) {
    message = 'Must not be empty';
  } else if (containsAsciiControl(value)) {
    message = 'Must not contain ASCII control characters';
  } else if (value.startsWith('/')) {
    message = 'Must be repository-relative, not absolute';
  } else if (/^[A-Za-z]:/.test(value)) {
    message = 'Must not be a Windows drive-letter path';
  } else if (value.startsWith('\\')) {
    message = 'Must not be a UNC or leading-backslash path';
  } else if (value.includes('\\')) {
    message = 'Must use POSIX separators, not backslashes';
  } else {
    const segments = value.split('/');
    if (segments.some((segment) => segment.length === 0)) {
      message = 'Must not contain empty path segments or trailing separators';
    } else if (segments.some((segment) => segment === '.')) {
      message = 'Must not contain current-directory segments';
    } else if (segments.some((segment) => segment === '..')) {
      message = 'Must not contain parent-directory segments';
    } else {
      message = segments
        .map((segment) => findPortableFilenameIssue(segment)?.message)
        .find((issue) => issue !== undefined);
    }
  }

  if (message !== undefined) {
    context.addIssue({
      code: 'custom',
      message,
    });
  }
});

const nfcPortablePath = portablePath.refine(
  (value) => value === value.normalize('NFC'),
  'Must be normalized to NFC',
);

const portableBasename = z.string().superRefine((value, context) => {
  let message: string | undefined;

  if (value.length === 0) {
    message = 'Must not be empty';
  } else if (value.includes('/') || value.includes('\\')) {
    message = 'Must be exactly one portable basename segment';
  } else if (value === '.' || value === '..') {
    message = 'Must not be a current- or parent-directory segment';
  } else if (value !== value.normalize('NFC')) {
    message = 'Must be normalized to NFC';
  } else {
    message = findPortableFilenameIssue(value)?.message;
  }

  if (message !== undefined) {
    context.addIssue({
      code: 'custom',
      message,
    });
  }
});

const constrainedFileSuffix = z.string().superRefine((value, context) => {
  let message: string | undefined;

  if (value.length === 0) {
    message = 'Must not be empty';
  } else if (!/^\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    message =
      'Must start with a period followed by a constrained portable suffix';
  } else if (value.endsWith('.')) {
    message = 'Must not end in a period';
  } else if (value !== value.normalize('NFC')) {
    message = 'Must be normalized to NFC';
  } else {
    message = findPortableFilenameIssue(`file${value}`)?.message;
  }

  if (message !== undefined) {
    context.addIssue({
      code: 'custom',
      message,
    });
  }
});

const assetName = z.string().superRefine((value, context) => {
  let message: string | undefined;

  if (
    value.length <= '.tar.gz'.length ||
    !value.endsWith('.tar.gz')
  ) {
    message = 'Must be a basename ending in .tar.gz';
  } else if (value.includes('/') || value.includes('\\')) {
    message = 'Must not contain directory separators';
  } else {
    message = findPortableFilenameIssue(value)?.message;
  }

  if (message !== undefined) {
    context.addIssue({
      code: 'custom',
      message,
    });
  }
});

const operationMode = z.union([
  z.literal(0o644),
  z.literal(0o755),
]);

const courseTreeFileSchema = z.strictObject({
  path: nfcPortablePath,
  mode: operationMode,
  sha256: lowercaseSha256,
});

const courseTreeSchema = z.strictObject({
  algorithm: z.literal('course-tree-v1'),
  files: z
    .array(courseTreeFileSchema)
    .min(1, 'Must contain at least one course-managed file'),
});

const localFileRuleSchema = z.strictObject({
  type: z.literal('file'),
  path: nfcPortablePath,
});

const localDirectoryRuleSchema = z.strictObject({
  type: z.literal('directory'),
  path: nfcPortablePath,
});

const localDirectoryNameRuleSchema = z.strictObject({
  type: z.literal('directory-name'),
  name: portableBasename,
});

const localFileSuffixRuleSchema = z.strictObject({
  type: z.literal('file-suffix'),
  suffix: constrainedFileSuffix,
});

const localArtifactRuleSchema = z.discriminatedUnion('type', [
  localFileRuleSchema,
  localDirectoryRuleSchema,
  localDirectoryNameRuleSchema,
  localFileSuffixRuleSchema,
]);

const addOperationSchema = z.strictObject({
  type: z.literal('add'),
  destination: portablePath,
  template: portablePath,
  afterSha256: sha256,
  mode: operationMode,
});

const replaceOperationSchema = z.strictObject({
  type: z.literal('replace'),
  destination: portablePath,
  template: portablePath,
  beforeSha256: sha256,
  afterSha256: sha256,
  mode: operationMode,
});

const deleteOperationSchema = z.strictObject({
  type: z.literal('delete'),
  destination: portablePath,
  beforeSha256: sha256,
});

const operationSchema = z.discriminatedUnion('type', [
  addOperationSchema,
  replaceOperationSchema,
  deleteOperationSchema,
]);

const recoveryStateSchema = z.strictObject({
  id: stableIdentifier,
  sourceCommit: z
    .string()
    .regex(commitPattern, 'Must be exactly 40 hexadecimal characters'),
  asset: assetName,
  sha256,
  tree: courseTreeSchema,
  verification: verificationCommands,
});

const recipeSchema = z.strictObject({
  id: stableIdentifier,
  description: nonEmptyText,
  expectedPackageName: z.literal('@madeup-video/storefront'),
  startingState: stableIdentifier,
  resultState: stableIdentifier,
  operations: z
    .array(operationSchema)
    .min(1, 'Must contain at least one operation'),
  verification: verificationCommands,
});

const courseManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  courseVersion: z
    .string()
    .regex(semanticVersionPattern, 'Must be a complete pinned semantic version'),
  project: z.strictObject({
    packageName: z.literal('@madeup-video/storefront'),
    repository: repositoryUrl,
    localArtifacts: z.array(localArtifactRuleSchema),
  }),
  release: z.strictObject({
    repository: repositoryUrl,
    tag: nonEmptyText,
  }),
  recoveryStates: z.array(recoveryStateSchema),
  recipes: z.array(recipeSchema),
});

type UnknownRecord = Record<string, unknown>;
const operationFields = new Set([
  'type',
  'destination',
  'template',
  'beforeSha256',
  'afterSha256',
  'mode',
]);
const localArtifactRuleFields = new Set([
  'type',
  'path',
  'name',
  'suffix',
]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((result, segment) => {
    if (typeof segment === 'number') {
      return `${result}[${segment}]`;
    }

    const property = String(segment);
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(property)) {
      return `${result}.${property}`;
    }

    return `${result}[${JSON.stringify(property)}]`;
  }, '$');
}

function schemaIssues(error: z.ZodError): ManifestIssue[] {
  return error.issues.flatMap((issue) => {
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) => ({
        path: jsonPath([...issue.path, key]),
        message: 'Unknown field',
      }));
    }

    return [
      {
        path: jsonPath(issue.path),
        message: issue.message,
      },
    ];
  });
}

function addFieldIssues(
  schema: z.ZodType,
  value: unknown,
  path: string,
  issues: ManifestIssue[],
): void {
  const parsed = schema.safeParse(value);
  if (parsed.success) {
    return;
  }

  for (const issue of parsed.error.issues) {
    issues.push({
      path: `${path}${jsonPath(issue.path).slice(1)}`,
      message: issue.message,
    });
  }
}

function addInvalidOperationIssues(
  operation: UnknownRecord,
  operationPath: string,
  issues: ManifestIssue[],
): void {
  for (const key of Object.keys(operation)) {
    if (!operationFields.has(key)) {
      issues.push({
        path: `${operationPath}${jsonPath([key]).slice(1)}`,
        message: 'Unknown field',
      });
    }
  }

  addFieldIssues(
    portablePath,
    operation.destination,
    `${operationPath}.destination`,
    issues,
  );

  if ('template' in operation) {
    addFieldIssues(
      portablePath,
      operation.template,
      `${operationPath}.template`,
      issues,
    );
  }
  if ('beforeSha256' in operation) {
    addFieldIssues(
      sha256,
      operation.beforeSha256,
      `${operationPath}.beforeSha256`,
      issues,
    );
  }
  if ('afterSha256' in operation) {
    addFieldIssues(
      sha256,
      operation.afterSha256,
      `${operationPath}.afterSha256`,
      issues,
    );
  }
  if ('mode' in operation) {
    addFieldIssues(
      operationMode,
      operation.mode,
      `${operationPath}.mode`,
      issues,
    );
  }
}

function addInvalidLocalArtifactIssues(
  rule: UnknownRecord,
  rulePath: string,
  issues: ManifestIssue[],
): void {
  for (const key of Object.keys(rule)) {
    if (!localArtifactRuleFields.has(key)) {
      issues.push({
        path: `${rulePath}${jsonPath([key]).slice(1)}`,
        message: 'Unknown field',
      });
    }
  }

  if ('path' in rule) {
    addFieldIssues(
      nfcPortablePath,
      rule.path,
      `${rulePath}.path`,
      issues,
    );
  }
  if ('name' in rule) {
    addFieldIssues(
      portableBasename,
      rule.name,
      `${rulePath}.name`,
      issues,
    );
  }
  if ('suffix' in rule) {
    addFieldIssues(
      constrainedFileSuffix,
      rule.suffix,
      `${rulePath}.suffix`,
      issues,
    );
  }
}

function addDuplicateIssues(
  items: unknown,
  basePath: string,
  property: string,
  message: string,
  issues: ManifestIssue[],
  collisionKey: (value: string) => string = (value) => value,
): void {
  if (!Array.isArray(items)) {
    return;
  }

  const seen = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (!isRecord(item) || typeof item[property] !== 'string') {
      continue;
    }

    const value = item[property];
    const key = collisionKey(value);
    if (seen.has(key)) {
      issues.push({
        path: `${basePath}[${index}].${property}`,
        message,
      });
    } else {
      seen.add(key);
    }
  }
}

const localArtifactTypeOrder = new Map([
  ['file', 0],
  ['directory', 1],
  ['directory-name', 2],
  ['file-suffix', 3],
]);

function targetsRepositoryGitMetadata(value: string): boolean {
  return filesystemCollisionKey(value).split('/')[0] === '.git';
}

function addCourseTreeIssues(
  recoveryStates: unknown,
  issues: ManifestIssue[],
): string[] {
  const declaredPaths: string[] = [];
  if (!Array.isArray(recoveryStates)) {
    return declaredPaths;
  }

  for (const [stateIndex, state] of recoveryStates.entries()) {
    if (!isRecord(state) || !isRecord(state.tree)) {
      continue;
    }

    const files = state.tree.files;
    const filesPath = `$.recoveryStates[${stateIndex}].tree.files`;
    addDuplicateIssues(
      files,
      filesPath,
      'path',
      'Course-tree paths must be unique after NFC normalization and case folding',
      issues,
      filesystemCollisionKey,
    );
    if (!Array.isArray(files)) {
      continue;
    }

    let previousKey: string | undefined;
    for (const [fileIndex, file] of files.entries()) {
      if (!isRecord(file) || typeof file.path !== 'string') {
        continue;
      }

      declaredPaths.push(file.path);
      if (targetsRepositoryGitMetadata(file.path)) {
        issues.push({
          path: `${filesPath}[${fileIndex}].path`,
          message:
            'Repository-root .git metadata is CLI infrastructure, not a course-tree file',
        });
      }
      const key = filesystemCollisionKey(file.path);
      if (previousKey !== undefined && compareText(previousKey, key) > 0) {
        issues.push({
          path: `${filesPath}[${fileIndex}].path`,
          message:
            'Course-tree files must be sorted by normalized lowercase path',
        });
      }
      previousKey = key;
    }
  }

  return declaredPaths;
}

function localArtifactRuleValue(
  rule: UnknownRecord,
):
  | {
      type: string;
      rank: number;
      property: 'path' | 'name' | 'suffix';
      value: string;
    }
  | undefined {
  const type = rule.type;
  if (typeof type !== 'string') {
    return undefined;
  }

  const rank = localArtifactTypeOrder.get(type);
  const property =
    type === 'file' || type === 'directory'
      ? 'path'
      : type === 'directory-name'
        ? 'name'
        : type === 'file-suffix'
          ? 'suffix'
          : undefined;
  if (
    rank === undefined ||
    property === undefined ||
    typeof rule[property] !== 'string'
  ) {
    return undefined;
  }

  return {
    type,
    rank,
    property,
    value: rule[property],
  };
}

function localArtifactMatchesPath(
  rule: ReturnType<typeof localArtifactRuleValue>,
  filePath: string,
): boolean {
  if (rule === undefined) {
    return false;
  }

  const pathKey = filesystemCollisionKey(filePath);
  const valueKey = filesystemCollisionKey(rule.value);
  if (rule.type === 'file') {
    return pathKey === valueKey;
  }
  if (rule.type === 'directory') {
    return pathKey.startsWith(`${valueKey}/`);
  }

  const segments = pathKey.split('/');
  const basename = segments.pop() ?? '';
  if (rule.type === 'directory-name') {
    return segments.some((segment) => segment === valueKey);
  }

  return basename.endsWith(valueKey);
}

function addLocalArtifactIssues(
  localArtifacts: unknown,
  declaredPaths: readonly string[],
  issues: ManifestIssue[],
): void {
  if (!Array.isArray(localArtifacts)) {
    return;
  }

  const seen = new Set<string>();
  let previous:
    | {
        rank: number;
        key: string;
      }
    | undefined;

  for (const [index, rule] of localArtifacts.entries()) {
    if (!isRecord(rule)) {
      continue;
    }

    const rulePath = `$.project.localArtifacts[${index}]`;
    if (
      typeof rule.type !== 'string' ||
      !localArtifactTypeOrder.has(rule.type)
    ) {
      addInvalidLocalArtifactIssues(rule, rulePath, issues);
    }

    const ruleValue = localArtifactRuleValue(rule);
    if (ruleValue === undefined) {
      continue;
    }

    const path = `$.project.localArtifacts[${index}].${ruleValue.property}`;
    const key = filesystemCollisionKey(ruleValue.value);
    const identity = `${ruleValue.type}\0${key}`;
    if (seen.has(identity)) {
      issues.push({
        path,
        message:
          'Local-artifact rules must be unique after NFC normalization and case folding',
      });
    } else {
      seen.add(identity);
    }

    if (
      previous !== undefined &&
      (previous.rank > ruleValue.rank ||
        (previous.rank === ruleValue.rank &&
          compareText(previous.key, key) > 0))
    ) {
      issues.push({
        path,
        message:
          'Local-artifact rules must use deterministic type and value order',
      });
    }
    previous = {
      rank: ruleValue.rank,
      key,
    };

    if (
      ((ruleValue.type === 'file' ||
        ruleValue.type === 'directory') &&
        targetsRepositoryGitMetadata(ruleValue.value)) ||
      ((ruleValue.type === 'directory-name' ||
        ruleValue.type === 'file-suffix') &&
        key === '.git')
    ) {
      issues.push({
        path,
        message:
          'Repository-root .git metadata is excluded by CLI infrastructure policy',
      });
    }

    if (
      declaredPaths.some((declaredPath) =>
        localArtifactMatchesPath(ruleValue, declaredPath),
      )
    ) {
      issues.push({
        path,
        message: 'Local-artifact rule must not match a course-tree file',
      });
    }
  }
}

function addSemanticIssues(input: unknown, issues: ManifestIssue[]): void {
  if (!isRecord(input)) {
    return;
  }

  const declaredPaths = addCourseTreeIssues(input.recoveryStates, issues);
  if (isRecord(input.project)) {
    addLocalArtifactIssues(
      input.project.localArtifacts,
      declaredPaths,
      issues,
    );
  }

  const release = input.release;
  if (
    typeof input.courseVersion === 'string' &&
    isRecord(release) &&
    typeof release.tag === 'string' &&
    release.tag !== `course-v${input.courseVersion}`
  ) {
    issues.push({
      path: '$.release.tag',
      message: 'Must equal course-v${courseVersion}',
    });
  }

  addDuplicateIssues(
    input.recoveryStates,
    '$.recoveryStates',
    'id',
    'Recovery-state IDs must be unique',
    issues,
  );
  addDuplicateIssues(
    input.recoveryStates,
    '$.recoveryStates',
    'asset',
    'Recovery asset names must be unique',
    issues,
    filesystemCollisionKey,
  );
  addDuplicateIssues(
    input.recipes,
    '$.recipes',
    'id',
    'Recipe IDs must be unique',
    issues,
  );

  const recoveryIds = new Set<string>();
  if (Array.isArray(input.recoveryStates)) {
    for (const state of input.recoveryStates) {
      if (isRecord(state) && typeof state.id === 'string') {
        recoveryIds.add(state.id);
      }
    }
  }

  if (!Array.isArray(input.recipes)) {
    return;
  }

  for (const [recipeIndex, recipe] of input.recipes.entries()) {
    if (!isRecord(recipe)) {
      continue;
    }

    const recipePath = `$.recipes[${recipeIndex}]`;
    if (
      typeof recipe.startingState === 'string' &&
      !recoveryIds.has(recipe.startingState)
    ) {
      issues.push({
        path: `${recipePath}.startingState`,
        message: 'Must reference an existing recovery-state ID',
      });
    }
    if (
      typeof recipe.resultState === 'string' &&
      !recoveryIds.has(recipe.resultState)
    ) {
      issues.push({
        path: `${recipePath}.resultState`,
        message: 'Must reference an existing recovery-state ID',
      });
    }
    if (
      typeof recipe.startingState === 'string' &&
      typeof recipe.resultState === 'string' &&
      recipe.startingState === recipe.resultState
    ) {
      issues.push({
        path: `${recipePath}.resultState`,
        message: 'Must differ from startingState',
      });
    }

    if (!Array.isArray(recipe.operations)) {
      continue;
    }

    const destinations = new Set<string>();
    const templates = new Set<string>();
    for (const [operationIndex, operation] of recipe.operations.entries()) {
      if (!isRecord(operation)) {
        continue;
      }

      const operationPath = `${recipePath}.operations[${operationIndex}]`;
      if (
        operation.type !== 'add' &&
        operation.type !== 'replace' &&
        operation.type !== 'delete'
      ) {
        addInvalidOperationIssues(operation, operationPath, issues);
      }

      if (typeof operation.destination === 'string') {
        const foldedDestination = filesystemCollisionKey(
          operation.destination,
        );
        if (destinations.has(foldedDestination)) {
          issues.push({
            path: `${operationPath}.destination`,
            message: 'Destinations must be unique ignoring case',
          });
        } else {
          destinations.add(foldedDestination);
        }
      }

      if (
        (operation.type === 'add' || operation.type === 'replace') &&
        typeof operation.template === 'string'
      ) {
        const foldedTemplate = filesystemCollisionKey(operation.template);
        if (templates.has(foldedTemplate)) {
          issues.push({
            path: `${operationPath}.template`,
            message: 'Template paths must be unique ignoring case',
          });
        } else {
          templates.add(foldedTemplate);
        }
      }
    }
  }
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function deterministicIssues(issues: ManifestIssue[]): ManifestIssue[] {
  const unique = new Map<string, ManifestIssue>();
  for (const issue of issues) {
    unique.set(`${issue.path}\0${issue.message}`, issue);
  }

  return [...unique.values()].sort(
    (left, right) =>
      compareText(left.path, right.path) ||
      compareText(left.message, right.message),
  );
}

export function validateManifest(input: unknown): ManifestValidationResult {
  const parsed = courseManifestSchema.safeParse(input);
  const issues = parsed.success ? [] : schemaIssues(parsed.error);
  addSemanticIssues(input, issues);

  const sortedIssues = deterministicIssues(issues);
  if (!parsed.success || sortedIssues.length > 0) {
    return {
      ok: false,
      issues: sortedIssues,
    };
  }

  const manifest: CourseManifest = parsed.data;
  return {
    ok: true,
    manifest,
  };
}
