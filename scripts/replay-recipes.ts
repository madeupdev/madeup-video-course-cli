#!/usr/bin/env node

import { spawn } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { runCli } from '../src/cli.js';
import { loadManifest } from '../src/manifest/load.js';
import type { Recipe } from '../src/manifest/types.js';
import {
  containsAsciiControl,
  filesystemCollisionKey,
  findPortableFilenameIssue,
} from '../src/path/portable.js';

export type ReplayTreeEntry = Readonly<{
  path: string;
  bytes: Buffer;
  mode: 0o644 | 0o755;
}>;

export type TrustedVerification = Readonly<{
  command: string;
  args: readonly string[];
}>;

export type VerificationResult = Readonly<{
  command: string;
  args: readonly string[];
  stdout: string;
  stderr: string;
}>;

export type ReplayRecipeOptions = Readonly<{
  sourceRepository: string;
  sourceRoot: string;
  manifestPath: string;
  recipeId: string;
  temporaryParent?: string;
  trustedVerification?: readonly TrustedVerification[];
  platform?: NodeJS.Platform;
}>;

export type ReplayRecipeResult = Readonly<{
  firstApply: Readonly<{ kind: 'applied'; changedFiles: string[] }>;
  secondApply: Readonly<{ kind: 'already-applied'; changedFiles: [] }>;
  firstStdout: string[];
  secondStdout: string[];
  verifiedPaths: string[];
  verification: VerificationResult[];
  modeComparison: 'native-filesystem' | 'git-index-projection';
}>;

type ProcessResult = Readonly<{
  stdout: Buffer;
  stderr: Buffer;
}>;

const commitPattern = /^[a-f0-9]{40}$/u;

function controlledEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const inheritedNames = [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'ComSpec',
    'HOME',
    'USERPROFILE',
    'TMPDIR',
    'TEMP',
    'TMP',
    'LANG',
    'LC_ALL',
  ] as const;
  const environment: NodeJS.ProcessEnv = { NO_COLOR: '1' };
  for (const name of inheritedNames) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return { ...environment, ...extra };
}

async function execute(
  command: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; env?: NodeJS.ProcessEnv }>,
): Promise<ProcessResult> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: controlledEnvironment(options.env),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      const output = Buffer.concat(stdout);
      const errors = Buffer.concat(stderr);
      if (code !== 0) {
        const detail = [
          `${command} ${args.join(' ')} failed${signal === null ? ` with exit code ${String(code)}` : ` from signal ${signal}`}`,
          output.length === 0 ? undefined : `stdout:\n${output.toString('utf8')}`,
          errors.length === 0 ? undefined : `stderr:\n${errors.toString('utf8')}`,
        ].filter((part) => part !== undefined).join('\n');
        reject(new Error(detail));
        return;
      }
      resolveProcess({ stdout: output, stderr: errors });
    });
  });
}

async function git(
  repository: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  return execute('git', args, {
    cwd: repository,
    env: {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      ...env,
    },
  });
}

function validateCommit(commit: string, label: string): void {
  if (!commitPattern.test(commit)) {
    throw new Error(`${label} commit must be exactly 40 lowercase hexadecimal characters`);
  }
}

export function validateReplayPath(path: string): void {
  const segments = path.split('/');
  if (
    path.length === 0 ||
    path !== path.normalize('NFC') ||
    path.startsWith('/') ||
    path.includes('\\') ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
    segments[0]?.toLowerCase() === '.git' ||
    containsAsciiControl(path) ||
    segments.some((segment) => findPortableFilenameIssue(segment) !== undefined)
  ) {
    throw new Error(`Unsafe Git tree path: ${JSON.stringify(path)}`);
  }
}

function splitNul(buffer: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (const [position, byte] of buffer.entries()) {
    if (byte !== 0) continue;
    parts.push(buffer.subarray(start, position));
    start = position + 1;
  }
  if (start !== buffer.length) throw new Error('Git returned a non-NUL-terminated record');
  return parts;
}

