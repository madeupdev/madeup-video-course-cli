#!/usr/bin/env node

import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGunzip } from 'node:zlib';

import { extract as createTarExtract } from 'tar-stream';
import type { Headers } from 'tar-stream';

export type PackageInspection = Readonly<{
  packageName: string;
  files: string[];
  binPaths: string[];
}>;

type PackedEntry = Readonly<{
  header: Headers;
  contents: Buffer;
}>;

const requiredPackageFiles = [
  'package/package.json',
  'package/README.md',
  'package/recovery/course-v1.0.0.json',
] as const;

const compiledModuleNames = [
  'apply/plan',
  'apply/preflight',
  'apply/rollback',
  'apply/transaction',
  'cli',
  'commands/apply',
  'commands/doctor',
  'commands/recover',
  'manifest/load',
  'manifest/types',
  'manifest/validate',
  'path/portable',
  'project/find-root',
  'project/git',
  'project/hash',
  'project/inspect',
  'recovery/download',
  'recovery/extract',
  'recovery/pack',
  'recovery/register',
  'recovery/verify',
  'scripts/build-recovery-assets',
  'state/classify',
] as const;
const compiledRuntimeFiles = new Set(
  compiledModuleNames.flatMap((moduleName) =>
    ['.d.ts', '.d.ts.map', '.js', '.js.map'].map(
      (suffix) => `package/dist/${moduleName}${suffix}`,
    ),
  ),
);
const requiredCompiledRuntimeFiles = compiledModuleNames.map(
  (moduleName) => `package/dist/${moduleName}.js`,
);
const exactAllowedFiles = new Set([
  ...requiredPackageFiles,
  ...compiledRuntimeFiles,
]);
const expectedRecoverySha256 = '8d5bcd1858825ab3ede0f726587ccb7269c21c55e74c19833152976f64077d38';
const maximumEntryCount = 10_000;
const maximumEntryBytes = 16 * 1024 * 1024;
const maximumTotalBytes = 128 * 1024 * 1024;

const forbiddenTopLevelDirectories = new Set([
  '.github',
  'coverage',
  'docs',
  'fixtures',
  'node_modules',
  'scripts',
  'src',
  'test',
  'tests',
]);

