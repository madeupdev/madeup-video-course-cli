import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

import { pack as createTarPack } from 'tar-stream';
import type { Headers } from 'tar-stream';

import {
  formatRegisterIssues,
  validateRecoveryRegister,
  type BuilderIdentity,
  type LocalArtifactRule,
  type RecoveryRegister,
  type RecoveryRegisterState,
} from './register.js';
import {
  containsAsciiControl,
  filesystemCollisionKey,
  findPortableFilenameIssue,
} from '../path/portable.js';

export type BuildRecoveryAssetsOptions = Readonly<{
  projectDirectory: string;
  registerPath: string;
  outputDirectory: string;
  builderIdentity: BuilderIdentity;
}>;

export type RecoveryAssetMetadata = Readonly<{
  id: string;
  sourceCommit: string;
  asset: string;
  size: number;
  sha256: string;
}>;

export type BuildRecoveryAssetsResult = Readonly<{
  outputDirectory: string;
  assets: RecoveryAssetMetadata[];
}>;

type GitTreeFile = Readonly<{
  path: string;
  object: string;
  mode: 0o644 | 0o755;
}>;

type PreparedState = Readonly<{
  state: RecoveryRegisterState;
  files: GitTreeFile[];
}>;

type GitResult = Readonly<{
  stdout: Buffer;
  stderr: string;
  exitCode: number | null;
}>;

const fixedExcludedDirectoryNames = new Set([
  '.git',
  '.next',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
]);

const unsafeGitEnvironmentVariables = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_SYSTEM',
  'GIT_DIR',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_GRAFT_FILE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_NAMESPACE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_QUARANTINE_PATH',
  'GIT_REPLACE_REF_BASE',
  'GIT_SHALLOW_FILE',
  'GIT_WORK_TREE',
]);
const inlineGitConfigVariablePattern = /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/;

function sanitizedGitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    const normalized = name.toUpperCase();
    if (
      unsafeGitEnvironmentVariables.has(normalized) ||
      inlineGitConfigVariablePattern.test(normalized)
    ) {
      delete environment[name];
    }
  }
  environment.LANG = 'C';
  environment.LC_ALL = 'C';
  environment.GIT_OPTIONAL_LOCKS = '0';
  environment.GIT_NO_REPLACE_OBJECTS = '1';
  return environment;
}

function runGit(
  repository: string,
  args: readonly string[],
  input?: Buffer,
): Promise<GitResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn('git', ['-C', repository, ...args], {
      env: sanitizedGitEnvironment(),
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (exitCode) => {
      resolveResult({
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString('utf8').trim(),
        exitCode,
      });
    });
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input);
  });
}

async function git(
  repository: string,
  args: readonly string[],
  description: string,
): Promise<Buffer> {
  const result = await runGit(repository, args);
  if (result.exitCode !== 0) {
    const detail = result.stderr === '' ? `exit ${String(result.exitCode)}` : result.stderr;
    throw new Error(`${description}: ${detail}`);
  }
  return result.stdout;
}

function decodeGitText(value: Buffer, description: string): string {
  const decoded = value.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(value)) {
    throw new Error(`${description} contains a path that is not valid UTF-8`);
  }
  return decoded;
}

function normalizeRepository(value: string): string | undefined {
  const trimmed = value.trim().replace(/\/+$/u, '').replace(/\.git$/iu, '');
  let match = /^git@github\.com:([^/]+)\/(.+)$/iu.exec(trimmed);
  if (match === null) {
    match = /^ssh:\/\/git@github\.com\/([^/]+)\/(.+)$/iu.exec(trimmed);
  }
  if (match === null) {
    match = /^https:\/\/github\.com\/([^/]+)\/(.+)$/iu.exec(trimmed);
  }
  const owner = match?.[1];
  const repository = match?.[2];
  if (owner === undefined || repository === undefined) return undefined;
  return `https://github.com/${owner.toLowerCase()}/${repository.toLowerCase()}`;
}

