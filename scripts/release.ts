#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PackageInspection } from './inspect-pack.js';

const exactReleaseTagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const exactCommitPattern = /^[a-f0-9]{40}$/u;
const packageNamePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;
const checksumPattern = /^([a-f0-9]{64})[ ]{2}([^/\\\r\n]+)\n$/u;

async function inspectPackageTarball(tarballPath: string): Promise<PackageInspection> {
  const nativeNodeModulePath = './inspect-pack.ts';
  const inspector = await import(nativeNodeModulePath) as typeof import('./inspect-pack.js');
  return inspector.inspectPackageTarball(tarballPath);
}

export type UpstreamRun = Readonly<{
  workflowName: string;
  event: string;
  conclusion: string | null;
  repository: string;
  headBranch: string;
  headSha: string;
  runId: number;
}>;

export type TrustedUpstreamRun = Readonly<{
  tag: string;
  version: string;
  headSha: string;
  runId: number;
}>;

export type RegistryEvidence = Readonly<{
  integrity: string;
  provenanceUrl: string;
}>;

export function parseReleaseTag(tag: string): string {
  const match = exactReleaseTagPattern.exec(tag);
  if (match === null) {
    throw new Error(`Tag must be an exact SemVer release tag vMAJOR.MINOR.PATCH: ${tag}`);
  }
  return tag.slice(1);
}

export function assertReleaseVersion(tag: string, packageVersion: string): string {
  const version = parseReleaseTag(tag);
  if (packageVersion !== version) {
    throw new Error(`Package version ${packageVersion} does not match release tag ${tag}`);
  }
  return version;
}

export function expectedTarballName(packageName: string, version: string): string {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version)) {
    throw new Error(`Unsafe release package version: ${version}`);
  }
  return expectedPackedTarballName(packageName, version);
}

export function expectedPackedTarballName(packageName: string, version: string): string {
  if (!packageNamePattern.test(packageName)) {
    throw new Error(`Unsafe npm package name: ${packageName}`);
  }
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/u.test(version)) {
    throw new Error(`Unsafe npm package version: ${version}`);
  }
  return `${packageName.replace(/^@/u, '').replace('/', '-')}-${version}.tgz`;
}

export function selectExactTarball(
  filenames: readonly string[],
  packageName: string,
  version: string,
): string {
  const tarballs = filenames.filter((filename) => filename.endsWith('.tgz'));
  if (tarballs.length !== 1) {
    throw new Error(`Release bundle must contain exactly one .tgz archive; found ${String(tarballs.length)}`);
  }
  const expected = expectedTarballName(packageName, version);
  if (tarballs[0] !== expected) {
    throw new Error(`Expected tarball ${expected}, found ${String(tarballs[0])}`);
  }
  return expected;
}

export async function createBundleChecksums(
  directory: string,
  tarballFilename: string,
): Promise<string> {
  if (basename(tarballFilename) !== tarballFilename || !tarballFilename.endsWith('.tgz')) {
    throw new Error('Tarball filename must be a basename ending in .tgz');
  }
  const contents = await readFile(join(directory, tarballFilename));
  const checksum = createHash('sha256').update(contents).digest('hex');
  const checksumPath = join(directory, 'SHA256SUMS');
  await writeFile(checksumPath, `${checksum}  ${tarballFilename}\n`, { flag: 'wx' });
  return checksumPath;
}

export async function verifyBundleChecksums(
  directory: string,
  tarballFilename: string,
): Promise<string> {
  const checksumRecord = await readFile(join(directory, 'SHA256SUMS'), 'utf8');
  const match = checksumPattern.exec(checksumRecord);
  if (match === null || match[2] !== tarballFilename) {
    throw new Error('SHA256SUMS must contain one single checksum for the exact tarball basename');
  }
  const expected = match[1];
  if (expected === undefined) throw new Error('SHA256SUMS checksum is missing');
  const contents = await readFile(join(directory, tarballFilename));
  const actual = createHash('sha256').update(contents).digest('hex');
  if (actual !== expected) throw new Error('Tarball checksum does not match SHA256SUMS');
  return actual;
}

