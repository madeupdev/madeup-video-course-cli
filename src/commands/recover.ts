import { randomUUID } from 'node:crypto';
import { lstat, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import type { CourseManifest } from '../manifest/types.js';
import { downloadRecoveryAsset } from '../recovery/download.js';
import { extractRecoveryArchive } from '../recovery/extract.js';
import { verifyRecoveryTree } from '../recovery/verify.js';

export type RecoverIo = Readonly<{
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}>;

export type RecoverOptions = Readonly<{
  manifest: CourseManifest;
  destination: string;
  platform: NodeJS.Platform;
  cliVersion?: string;
}>;

export type RecoverResult = Readonly<{ exitCode: 0 | 1 }>;

function releaseAssetUrl(manifest: CourseManifest, asset: string): string {
  const repository = manifest.release.repository.replace(/\/+$/u, '');
  return `${repository}/releases/download/${encodeURIComponent(manifest.release.tag)}/${encodeURIComponent(asset)}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function runRecover(
  stateId: string,
  options: RecoverOptions,
  io: RecoverIo,
): Promise<RecoverResult> {
  const state = options.manifest.recoveryStates.find((candidate) => candidate.id === stateId);
  if (state === undefined) {
    io.stderr(`Unknown recovery state: ${stateId}`);
    return { exitCode: 1 };
  }

  const destination = resolve(options.destination);
  let extractionDirectory: string | undefined;
  let downloadPath: string | undefined;
  let published = false;
  try {
    const cliVersion = options.cliVersion ?? options.manifest.courseVersion;
    if (cliVersion !== options.manifest.courseVersion) {
      throw new Error(`CLI version ${cliVersion} does not match course version ${options.manifest.courseVersion}`);
    }
    if (await pathExists(destination)) {
      throw new Error(`Recovery destination already exists: ${destination}`);
    }
    const parent = await realpath(dirname(destination));
    const token = randomUUID();
    const prefix = `.${basename(destination)}.course-recovery-${token}`;
    downloadPath = join(parent, `${prefix}.tar.gz`);
    extractionDirectory = join(parent, `${prefix}.extracting`);

    const download = await downloadRecoveryAsset({
      url: releaseAssetUrl(options.manifest, state.asset),
      destination: downloadPath,
      expectedSha256: state.sha256,
      maxBytes: options.manifest.release.maxAssetBytes,
    });
    await extractRecoveryArchive(downloadPath, extractionDirectory);
    await verifyRecoveryTree(extractionDirectory, state.tree.files, options.platform);
    if (await pathExists(destination)) {
      throw new Error(`Recovery destination already exists: ${destination}`);
    }
    await rename(extractionDirectory, destination);
    extractionDirectory = undefined;
    published = true;

    io.stdout(`Course version: ${options.manifest.courseVersion}`);
    io.stdout(`CLI version: ${cliVersion}`);
    io.stdout(`Source commit: ${state.sourceCommit}`);
    io.stdout(`Verified asset digest: ${download.sha256}`);
    io.stdout(`Destination: ${JSON.stringify(destination)}`);
    io.stdout('From the recovered directory shown above, run:');
    io.stdout('  pnpm install --frozen-lockfile');
    io.stdout('State verification:');
    for (const command of state.verification) io.stdout(`  ${command}`);
    return { exitCode: 0 };
  } catch (error) {
    if (published) await rm(destination, { force: true, recursive: true });
    io.stderr(`Recovery failed: ${error instanceof Error ? error.message : String(error)}`);
    return { exitCode: 1 };
  } finally {
    if (downloadPath !== undefined) await rm(downloadPath, { force: true });
    if (extractionDirectory !== undefined) await rm(extractionDirectory, { force: true, recursive: true });
  }
}