function isWithin(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return (
    fromRoot === '' ||
    (!isAbsolute(fromRoot) && fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`))
  );
}

function portableTreePathIssue(path: string): string | undefined {
  if (path.length === 0) return 'empty path';
  if (path !== path.normalize('NFC')) return 'path is not normalized to NFC';
  if (containsAsciiControl(path)) return 'path contains an ASCII control character';
  if (path.startsWith('/') || /^[A-Za-z]:/u.test(path) || path.startsWith('\\')) {
    return 'path is absolute';
  }
  if (path.includes('\\')) return 'path uses a backslash separator';
  const segments = path.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return 'path contains an empty or dot segment';
  }
  return segments
    .map((segment) => findPortableFilenameIssue(segment)?.message)
    .find((message) => message !== undefined);
}

function isTrackedSecret(path: string): boolean {
  const basename = path.split('/').at(-1) ?? '';
  return (
    basename === '.env' ||
    (basename.startsWith('.env.') && !basename.endsWith('.example'))
  );
}

function matchesArtifactRule(path: string, rule: LocalArtifactRule): boolean {
  const segments = path.split('/');
  switch (rule.type) {
    case 'file':
      return path === rule.path;
    case 'directory':
      return path === rule.path || path.startsWith(`${rule.path}/`);
    case 'directory-name':
      return segments.slice(0, -1).includes(rule.name);
    case 'file-suffix':
      return path.endsWith(rule.suffix);
  }
}

function isExcluded(path: string, rules: readonly LocalArtifactRule[]): boolean {
  const directories = path.split('/').slice(0, -1);
  return (
    directories.some((segment) => fixedExcludedDirectoryNames.has(segment)) ||
    rules.some((rule) => matchesArtifactRule(path, rule))
  );
}

function parseTreeRecord(record: Buffer, statePath: string): {
  gitMode: string;
  type: string;
  object: string;
  path: string;
} {
  const decoded = decodeGitText(record, `Git tree for ${statePath}`);
  const tab = decoded.indexOf('\t');
  const metadata = tab === -1 ? [] : decoded.slice(0, tab).split(' ');
  const path = tab === -1 ? '' : decoded.slice(tab + 1);
  const [gitMode, type, object] = metadata;
  if (
    gitMode === undefined ||
    type === undefined ||
    object === undefined ||
    !/^[a-f0-9]{40}$/u.test(object)
  ) {
    throw new Error(`${statePath}: Git returned a malformed tree entry`);
  }
  return { gitMode, type, object, path };
}

function splitNullRecords(output: Buffer): Buffer[] {
  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] === 0) {
      records.push(output.subarray(start, index));
      start = index + 1;
    }
  }
  if (start !== output.length) throw new Error('Git tree output was not NUL terminated');
  return records.filter((record) => record.length > 0);
}

async function preflightStateTree(
  project: string,
  register: RecoveryRegister,
  state: RecoveryRegisterState,
  index: number,
): Promise<PreparedState> {
  const statePath = `$.states[${index}].sourceCommit`;
  const objectTypeResult = await runGit(project, ['cat-file', '-t', state.sourceCommit]);
  if (objectTypeResult.exitCode !== 0) {
    throw new Error(`${statePath}: Git object does not exist`);
  }
  const objectType = objectTypeResult.stdout.toString('utf8').trim();
  if (objectType !== 'commit') {
    throw new Error(`${statePath}: Git object is not a commit`);
  }
  const ancestor = await runGit(project, [
    'merge-base',
    '--is-ancestor',
    state.sourceCommit,
    'refs/remotes/origin/main',
  ]);
  if (ancestor.exitCode !== 0) {
    throw new Error(
      `${statePath}: Commit is not reachable from canonical refs/remotes/origin/main`,
    );
  }

  const treeOutput = await git(
    project,
    ['ls-tree', '-rz', '--full-tree', state.sourceCommit],
    `${statePath}: Unable to inspect immutable Git tree`,
  );
  const files: GitTreeFile[] = [];
  const collisionPaths = new Map<string, string>();
  for (const record of splitNullRecords(treeOutput)) {
    const entry = parseTreeRecord(record, statePath);
    const pathIssue = portableTreePathIssue(entry.path);
    if (pathIssue !== undefined) {
      throw new Error(`${statePath}: Unsafe Git tree path ${JSON.stringify(entry.path)}: ${pathIssue}`);
    }
    for (let end = 1; end <= entry.path.split('/').length; end += 1) {
      const portablePath = entry.path.split('/').slice(0, end).join('/');
      const key = filesystemCollisionKey(portablePath);
      const previous = collisionPaths.get(key);
      if (previous !== undefined && previous !== portablePath) {
        throw new Error(
          `${statePath}: portable path collision between ${JSON.stringify(previous)} and ${JSON.stringify(portablePath)}`,
        );
      }
      collisionPaths.set(key, portablePath);
    }
    if (entry.gitMode === '160000' || entry.type === 'commit') {
      throw new Error(`${statePath}: Git tree contains a submodule at ${entry.path}`);
    }
    if (entry.gitMode === '120000') {
      throw new Error(`${statePath}: Git tree contains a symbolic link at ${entry.path}`);
    }
    if (entry.type !== 'blob' || (entry.gitMode !== '100644' && entry.gitMode !== '100755')) {
      throw new Error(`${statePath}: Git tree contains an unsupported special entry at ${entry.path}`);
    }
    if (isTrackedSecret(entry.path)) {
      throw new Error(`${statePath}: Git tree contains tracked secret ${entry.path}`);
    }
    if (!isExcluded(entry.path, register.project.localArtifacts)) {
      files.push({
        path: entry.path,
        object: entry.object,
        mode: entry.gitMode === '100755' ? 0o755 : 0o644,
      });
    }
  }
  files.sort((left, right) => compareArchivePath(left.path, right.path));
  return { state, files };
}

function compareArchivePath(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

async function preflightProjectIdentity(
  project: string,
  register: RecoveryRegister,
): Promise<void> {
  const repositoryRoot = (
    await git(project, ['rev-parse', '--show-toplevel'], 'Project is not a Git repository')
  ).toString('utf8').trim();
  if ((await realpath(repositoryRoot)) !== (await realpath(project))) {
    throw new Error('The --project directory must be the Git repository root');
  }
  const origin = (
    await git(project, ['remote', 'get-url', 'origin'], 'Project origin is missing')
  ).toString('utf8').trim();
  if (normalizeRepository(origin) !== normalizeRepository(register.project.repository)) {
    throw new Error('$.project.repository: Project origin does not match the register');
  }
  const canonicalMain = await runGit(project, [
    'rev-parse',
    '--verify',
    'refs/remotes/origin/main^{commit}',
  ]);
  if (canonicalMain.exitCode !== 0) {
    throw new Error('Project is missing canonical refs/remotes/origin/main');
  }

  let packageValue: unknown;
  try {
    const packageSource = await git(
      project,
      ['show', 'refs/remotes/origin/main:package.json'],
      '$.project.packageName: Unable to read package.json from canonical origin/main',
    );
    packageValue = JSON.parse(packageSource.toString('utf8')) as unknown;
  } catch {
    throw new Error(
      '$.project.packageName: Canonical origin/main package.json is missing or malformed',
    );
  }
  const packageName =
    typeof packageValue === 'object' && packageValue !== null && 'name' in packageValue
      ? (packageValue as { name?: unknown }).name
      : undefined;
  if (packageName !== register.project.packageName) {
    throw new Error('$.project.packageName: Project package name does not match the register');
  }
}

async function inspectPathComponents(outputDirectory: string): Promise<void> {
  const absolute = resolve(outputDirectory);
  const root = parse(absolute).root;
  const parts = relative(root, absolute).split(sep).filter((part) => part.length > 0);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      const status = await lstat(current);
      if (status.isSymbolicLink()) {
        throw new Error(`Output path contains a symbolic link: ${current}`);
      }
      if (!status.isDirectory()) {
        throw new Error(`Output path component is not a directory: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
}

async function preflightOutput(
  outputDirectory: string,
  assetNames: readonly string[],
): Promise<string> {
  const output = resolve(outputDirectory);
  await inspectPathComponents(output);
  const names = [...assetNames, 'manifest.json', 'SHA256SUMS'];
  const collisions = new Set<string>();
  for (const name of names) {
    const key = filesystemCollisionKey(name);
    if (collisions.has(key)) throw new Error(`Duplicate portable output name: ${name}`);
    collisions.add(key);
    const target = resolve(output, name);
    if (!isWithin(output, target) || relative(output, target) !== name) {
      throw new Error(`Output path escapes the requested directory: ${name}`);
    }
    try {
      const status = await lstat(target);
      if (status.isSymbolicLink()) {
        throw new Error(`Final output path is a symbolic link: ${target}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return output;
}

function directoryEntries(files: readonly GitTreeFile[]): string[] {
  const directories = new Set<string>();
  for (const file of files) {
    const segments = file.path.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join('/'));
    }
  }
  return [...directories].sort(compareArchivePath);
}

function addTarEntry(
  archive: ReturnType<typeof createTarPack>,
  header: Headers,
  contents?: Buffer,
): Promise<void> {
  return new Promise((resolveEntry, reject) => {
    archive.entry(header, contents, (error?: Error | null) => {
      if (error !== undefined && error !== null) reject(error);
      else resolveEntry();
    });
  });
}

async function collectStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(
      Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk as string | Uint8Array),
    );
  }
  return Buffer.concat(chunks);
}

async function createArchive(project: string, prepared: PreparedState): Promise<Buffer> {
  const archive = createTarPack();
  const output = collectStream(archive);
  const common = {
    uid: 0,
    gid: 0,
    uname: '',
    gname: '',
    mtime: new Date(0),
  };
  for (const directory of directoryEntries(prepared.files)) {
    await addTarEntry(archive, {
      ...common,
      name: `${directory}/`,
      type: 'directory',
      mode: 0o755,
      size: 0,
    });
  }
  for (const file of prepared.files) {
    const contents = await git(
      project,
      ['cat-file', 'blob', file.object],
      `Unable to read immutable Git blob for ${file.path}`,
    );
    await addTarEntry(archive, {
      ...common,
      name: file.path,
      type: 'file',
      mode: file.mode,
      size: contents.length,
    }, contents);
  }
  archive.finalize();
  const compressed = gzipSync(await output, { level: 9 });
  compressed.fill(0, 4, 8);
  compressed[9] = 255;
  return compressed;
}

function sha256(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

async function promoteDirectory(staging: string, output: string): Promise<void> {
  let outputExists = false;
  try {
    await lstat(output);
    outputExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!outputExists) {
    await rename(staging, output);
    return;
  }

  const backup = join(resolve(output, '..'), `.${parse(output).base}.backup-${randomUUID()}`);
  await rename(output, backup);
  try {
    await rename(staging, output);
  } catch (error) {
    await rename(backup, output);
    throw error;
  }
  await rm(backup, { force: true, recursive: true });
}

export async function buildRecoveryAssets(
  options: BuildRecoveryAssetsOptions,
): Promise<BuildRecoveryAssetsResult> {
  const registerSource = await readFile(options.registerPath, 'utf8');
  const validation = validateRecoveryRegister(registerSource, options.builderIdentity);
  if (!validation.ok) throw new Error(formatRegisterIssues(validation.issues));
  const register = validation.register;
  const project = await realpath(resolve(options.projectDirectory));
  await preflightProjectIdentity(project, register);

  const preparedStates: PreparedState[] = [];
  for (const [index, state] of register.states.entries()) {
    preparedStates.push(await preflightStateTree(project, register, state, index));
  }
  const output = await preflightOutput(
    options.outputDirectory,
    register.states.map((state) => state.asset),
  );

  const parent = resolve(output, '..');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(parent, `.${parse(output).base}.staging-`));
  let promoted = false;
  try {
    const assets: RecoveryAssetMetadata[] = [];
    for (const prepared of preparedStates) {
      const bytes = await createArchive(project, prepared);
      if (bytes.length > register.release.maxAssetBytes) {
        throw new Error(
          `${prepared.state.asset} exceeds release.maxAssetBytes (${String(register.release.maxAssetBytes)})`,
        );
      }
      await writeFile(join(staging, prepared.state.asset), bytes, { mode: 0o600 });
      assets.push({
        id: prepared.state.id,
        sourceCommit: prepared.state.sourceCommit,
        asset: prepared.state.asset,
        size: bytes.length,
        sha256: sha256(bytes),
      });
    }

    const manifest = {
      schemaVersion: 1,
      courseVersion: register.courseVersion,
      release: {
        repository: register.release.repository,
        tag: register.release.tag,
      },
      assets,
    };
    await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    await writeFile(
      join(staging, 'SHA256SUMS'),
      assets.map((asset) => `${asset.sha256}  ${asset.asset}\n`).join(''),
      { mode: 0o600 },
    );
    await promoteDirectory(staging, output);
    promoted = true;
    return { outputDirectory: output, assets };
  } finally {
    if (!promoted) await rm(staging, { force: true, recursive: true });
  }
}