const forbiddenDirectoryNames = new Set(['__fixtures__', '__tests__', 'fixture', 'fixtures']);
const archiveSuffixPattern = /\.(?:7z|tar|tar\.gz|tgz|zip)$/iu;
const sensitiveNamePattern = /(?:^|[-_.])(?:credential|credentials|secret|secrets)(?:$|[-_.])/iu;
const privateKeySuffixPattern = /\.(?:key|p12|pem|pfx)$/iu;
const unixLocalPathPattern =
  /\/(?:Users|app|builds|data|etc|home|mnt|opt|private\/var\/folders|root|runner|srv|tmp|var\/(?:folders|lib|tmp)|workspaces?)\/[^\s"'`]+/u;
const windowsDriveLocalPathPattern = /(?<![A-Za-z0-9])[A-Za-z]:[\\/]{1,2}[^\s"'`]+/u;
const windowsUncLocalPathPattern =
  /\\{2,4}[A-Za-z0-9._-]+\\{1,2}[A-Za-z0-9$._-]+\\{1,2}[^\s"'`]+/u;
const credentialMaterialPattern =
  /\b(?:AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|npm_[A-Za-z0-9]{30,})\b/u;
const privateKeyMaterialPattern = /-----BEGIN [A-Z ]*PRIVATE KEY-----/u;
const windowsReservedBasenamePattern =
  /^(?:AUX|COM[1-9]|CON|LPT[1-9]|NUL|PRN)(?:\..*)?$/iu;

function unsafeTarPathIssue(name: string): string | undefined {
  if (name.length === 0) return 'path is empty';
  if (name !== name.normalize('NFC')) return 'path is not Unicode-normalized';
  if ([...name].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  })) {
    return 'path contains a control character';
  }
  if (name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/u.test(name)) {
    return 'path is absolute';
  }
  if (name.includes('\\')) return 'path uses a backslash separator';
  const comparableName = name.endsWith('/') ? name.slice(0, -1) : name;
  const segments = comparableName.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return 'path contains an empty or dot segment';
  }
  if (
    segments.some(
      (segment) =>
        /[<>:"|?*]/u.test(segment) ||
        segment.endsWith('.') ||
        segment.endsWith(' ') ||
        windowsReservedBasenamePattern.test(segment),
    )
  ) {
    return 'path contains a non-portable filename';
  }
  if (segments[0] !== 'package') return 'path is outside the npm package root';
  return undefined;
}

function forbiddenContentIssue(name: string): string | undefined {
  const segments = name.split('/');
  const topLevel = segments[1]?.toLowerCase();
  if (topLevel !== undefined && forbiddenTopLevelDirectories.has(topLevel)) {
    return `forbidden top-level directory ${segments[1]}`;
  }
  for (const segment of segments.slice(1)) {
    const lowerSegment = segment.toLowerCase();
    if (forbiddenDirectoryNames.has(lowerSegment)) return `forbidden directory ${segment}`;
    if (lowerSegment === '.env' || lowerSegment.startsWith('.env.')) {
      return `forbidden environment file ${segment}`;
    }
    if (lowerSegment === '.npmrc' || lowerSegment === '.yarnrc') {
      return `forbidden credential-bearing configuration ${segment}`;
    }
    if (sensitiveNamePattern.test(segment) || privateKeySuffixPattern.test(segment)) {
      return `forbidden sensitive file ${segment}`;
    }
  }
  const basename = segments.at(-1) ?? '';
  if (basename.toLowerCase() === 'delivery-states.json') {
    return 'forbidden private delivery-state register';
  }
  if (archiveSuffixPattern.test(basename)) return `forbidden temporary archive ${basename}`;
  return undefined;
}

function unexpectedPathIssue(name: string): string | undefined {
  return exactAllowedFiles.has(name) ? undefined : 'unexpected package content';
}

function unexpectedDirectoryIssue(name: string): string | undefined {
  const canonicalName = name.endsWith('/') ? name.slice(0, -1) : name;
  if (canonicalName === 'package') return undefined;
  return [...exactAllowedFiles].some((file) => file.startsWith(`${canonicalName}/`))
    ? undefined
    : 'unexpected package directory';
}

function containsAbsoluteLocalPath(contents: Buffer): boolean {
  const text = contents.toString('utf8');
  return (
    unixLocalPathPattern.test(text) ||
    windowsDriveLocalPathPattern.test(text) ||
    windowsUncLocalPathPattern.test(text)
  );
}

function containsCredentialMaterial(contents: Buffer): boolean {
  const text = contents.toString('utf8');
  return credentialMaterialPattern.test(text) || privateKeyMaterialPattern.test(text);
}

async function readPackedEntries(tarballPath: string): Promise<PackedEntry[]> {
  return new Promise((resolveEntries, reject) => {
    const entries: PackedEntry[] = [];
    const input = createReadStream(tarballPath);
    const gunzip = createGunzip();
    const extractor = createTarExtract();
    let settled = false;
    let totalBytes = 0;

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      input.destroy();
      gunzip.destroy();
      extractor.destroy();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    input.on('error', fail);
    gunzip.on('error', fail);
    extractor.on('error', fail);
    extractor.on('entry', (header, stream, next) => {
      const declaredSize = header.size ?? 0;
      if (
        entries.length >= maximumEntryCount ||
        !Number.isSafeInteger(declaredSize) ||
        declaredSize < 0 ||
        declaredSize > maximumEntryBytes ||
        totalBytes + declaredSize > maximumTotalBytes
      ) {
        fail(new Error(`Tarball resource limit exceeded at ${header.name}`));
        stream.resume();
        return;
      }
      totalBytes += declaredSize;
      const chunks: Buffer[] = [];
      let observedSize = 0;
      stream.on('data', (chunk: Buffer) => {
        observedSize += chunk.length;
        if (observedSize > declaredSize || observedSize > maximumEntryBytes) {
          fail(new Error(`Tar entry size mismatch at ${header.name}`));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('error', fail);
      stream.on('end', () => {
        if (settled) return;
        if (observedSize !== declaredSize) {
          fail(new Error(`Tar entry size mismatch at ${header.name}`));
          return;
        }
        entries.push({ header, contents: Buffer.concat(chunks) });
        next();
      });
      stream.resume();
    });
    extractor.on('finish', () => {
      if (settled) return;
      settled = true;
      resolveEntries(entries);
    });
    input.pipe(gunzip).pipe(extractor);
  });
}

function parsePackageJson(entry: PackedEntry | undefined): Record<string, unknown> {
  if (entry === undefined) throw new Error('Required runtime file package/package.json is missing');
  try {
    const value: unknown = JSON.parse(entry.contents.toString('utf8'));
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('package.json must contain an object');
    }
    return value as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Packed package.json is invalid: ${detail}`);
  }
}

function packageBinPaths(packageJson: Record<string, unknown>): string[] {
  const bin = packageJson.bin;
  const values =
    typeof bin === 'string'
      ? [bin]
      : typeof bin === 'object' && bin !== null && !Array.isArray(bin)
        ? Object.values(bin)
        : [];
  if (values.length === 0 || values.some((value) => typeof value !== 'string')) {
    throw new Error('Packed package.json#bin must reference at least one executable');
  }
  return values.map((value) => {
    const binPath = value as string;
    const withoutPrefix = binPath.startsWith('./') ? binPath.slice(2) : binPath;
    const issue = unsafeTarPathIssue(`package/${withoutPrefix}`);
    if (issue !== undefined || withoutPrefix.includes('\\')) {
      throw new Error(`Packed package.json#bin contains an unsafe path: ${binPath}`);
    }
    return `package/${withoutPrefix}`;
  });
}

export async function inspectPackageTarball(tarballPath: string): Promise<PackageInspection> {
  const entries = await readPackedEntries(tarballPath);
  if (entries.length === 0) throw new Error('Packed tarball is empty');
  const files = new Map<string, PackedEntry>();
  const collisionKeys = new Map<string, string>();

  for (const entry of entries) {
    const { name, type } = entry.header;
    const unsafeIssue = unsafeTarPathIssue(name);
    if (unsafeIssue !== undefined) throw new Error(`Unsafe tar path ${JSON.stringify(name)}: ${unsafeIssue}`);
    if (entry.header.linkname) {
      throw new Error(`Unexpected tar link target at ${name}`);
    }
    if (type !== 'file' && type !== 'directory') {
      throw new Error(`Unexpected tar entry type ${String(type)} at ${name}`);
    }
    const canonicalName = name.endsWith('/') ? name.slice(0, -1) : name;
    const collisionKey = canonicalName.normalize('NFC').toLowerCase();
    const collidingName = collisionKeys.get(collisionKey);
    if (collidingName !== undefined) {
      throw new Error(`Duplicate or colliding tar paths: ${collidingName} and ${name}`);
    }
    collisionKeys.set(collisionKey, name);
    const forbiddenIssue = forbiddenContentIssue(name);
    if (forbiddenIssue !== undefined) throw new Error(`${name}: ${forbiddenIssue}`);
    if (type === 'directory') {
      const unexpectedDirectory = unexpectedDirectoryIssue(name);
      if (unexpectedDirectory !== undefined) throw new Error(`${name}: ${unexpectedDirectory}`);
      continue;
    }
    const unexpectedIssue = unexpectedPathIssue(name);
    if (unexpectedIssue !== undefined) throw new Error(`${name}: ${unexpectedIssue}`);
    if (entry.contents.includes(0)) {
      throw new Error(`${name}: expected text content contains a NUL byte or binary data`);
    }
    if (containsAbsoluteLocalPath(entry.contents)) {
      throw new Error(`${name}: contains an absolute local filesystem path`);
    }
    if (containsCredentialMaterial(entry.contents)) {
      throw new Error(`${name}: contains credential or secret material`);
    }
    files.set(name, entry);
  }

  for (const requiredFile of requiredPackageFiles) {
    if (!files.has(requiredFile)) throw new Error(`Required runtime file ${requiredFile} is missing`);
  }

  const recoveryEntry = files.get('package/recovery/course-v1.0.0.json');
  if (
    recoveryEntry === undefined ||
    createHash('sha256').update(recoveryEntry.contents).digest('hex') !== expectedRecoverySha256
  ) {
    throw new Error('Expected public recovery data does not match course-v1.0.0.json');
  }

  const packageJson = parsePackageJson(files.get('package/package.json'));
  const packageName = packageJson.name;
  if (typeof packageName !== 'string' || packageName.length === 0) {
    throw new Error('Packed package.json#name must be a non-empty string');
  }
  const binPaths = packageBinPaths(packageJson);
  for (const binPath of binPaths) {
    const executable = files.get(binPath);
    if (executable === undefined) throw new Error(`Package bin executable is missing: ${binPath}`);
    if (((executable.header.mode ?? 0) & 0o111) === 0) {
      throw new Error(`Package bin is not executable: ${binPath}`);
    }
  }
  for (const requiredFile of requiredCompiledRuntimeFiles) {
    if (!files.has(requiredFile)) throw new Error(`Required runtime file ${requiredFile} is missing`);
  }

  return { packageName, files: [...files.keys()].sort(), binPaths: [...binPaths].sort() };
}

async function main(): Promise<void> {
  const tarballPath = process.argv[2];
  if (tarballPath === undefined || process.argv.length !== 3) {
    throw new Error('Usage: node scripts/inspect-pack.ts <exact-tarball-path>');
  }
  const result = await inspectPackageTarball(resolve(tarballPath));
  process.stdout.write(
    `Inspected ${String(result.files.length)} files in ${result.packageName}; bin: ${result.binPaths.join(', ')}\n`,
  );
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Package inspection failed: ${message}\n`);
    process.exitCode = 1;
  });
}
