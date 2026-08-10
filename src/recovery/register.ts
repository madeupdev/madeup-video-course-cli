import {
  containsAsciiControl,
  filesystemCollisionKey,
  findPortableFilenameIssue,
} from '../path/portable.js';

export type BuilderIdentity = Readonly<{
  packageName: string;
  repository: string;
}>;

export type RegisterIssue = Readonly<{
  path: string;
  message: string;
}>;

export type LocalArtifactRule =
  | Readonly<{ type: 'file'; path: string }>
  | Readonly<{ type: 'directory'; path: string }>
  | Readonly<{ type: 'directory-name'; name: string }>
  | Readonly<{ type: 'file-suffix'; suffix: string }>;

export type RecoveryRegisterState = Readonly<{
  id: string;
  sourceCommit: string;
  asset: string;
  sha256: string;
  status: 'draft' | 'published';
  verification: string[];
  authoringNotes?: string;
}>;

export type RecoveryRegister = Readonly<{
  schemaVersion: 1;
  courseVersion: string;
  cliVersion: string;
  cli: Readonly<{ packageName: string; repository: string }>;
  project: Readonly<{
    packageName: string;
    repository: string;
    localArtifacts: LocalArtifactRule[];
  }>;
  release: Readonly<{
    repository: string;
    tag: string;
    maxAssetBytes: number;
  }>;
  states: RecoveryRegisterState[];
  recipes: ReadonlyArray<Record<string, unknown>>;
  authoringNotes?: string;
}>;

export type RecoveryRegisterValidationResult =
  | Readonly<{ ok: true; register: RecoveryRegister }>
  | Readonly<{ ok: false; issues: RegisterIssue[] }>;

type UnknownRecord = Record<string, unknown>;

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const commitPattern = /^[a-f0-9]{40}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const identifierPattern = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const repositoryPattern =
  /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

const rootFields = new Set([
  'schemaVersion',
  'courseVersion',
  'cliVersion',
  'cli',
  'project',
  'release',
  'states',
  'recipes',
  'authoringNotes',
]);
const cliFields = new Set(['packageName', 'repository']);
const projectFields = new Set(['packageName', 'repository', 'localArtifacts']);
const releaseFields = new Set(['repository', 'tag', 'maxAssetBytes']);
const stateFields = new Set([
  'id',
  'sourceCommit',
  'asset',
  'sha256',
  'status',
  'verification',
  'authoringNotes',
]);
const recipeFields = new Set([
  'id',
  'description',
  'expectedPackageName',
  'startingState',
  'resultState',
  'operations',
  'verification',
  'authoringNotes',
]);
const operationFields = new Set([
  'type',
  'destination',
  'template',
  'beforeSha256',
  'afterSha256',
  'mode',
]);
const localArtifactFields = new Set(['type', 'path', 'name', 'suffix']);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function addIssue(issues: RegisterIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

function unknownFields(
  value: unknown,
  allowed: ReadonlySet<string>,
  path: string,
  issues: RegisterIssue[],
): void {
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) addIssue(issues, `${path}.${key}`, 'Unknown field');
  }
}

function requireRecord(
  value: unknown,
  path: string,
  issues: RegisterIssue[],
): value is UnknownRecord {
  if (!isRecord(value)) {
    addIssue(issues, path, 'Must be an object');
    return false;
  }
  return true;
}

function requireText(
  value: unknown,
  path: string,
  issues: RegisterIssue[],
): value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    addIssue(issues, path, 'Must be a non-empty string');
    return false;
  }
  return true;
}

function validateOptionalNotes(
  value: UnknownRecord,
  path: string,
  issues: RegisterIssue[],
): void {
  if ('authoringNotes' in value) {
    requireText(value.authoringNotes, `${path}.authoringNotes`, issues);
  }
}

function validateRepository(
  value: unknown,
  path: string,
  issues: RegisterIssue[],
): value is string {
  if (!requireText(value, path, issues)) return false;
  if (!repositoryPattern.test(value) || value.endsWith('.git')) {
    addIssue(
      issues,
      path,
      'Must be a canonical HTTPS GitHub repository URL without .git, credentials, query, fragment, or trailing slash',
    );
    return false;
  }
  return true;
}

function portablePathIssue(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return 'Must be non-empty';
  if (value !== value.normalize('NFC')) return 'Must be normalized to NFC';
  if (containsAsciiControl(value)) return 'Must not contain control characters';
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.startsWith('\\')) {
    return 'Must be repository-relative';
  }
  if (value.includes('\\')) return 'Must use POSIX separators';
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return 'Must not contain empty, current-directory, or parent-directory segments';
  }
  return segments
    .map((segment) => findPortableFilenameIssue(segment)?.message)
    .find((message) => message !== undefined);
}