async function verifyCommit(repository: string, commit: string, label: string): Promise<void> {
  validateCommit(commit, label);
  const result = await git(repository, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${commit}^{commit}`,
  ]);
  if (result.stdout.toString('utf8').trim() !== commit) {
    throw new Error(`${label} commit did not resolve exactly to ${commit}`);
  }
}

async function readCommitTree(repository: string, commit: string): Promise<ReplayTreeEntry[]> {
  const listing = await git(repository, [
    'ls-tree',
    '-r',
    '-z',
    '--full-tree',
    commit,
  ]);
  const entries: ReplayTreeEntry[] = [];
  const collisionKeys = new Map<string, string>();
  for (const record of splitNul(listing.stdout)) {
    const text = record.toString('utf8');
    const match = /^(100644|100755) blob ([a-f0-9]{40,64})\t(.+)$/u.exec(text);
    if (match === null) {
      throw new Error(`Unsupported Git tree entry: ${JSON.stringify(text)}`);
    }
    const [, gitMode, objectId, path] = match;
    if (objectId === undefined || path === undefined) throw new Error('Malformed Git tree entry');
    validateReplayPath(path);
    const collisionKey = filesystemCollisionKey(path);
    const collidingPath = collisionKeys.get(collisionKey);
    if (collidingPath !== undefined) {
      throw new Error(`Git tree contains non-portable colliding paths: ${collidingPath} and ${path}`);
    }
    collisionKeys.set(collisionKey, path);
    const object = await git(repository, ['cat-file', 'blob', objectId]);
    entries.push({
      path,
      bytes: object.stdout,
      mode: gitMode === '100755' ? 0o755 : 0o644,
    });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path, 'en'));
}

async function exportTree(projectRoot: string, entries: readonly ReplayTreeEntry[]): Promise<void> {
  await mkdir(projectRoot);
  for (const entry of entries) {
    const destination = join(projectRoot, ...entry.path.split('/'));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, entry.bytes, { flag: 'wx', mode: entry.mode });
    await chmod(destination, entry.mode);
  }
}

async function setIndexMode(
  repository: string,
  path: string,
  mode: 0o644 | 0o755,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  await git(
    repository,
    ['update-index', mode === 0o755 ? '--chmod=+x' : '--chmod=-x', '--', path],
    env,
  );
}

async function initialiseRepository(
  projectRoot: string,
  startingTree: readonly ReplayTreeEntry[],
  platform: NodeJS.Platform,
): Promise<void> {
  await git(projectRoot, ['init', '-q']);
  await git(projectRoot, ['config', 'user.email', 'replay@example.test']);
  await git(projectRoot, ['config', 'user.name', 'Recipe Replay']);
  await git(projectRoot, ['config', 'commit.gpgsign', 'false']);
  await git(projectRoot, ['config', 'core.filemode', platform === 'win32' ? 'false' : 'true']);
  await git(projectRoot, ['add', '--all']);
  if (platform === 'win32') {
    for (const entry of startingTree) await setIndexMode(projectRoot, entry.path, entry.mode);
  }
  await git(projectRoot, ['commit', '-qm', 'exported recipe starting commit']);
}

async function worktreeFiles(root: string, relative = ''): Promise<string[]> {
  const directory = join(root, ...relative.split('/').filter(Boolean));
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    if (relative === '' && entry.name === '.git') continue;
    const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
    validateReplayPath(path);
    if (entry.isDirectory()) {
      paths.push(...await worktreeFiles(root, path));
    } else if (entry.isFile()) {
      paths.push(path);
    } else {
      throw new Error(`Unsupported replay worktree entry: ${path}`);
    }
  }
  return paths.sort((left, right) => left.localeCompare(right, 'en'));
}

function intendedWindowsModes(
  startingTree: readonly ReplayTreeEntry[],
  recipe: Recipe,
): Map<string, 0o644 | 0o755> {
  // Windows filesystems do not expose Git's executable bit. Project the
  // successfully applied worktree into a separate index: unchanged paths
  // inherit the starting commit mode, while add/replace paths use the
  // declarative operation mode. Comparing this index metadata with the result
  // commit makes an incorrect recipe mode fail without mutating the real index.
  const modes = new Map(startingTree.map((entry) => [entry.path, entry.mode]));
  for (const operation of recipe.operations) {
    if (operation.type === 'delete') modes.delete(operation.destination);
    else if (operation.mode === 0o644 || operation.mode === 0o755) {
      modes.set(operation.destination, operation.mode);
    } else {
      throw new Error(`Unsupported recipe mode for ${operation.destination}: ${String(operation.mode)}`);
    }
  }
  return modes;
}

async function windowsIndexModes(
  projectRoot: string,
  replayRoot: string,
  paths: readonly string[],
  startingTree: readonly ReplayTreeEntry[],
  recipe: Recipe,
): Promise<Map<string, 0o644 | 0o755>> {
  const indexPath = join(replayRoot, 'mode-index');
  const env = { GIT_INDEX_FILE: indexPath };
  await git(projectRoot, ['read-tree', '--empty'], env);
  await git(projectRoot, ['add', '--all', '--'], env);
  const intended = intendedWindowsModes(startingTree, recipe);
  for (const path of paths) {
    await setIndexMode(projectRoot, path, intended.get(path) ?? 0o644, env);
  }
  const listing = await git(projectRoot, ['ls-files', '--stage', '-z'], env);
  const modes = new Map<string, 0o644 | 0o755>();
  for (const record of splitNul(listing.stdout)) {
    const text = record.toString('utf8');
    const match = /^(100644|100755) [a-f0-9]{40,64} 0\t(.+)$/u.exec(text);
    if (match === null || match[2] === undefined) {
      throw new Error(`Malformed Git index entry: ${JSON.stringify(text)}`);
    }
    modes.set(match[2], match[1] === '100755' ? 0o755 : 0o644);
  }
  return modes;
}

async function readWorktree(
  projectRoot: string,
  replayRoot: string,
  startingTree: readonly ReplayTreeEntry[],
  recipe: Recipe,
  platform: NodeJS.Platform,
): Promise<ReplayTreeEntry[]> {
  const paths = await worktreeFiles(projectRoot);
  const indexModes = platform === 'win32'
    ? await windowsIndexModes(projectRoot, replayRoot, paths, startingTree, recipe)
    : undefined;
  return Promise.all(paths.map(async (path) => {
    const absolutePath = join(projectRoot, ...path.split('/'));
    const fileMode = platform === 'win32'
      ? indexModes?.get(path)
      : ((await stat(absolutePath)).mode & 0o111) === 0 ? 0o644 : 0o755;
    if (fileMode === undefined) throw new Error(`Git index mode is missing for ${path}`);
    return { path, bytes: await readFile(absolutePath), mode: fileMode };
  }));
}

export function firstTreeMismatch(
  expectedEntries: readonly ReplayTreeEntry[],
  actualEntries: readonly ReplayTreeEntry[],
): string | undefined {
  const expected = new Map(expectedEntries.map((entry) => [entry.path, entry]));
  const actual = new Map(actualEntries.map((entry) => [entry.path, entry]));
  for (const path of [...expected.keys()].sort()) {
    if (!actual.has(path)) return `missing path: ${path}`;
  }
  for (const path of [...actual.keys()].sort()) {
    if (!expected.has(path)) return `unexpected path: ${path}`;
  }
  for (const path of [...expected.keys()].sort()) {
    const expectedEntry = expected.get(path);
    const actualEntry = actual.get(path);
    if (expectedEntry === undefined || actualEntry === undefined) continue;
    if (!expectedEntry.bytes.equals(actualEntry.bytes)) return `byte mismatch: ${path}`;
    if (expectedEntry.mode !== actualEntry.mode) {
      return `mode mismatch: ${path} (expected 100${expectedEntry.mode.toString(8)}, received 100${actualEntry.mode.toString(8)})`;
    }
  }
  return undefined;
}

async function assertExactTree(
  expected: readonly ReplayTreeEntry[],
  projectRoot: string,
  replayRoot: string,
  startingTree: readonly ReplayTreeEntry[],
  recipe: Recipe,
  platform: NodeJS.Platform,
): Promise<void> {
  const actual = await readWorktree(projectRoot, replayRoot, startingTree, recipe, platform);
  const mismatch = firstTreeMismatch(expected, actual);
  if (mismatch !== undefined) throw new Error(`Recipe replay tree mismatch: ${mismatch}`);
  const rootEntries = await readdir(projectRoot);
  const leaked = rootEntries.find((name) => name.startsWith('.madeup-video-course-transaction-'));
  if (leaked !== undefined) throw new Error(`Leaked transaction or rollback artifact: ${leaked}`);
}

async function gitState(projectRoot: string): Promise<string> {
  const commands = [
    ['rev-parse', 'HEAD'],
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    ['diff', '--binary', '--no-ext-diff'],
    ['diff', '--cached', '--binary', '--no-ext-diff'],
    ['ls-files', '--stage', '-z'],
  ] as const;
  const results = await Promise.all(commands.map((args) => git(projectRoot, args)));
  return results.map(({ stdout }) => stdout.toString('base64')).join('\n');
}

async function invokeApply(
  recipeId: string,
  projectRoot: string,
  sourceRoot: string,
  manifest: Awaited<ReturnType<typeof loadManifest>> & { ok: true },
): Promise<{ stdout: string[]; stderr: string[] }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCli(
    ['apply', recipeId, '--yes'],
    { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) },
    {
      apply: {
        startDirectory: projectRoot,
        workingBoundary: projectRoot,
        sourceRoot,
        manifest: manifest.manifest,
      },
    },
  );
  if (exitCode !== 0 || stderr.length > 0) {
    throw new Error(`CLI apply failed with exit code ${String(exitCode)}: ${stderr.join('\n')}`);
  }
  return { stdout, stderr };
}

async function runTrustedVerification(
  commands: readonly TrustedVerification[],
  projectRoot: string,
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];
  for (const specification of commands) {
    if (specification.command.trim().length === 0) {
      throw new Error('Trusted verification command must not be empty');
    }
    const result = await execute(specification.command, specification.args, { cwd: projectRoot });
    results.push({
      command: specification.command,
      args: [...specification.args],
      stdout: result.stdout.toString('utf8'),
      stderr: result.stderr.toString('utf8'),
    });
  }
  return results;
}

export async function replayRecipe(options: ReplayRecipeOptions): Promise<ReplayRecipeResult> {
  const sourceRepository = resolve(options.sourceRepository);
  const sourceRoot = resolve(options.sourceRoot);
  const loaded = await loadManifest(resolve(options.manifestPath));
  if (!loaded.ok) {
    const detail = loaded.error.kind === 'manifest-validation'
      ? loaded.error.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
      : loaded.error.message;
    throw new Error(`Replay manifest is invalid: ${detail}`);
  }
  const recipe = loaded.manifest.recipes.find(({ id }) => id === options.recipeId);
  if (recipe === undefined) throw new Error(`Unknown replay recipe: ${options.recipeId}`);
  const startingState = loaded.manifest.recoveryStates.find(({ id }) => id === recipe.startingState);
  const resultState = loaded.manifest.recoveryStates.find(({ id }) => id === recipe.resultState);
  if (startingState === undefined || resultState === undefined) {
    throw new Error(`Replay recipe ${recipe.id} references an unknown starting or result state`);
  }
  await verifyCommit(sourceRepository, startingState.sourceCommit, 'Starting');
  await verifyCommit(sourceRepository, resultState.sourceCommit, 'Result');
  const startingTree = await readCommitTree(sourceRepository, startingState.sourceCommit);
  const expectedTree = await readCommitTree(sourceRepository, resultState.sourceCommit);
  const replayRoot = await mkdtemp(join(options.temporaryParent ?? tmpdir(), 'course-replay-'));
  const projectRoot = join(replayRoot, 'project');
  const platform = options.platform ?? process.platform;

  try {
    await exportTree(projectRoot, startingTree);
    await initialiseRepository(projectRoot, startingTree, platform);
    const first = await invokeApply(recipe.id, projectRoot, sourceRoot, loaded);
    if (!first.stdout.includes('Changed files:')) {
      throw new Error('First CLI apply did not report an applied result');
    }
    await assertExactTree(expectedTree, projectRoot, replayRoot, startingTree, recipe, platform);
    const verification = await runTrustedVerification(
      options.trustedVerification ?? [],
      projectRoot,
    );
    await assertExactTree(expectedTree, projectRoot, replayRoot, startingTree, recipe, platform);
    const beforeSecondApply = await gitState(projectRoot);
    const second = await invokeApply(recipe.id, projectRoot, sourceRoot, loaded);
    if (second.stdout.length !== 0) {
      throw new Error(`Second CLI apply was not the exact already-applied no-op: ${second.stdout.join('\n')}`);
    }
    const afterSecondApply = await gitState(projectRoot);
    if (afterSecondApply !== beforeSecondApply) {
      throw new Error('Second CLI apply changed files or Git state');
    }
    await assertExactTree(expectedTree, projectRoot, replayRoot, startingTree, recipe, platform);
    return {
      firstApply: {
        kind: 'applied',
        changedFiles: recipe.operations.map(({ destination }) => destination),
      },
      secondApply: { kind: 'already-applied', changedFiles: [] },
      firstStdout: first.stdout,
      secondStdout: second.stdout,
      verifiedPaths: expectedTree.map(({ path }) => path),
      verification,
      modeComparison: platform === 'win32'
        ? 'git-index-projection'
        : 'native-filesystem',
    };
  } finally {
    await rm(replayRoot, { force: true, recursive: true });
  }
}