export function registryIntegrity(tarball: Buffer): string {
  return `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
}

export function validateRegistryEvidence(
  tarball: Buffer,
  registryDist: unknown,
): RegistryEvidence {
  if (typeof registryDist !== 'object' || registryDist === null || Array.isArray(registryDist)) {
    throw new Error('Registry dist evidence must be an object');
  }
  const dist = registryDist as Record<string, unknown>;
  const expectedIntegrity = registryIntegrity(tarball);
  if (dist.integrity !== expectedIntegrity) {
    throw new Error('Registry dist.integrity does not match the exact release tarball');
  }
  if (typeof dist.attestations !== 'object' || dist.attestations === null) {
    throw new Error('Registry provenance attestations are missing');
  }
  const attestations = dist.attestations as Record<string, unknown>;
  if (attestations.provenance === undefined || attestations.provenance === null) {
    throw new Error('Registry provenance evidence is missing');
  }
  if (typeof attestations.url !== 'string') throw new Error('Registry attestation URL is missing');
  const url = new URL(attestations.url);
  if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org') {
    throw new Error('Registry attestation URL is not an npm registry HTTPS URL');
  }
  return { integrity: expectedIntegrity, provenanceUrl: url.href };
}

export function validateUpstreamRun(run: UpstreamRun): TrustedUpstreamRun {
  if (run.workflowName !== 'Publish') throw new Error('Upstream workflow must be Publish');
  if (run.event !== 'push') throw new Error('Upstream Publish run must originate from a push');
  if (run.conclusion !== 'success') throw new Error('Upstream Publish run must succeed');
  if (run.repository !== 'madeupdev/madeup-video-course-cli') {
    throw new Error('Upstream Publish run is from an untrusted repository');
  }
  const version = parseReleaseTag(run.headBranch);
  if (!exactCommitPattern.test(run.headSha)) throw new Error('Upstream commit must be an exact SHA-1');
  if (!Number.isSafeInteger(run.runId) || run.runId <= 0) {
    throw new Error('Upstream workflow run ID must be a positive safe integer');
  }
  return {
    tag: run.headBranch,
    version,
    headSha: run.headSha,
    runId: run.runId,
  };
}

type PackageMetadata = Readonly<{ name: string; version: string }>;

async function readPackageMetadata(path = 'package.json'): Promise<PackageMetadata> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('package.json must contain an object');
  }
  const { name, version } = value as Record<string, unknown>;
  if (typeof name !== 'string' || typeof version !== 'string') {
    throw new Error('package.json must contain string name and version fields');
  }
  return { name, version };
}

async function appendOutputs(outputs: Readonly<Record<string, string | number>>): Promise<void> {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (outputPath === undefined) return;
  const lines = Object.entries(outputs).map(([name, value]) => `${name}=${String(value)}\n`).join('');
  await appendFile(outputPath, lines);
}

async function prepareBundle(tag: string, directory: string): Promise<void> {
  const metadata = await readPackageMetadata();
  const version = assertReleaseVersion(tag, metadata.version);
  const tarball = selectExactTarball(await readdir(directory), metadata.name, version);
  const inspection = await inspectPackageTarball(join(directory, tarball));
  if (inspection.packageName !== metadata.name) throw new Error('Packed package name is incorrect');
  if (inspection.packageVersion !== metadata.version) {
    throw new Error('Packed package version is incorrect');
  }
  await createBundleChecksums(directory, tarball);
  const sha256 = await verifyBundleChecksums(directory, tarball);
  await appendOutputs({ tag, version, tarball, sha256 });
  process.stdout.write(`Prepared ${tarball} with SHA-256 ${sha256}\n`);
}

async function prepareDryRunBundle(directory: string): Promise<void> {
  const metadata = await readPackageMetadata();
  const filenames = await readdir(directory);
  const tarballs = filenames.filter((filename) => filename.endsWith('.tgz'));
  const expected = expectedPackedTarballName(metadata.name, metadata.version);
  if (tarballs.length !== 1 || tarballs[0] !== expected) {
    throw new Error(`Dry-run bundle must contain exactly the expected tarball ${expected}`);
  }
  const inspection = await inspectPackageTarball(join(directory, expected));
  if (inspection.packageName !== metadata.name) throw new Error('Packed package name is incorrect');
  if (inspection.packageVersion !== metadata.version) {
    throw new Error('Packed package version is incorrect');
  }
  await createBundleChecksums(directory, expected);
  const sha256 = await verifyBundleChecksums(directory, expected);
  await appendOutputs({ dry_run: 'true', version: metadata.version, tarball: expected, sha256 });
  process.stdout.write(`Prepared DRY RUN ${expected} with SHA-256 ${sha256}\n`);
}

async function verifyBundle(tag: string, directory: string): Promise<void> {
  const packageName = '@madeup-video/course';
  const version = parseReleaseTag(tag);
  const filenames = await readdir(directory);
  const tarball = selectExactTarball(filenames, packageName, version);
  if (filenames.slice().sort().join('\n') !== ['SHA256SUMS', tarball].sort().join('\n')) {
    throw new Error('Release bundle must contain only the tarball and SHA256SUMS');
  }
  const inspection = await inspectPackageTarball(join(directory, tarball));
  if (inspection.packageName !== packageName) throw new Error('Packed package name is incorrect');
  if (inspection.packageVersion !== version) throw new Error('Packed package version is incorrect');
  const sha256 = await verifyBundleChecksums(directory, tarball);
  await appendOutputs({ tag, version, tarball, sha256 });
  process.stdout.write(`Verified ${tarball} with SHA-256 ${sha256}\n`);
}

async function verifyDryRunBundle(directory: string): Promise<void> {
  const metadata = await readPackageMetadata();
  const tarball = expectedPackedTarballName(metadata.name, metadata.version);
  const filenames = await readdir(directory);
  if (filenames.slice().sort().join('\n') !== ['SHA256SUMS', tarball].sort().join('\n')) {
    throw new Error('Dry-run bundle must contain only the tarball and SHA256SUMS');
  }
  const inspection = await inspectPackageTarball(join(directory, tarball));
  if (inspection.packageName !== metadata.name || inspection.packageVersion !== metadata.version) {
    throw new Error('Packed package metadata is incorrect');
  }
  const sha256 = await verifyBundleChecksums(directory, tarball);
  await appendOutputs({ dry_run: 'true', version: metadata.version, tarball, sha256 });
  process.stdout.write(`Verified DRY RUN ${tarball} with SHA-256 ${sha256}\n`);
}

async function verifyUpstreamEvent(eventPath: string): Promise<void> {
  const event: unknown = JSON.parse(await readFile(eventPath, 'utf8'));
  if (typeof event !== 'object' || event === null) throw new Error('Invalid workflow event');
  const record = event as Record<string, unknown>;
  const workflowRun = record.workflow_run;
  const repository = record.repository;
  if (typeof workflowRun !== 'object' || workflowRun === null) {
    throw new Error('workflow_run event data is missing');
  }
  if (typeof repository !== 'object' || repository === null) {
    throw new Error('repository event data is missing');
  }
  const run = workflowRun as Record<string, unknown>;
  const repo = repository as Record<string, unknown>;
  const trusted = validateUpstreamRun({
    workflowName: String(run.name ?? ''),
    event: String(run.event ?? ''),
    conclusion: run.conclusion === null ? null : String(run.conclusion ?? ''),
    repository: String(repo.full_name ?? ''),
    headBranch: String(run.head_branch ?? ''),
    headSha: String(run.head_sha ?? ''),
    runId: Number(run.id),
  });
  await appendOutputs(trusted);
  process.stdout.write(`Trusted Publish run ${String(trusted.runId)} for ${trusted.tag}\n`);
}

async function verifyRegistry(
  tag: string,
  directory: string,
  registryDistPath: string,
): Promise<void> {
  const version = parseReleaseTag(tag);
  const tarball = expectedTarballName('@madeup-video/course', version);
  const tarballContents = await readFile(join(directory, tarball));
  const registryDist: unknown = JSON.parse(await readFile(registryDistPath, 'utf8'));
  const evidence = validateRegistryEvidence(tarballContents, registryDist);
  await appendOutputs({
    registry_integrity: evidence.integrity,
    provenance_url: evidence.provenanceUrl,
  });
  process.stdout.write(`Verified registry integrity ${evidence.integrity}\n`);
  process.stdout.write(`Verified provenance evidence ${evidence.provenanceUrl}\n`);
}

async function main(): Promise<void> {
  const [command, first, second, third] = process.argv.slice(2);
  if (command === 'validate-tag' && first !== undefined && second !== undefined) {
    const version = assertReleaseVersion(first, second);
    await appendOutputs({ tag: first, version });
    process.stdout.write(`${version}\n`);
    return;
  }
  if (command === 'prepare' && first !== undefined && second !== undefined) {
    await prepareBundle(first, resolve(second));
    return;
  }
  if (command === 'prepare-dry-run' && first !== undefined && second === undefined) {
    await prepareDryRunBundle(resolve(first));
    return;
  }
  if (command === 'verify-bundle' && first !== undefined && second !== undefined) {
    await verifyBundle(first, resolve(second));
    return;
  }
  if (command === 'verify-dry-run' && first !== undefined && second === undefined) {
    await verifyDryRunBundle(resolve(first));
    return;
  }
  if (command === 'verify-upstream' && first !== undefined && second === undefined) {
    await verifyUpstreamEvent(resolve(first));
    return;
  }
  if (
    command === 'verify-registry' &&
    first !== undefined &&
    second !== undefined &&
    third !== undefined
  ) {
    await verifyRegistry(first, resolve(second), resolve(third));
    return;
  }
  throw new Error(
    'Usage: node scripts/release.ts validate-tag <tag> <package-version> | prepare <tag> <directory> | prepare-dry-run <directory> | verify-bundle <tag> <directory> | verify-dry-run <directory> | verify-upstream <event.json> | verify-registry <tag> <directory> <dist.json>',
  );
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`Release validation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