function validateCommands(
  value: unknown,
  path: string,
  issues: RegisterIssue[],
): void {
  if (!Array.isArray(value) || value.length === 0) {
    addIssue(issues, path, 'Must contain at least one verification command');
    return;
  }
  value.forEach((command, index) =>
    requireText(command, `${path}[${index}]`, issues),
  );
}

function validateLocalArtifacts(
  value: unknown,
  issues: RegisterIssue[],
): void {
  const path = '$.project.localArtifacts';
  if (!Array.isArray(value)) {
    addIssue(issues, path, 'Must be an array');
    return;
  }
  const seen = new Set<string>();
  value.forEach((rule, index) => {
    const rulePath = `${path}[${index}]`;
    if (!requireRecord(rule, rulePath, issues)) return;
    unknownFields(rule, localArtifactFields, rulePath, issues);
    const fieldByType: Record<string, 'path' | 'name' | 'suffix'> = {
      file: 'path',
      directory: 'path',
      'directory-name': 'name',
      'file-suffix': 'suffix',
    };
    const type = typeof rule.type === 'string' ? rule.type : '';
    const field = fieldByType[type];
    if (field === undefined) {
      addIssue(
        issues,
        `${rulePath}.type`,
        'Must be file, directory, directory-name, or file-suffix',
      );
      return;
    }
    const expectedFields = new Set(['type', field]);
    for (const key of Object.keys(rule)) {
      if (!expectedFields.has(key)) {
        addIssue(issues, `${rulePath}.${key}`, `Must not be present on ${type} rules`);
      }
    }
    const fieldPath = `${rulePath}.${field}`;
    if (!requireText(rule[field], fieldPath, issues)) return;
    const fieldValue = rule[field] as string;
    let message: string | undefined;
    if (field === 'path') {
      message = portablePathIssue(fieldValue);
    } else if (field === 'name') {
      if (fieldValue.includes('/') || fieldValue.includes('\\')) {
        message = 'Must be exactly one portable basename';
      } else {
        message = portablePathIssue(fieldValue);
      }
    } else if (
      !/^\.[A-Za-z0-9][A-Za-z0-9._-]*$/.test(fieldValue) ||
      fieldValue.endsWith('.')
    ) {
      message = 'Must be a constrained portable file suffix';
    }
    if (message !== undefined) addIssue(issues, fieldPath, message);
    const key = `${type}\0${filesystemCollisionKey(fieldValue)}`;
    if (seen.has(key)) addIssue(issues, fieldPath, 'Local artifact rules must be unique');
    seen.add(key);
  });
}

function validateOperation(
  operation: unknown,
  path: string,
  issues: RegisterIssue[],
): void {
  if (!requireRecord(operation, path, issues)) return;
  unknownFields(operation, operationFields, path, issues);
  const type = operation.type;
  if (type !== 'add' && type !== 'replace' && type !== 'delete') {
    addIssue(issues, `${path}.type`, 'Must be add, replace, or delete');
    return;
  }
  const required: Record<typeof type, string[]> = {
    add: ['destination', 'template', 'afterSha256', 'mode'],
    replace: ['destination', 'template', 'beforeSha256', 'afterSha256', 'mode'],
    delete: ['destination', 'beforeSha256'],
  };
  for (const field of required[type]) {
    if (!(field in operation)) addIssue(issues, `${path}.${field}`, 'Field is required');
  }
  for (const field of ['destination', 'template'] as const) {
    if (field in operation) {
      const message = portablePathIssue(operation[field]);
      if (message !== undefined) addIssue(issues, `${path}.${field}`, message);
    }
  }
  for (const field of ['beforeSha256', 'afterSha256'] as const) {
    if (field in operation && !sha256Pattern.test(String(operation[field]))) {
      addIssue(issues, `${path}.${field}`, 'Must be exactly 64 lowercase hexadecimal characters');
    }
  }
  if ('mode' in operation && operation.mode !== 0o644 && operation.mode !== 0o755) {
    addIssue(issues, `${path}.mode`, 'Must be 420 (0644) or 493 (0755)');
  }
  const prohibited: Record<typeof type, string[]> = {
    add: ['beforeSha256'],
    replace: [],
    delete: ['template', 'afterSha256', 'mode'],
  };
  for (const field of prohibited[type]) {
    if (field in operation) {
      addIssue(issues, `${path}.${field}`, `Must not be present on ${type} operations`);
    }
  }
}

function validateRecipes(
  value: unknown,
  stateIds: ReadonlySet<string>,
  projectPackageName: unknown,
  issues: RegisterIssue[],
): void {
  if (!Array.isArray(value)) {
    addIssue(issues, '$.recipes', 'Must be an array');
    return;
  }
  const recipeIds = new Set<string>();
  value.forEach((recipe, index) => {
    const path = `$.recipes[${index}]`;
    if (!requireRecord(recipe, path, issues)) return;
    unknownFields(recipe, recipeFields, path, issues);
    validateOptionalNotes(recipe, path, issues);
    if (requireText(recipe.id, `${path}.id`, issues)) {
      if (
        !identifierPattern.test(recipe.id) ||
        findPortableFilenameIssue(recipe.id) !== undefined
      ) {
        addIssue(issues, `${path}.id`, 'Must be a stable hyphen-separated ASCII identifier');
      }
      const key = filesystemCollisionKey(recipe.id);
      if (recipeIds.has(key)) addIssue(issues, `${path}.id`, 'Recipe IDs must be unique ignoring portable case');
      recipeIds.add(key);
    }
    requireText(recipe.description, `${path}.description`, issues);
    if (recipe.expectedPackageName !== projectPackageName) {
      addIssue(issues, `${path}.expectedPackageName`, 'Must equal project.packageName');
    }
    for (const field of ['startingState', 'resultState'] as const) {
      if (typeof recipe[field] !== 'string' || !stateIds.has(recipe[field])) {
        addIssue(issues, `${path}.${field}`, 'Must reference an existing state ID');
      }
    }
    if (
      typeof recipe.startingState === 'string' &&
      recipe.startingState === recipe.resultState
    ) {
      addIssue(issues, `${path}.resultState`, 'Must differ from startingState');
    }
    if (!Array.isArray(recipe.operations) || recipe.operations.length === 0) {
      addIssue(issues, `${path}.operations`, 'Must contain at least one operation');
    } else {
      recipe.operations.forEach((operation, operationIndex) =>
        validateOperation(operation, `${path}.operations[${operationIndex}]`, issues),
      );
    }
    validateCommands(recipe.verification, `${path}.verification`, issues);
  });
}

function deterministicIssues(issues: RegisterIssue[]): RegisterIssue[] {
  const unique = new Map<string, RegisterIssue>();
  for (const issue of issues) unique.set(`${issue.path}\0${issue.message}`, issue);
  return [...unique.values()].sort(
    (left, right) =>
      compareText(left.path, right.path) || compareText(left.message, right.message),
  );
}

export function validateRecoveryRegister(
  input: unknown,
  builderIdentity: BuilderIdentity,
): RecoveryRegisterValidationResult {
  let parsed = input;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input) as unknown;
    } catch {
      return { ok: false, issues: [{ path: '$', message: 'Malformed JSON' }] };
    }
  }

  const issues: RegisterIssue[] = [];
  if (!requireRecord(parsed, '$', issues)) return { ok: false, issues };
  unknownFields(parsed, rootFields, '$', issues);
  validateOptionalNotes(parsed, '$', issues);

  if (parsed.schemaVersion !== 1) addIssue(issues, '$.schemaVersion', 'Must equal 1');
  for (const field of ['courseVersion', 'cliVersion'] as const) {
    if (
      !requireText(parsed[field], `$.${field}`, issues) ||
      !semverPattern.test(parsed[field] as string)
    ) {
      addIssue(issues, `$.${field}`, 'Must be a complete pinned semantic version');
    }
  }
  if (
    typeof parsed.courseVersion === 'string' &&
    typeof parsed.cliVersion === 'string' &&
    parsed.courseVersion !== parsed.cliVersion
  ) {
    addIssue(issues, '$.cliVersion', 'Must equal courseVersion for the aligned course edition');
  }

  if (requireRecord(parsed.cli, '$.cli', issues)) {
    unknownFields(parsed.cli, cliFields, '$.cli', issues);
    if (parsed.cli.packageName !== builderIdentity.packageName) {
      addIssue(issues, '$.cli.packageName', `Must equal ${builderIdentity.packageName}`);
    }
    if (validateRepository(parsed.cli.repository, '$.cli.repository', issues)) {
      if (parsed.cli.repository !== builderIdentity.repository) {
        addIssue(issues, '$.cli.repository', 'Must identify the running builder package repository');
      }
    }
  }

  if (requireRecord(parsed.project, '$.project', issues)) {
    unknownFields(parsed.project, projectFields, '$.project', issues);
    requireText(parsed.project.packageName, '$.project.packageName', issues);
    validateRepository(parsed.project.repository, '$.project.repository', issues);
    validateLocalArtifacts(parsed.project.localArtifacts, issues);
  }

  if (requireRecord(parsed.release, '$.release', issues)) {
    unknownFields(parsed.release, releaseFields, '$.release', issues);
    validateRepository(parsed.release.repository, '$.release.repository', issues);
    if (
      isRecord(parsed.project) &&
      parsed.release.repository !== parsed.project.repository
    ) {
      addIssue(issues, '$.release.repository', 'Must equal project.repository');
    }
    const alignedTag = `course-v${String(parsed.courseVersion)}`;
    if (parsed.release.tag !== alignedTag) {
      addIssue(issues, '$.release.tag', `Must equal ${alignedTag}`);
    }
    if (!('maxAssetBytes' in parsed.release)) {
      addIssue(issues, '$.release.maxAssetBytes', 'Field is required');
    } else if (!Number.isInteger(parsed.release.maxAssetBytes)) {
      addIssue(issues, '$.release.maxAssetBytes', 'Must be an integer');
    } else if ((parsed.release.maxAssetBytes as number) <= 0) {
      addIssue(issues, '$.release.maxAssetBytes', 'Must be greater than zero');
    } else if (!Number.isSafeInteger(parsed.release.maxAssetBytes)) {
      addIssue(issues, '$.release.maxAssetBytes', 'Must be a safe integer');
    }
  }

  const states = Array.isArray(parsed.states) ? parsed.states : [];
  if (!Array.isArray(parsed.states)) addIssue(issues, '$.states', 'Must be an array');
  if (Array.isArray(parsed.states) && parsed.states.length === 0) {
    addIssue(issues, '$.states', 'Must contain at least one recovery state');
  }
  const ids = new Set<string>();
  const validIds = new Set<string>();
  const assets = new Set<string>();
  states.forEach((state, index) => {
    const path = `$.states[${index}]`;
    if (!requireRecord(state, path, issues)) return;
    unknownFields(state, stateFields, path, issues);
    validateOptionalNotes(state, path, issues);
    if (requireText(state.id, `${path}.id`, issues)) {
      if (
        !identifierPattern.test(state.id) ||
        findPortableFilenameIssue(state.id) !== undefined
      ) {
        addIssue(issues, `${path}.id`, 'Must be a stable hyphen-separated ASCII identifier');
      } else {
        validIds.add(state.id);
      }
      const key = filesystemCollisionKey(state.id);
      if (ids.has(key)) addIssue(issues, `${path}.id`, 'State IDs must be unique ignoring portable case');
      ids.add(key);
    }
    if (!commitPattern.test(String(state.sourceCommit))) {
      addIssue(issues, `${path}.sourceCommit`, 'Must be exactly 40 lowercase hexadecimal characters');
    }
    if (
      typeof state.asset !== 'string' ||
      typeof state.id !== 'string' ||
      state.asset !== `${state.id}.tar.gz` ||
      portablePathIssue(state.asset) !== undefined ||
      state.asset.includes('/')
    ) {
      addIssue(issues, `${path}.asset`, 'Must equal ${id}.tar.gz as one portable basename');
    }
    if (typeof state.asset === 'string') {
      const key = filesystemCollisionKey(state.asset);
      if (assets.has(key)) addIssue(issues, `${path}.asset`, 'Recovery asset names must be unique ignoring portable case');
      assets.add(key);
    }
    if (state.status !== 'draft' && state.status !== 'published') {
      addIssue(issues, `${path}.status`, 'Must be draft or published');
    }
    if (state.sha256 !== 'PENDING' && !sha256Pattern.test(String(state.sha256))) {
      addIssue(issues, `${path}.sha256`, 'Must be PENDING or exactly 64 lowercase hexadecimal characters');
    }
    if (state.sha256 === 'PENDING' && state.status !== 'draft') {
      addIssue(issues, `${path}.sha256`, 'PENDING is permitted only for draft states');
    }
    validateCommands(state.verification, `${path}.verification`, issues);
  });

  validateRecipes(
    parsed.recipes,
    validIds,
    isRecord(parsed.project) ? parsed.project.packageName : undefined,
    issues,
  );

  const sorted = deterministicIssues(issues);
  return sorted.length === 0
    ? { ok: true, register: parsed as unknown as RecoveryRegister }
    : { ok: false, issues: sorted };
}

export function formatRegisterIssues(issues: readonly RegisterIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n');
}
