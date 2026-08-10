#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { dirname, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DoctorOptions } from './commands/doctor.js';
import type { ApplyOptions } from './commands/apply.js';

export type CliIo = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  confirm?: (prompt: string) => Promise<boolean>;
};

export type CliDependencies = {
  apply?: ApplyOptions;
  doctor?: DoctorOptions;
};

export type BundledDoctorOptionsInput = {
  moduleUrl: URL;
  startDirectory: string;
  nodeVersion: string;
  platform: NodeJS.Platform;
};

type PackageContract = {
  version: string;
  engines: { node: string };
};

function packageContract(value: unknown): PackageContract {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    typeof value.version !== 'string' ||
    !('engines' in value) ||
    typeof value.engines !== 'object' ||
    value.engines === null ||
    !('node' in value.engines) ||
    typeof value.engines.node !== 'string'
  ) {
    throw new Error('Package metadata is missing its pinned version or Node engine');
  }
  return {
    version: value.version,
    engines: { node: value.engines.node },
  };
}

export async function loadBundledDoctorOptions(
  input: BundledDoctorOptionsInput,
): Promise<DoctorOptions> {
  const packageRoot = dirname(dirname(fileURLToPath(input.moduleUrl)));
  const packagePath = resolve(packageRoot, 'package.json');
  const metadata = packageContract(
    JSON.parse(await readFile(packagePath, 'utf8')) as unknown,
  );
  const manifestPath = resolve(
    packageRoot,
    'recovery',
    `course-v${metadata.version}.json`,
  );
  const { loadManifest } = await import('./manifest/load.js');
  const loadedManifest = await loadManifest(manifestPath);
  if (!loadedManifest.ok) {
    throw new Error(
      `Unable to load ${manifestPath}: ${loadedManifest.error.message}`,
    );
  }
  if (loadedManifest.manifest.courseVersion !== metadata.version) {
    throw new Error(
      `Manifest course version ${loadedManifest.manifest.courseVersion} does not match CLI version ${metadata.version}`,
    );
  }

  return {
    startDirectory: input.startDirectory,
    workingBoundary: parse(resolve(input.startDirectory)).root,
    manifest: loadedManifest.manifest,
    cliVersion: metadata.version,
    nodeVersion: input.nodeVersion,
    expectedNodeVersion: metadata.engines.node,
    platform: input.platform,
  };
}

export async function loadBundledApplyOptions(
  input: BundledDoctorOptionsInput,
): Promise<ApplyOptions> {
  const doctorOptions = await loadBundledDoctorOptions(input);
  return {
    startDirectory: doctorOptions.startDirectory,
    workingBoundary: doctorOptions.workingBoundary,
    sourceRoot: dirname(dirname(fileURLToPath(input.moduleUrl))),
    manifest: doctorOptions.manifest,
  };
}

const HELP_TEXT = `Prepared-code and project-recovery infrastructure for the Made Up Video advanced monorepos course.

Usage:
  madeup-video-course <command>

Planned learner-facing commands:
  apply <recipe>
  apply <recipe> --yes
  apply <recipe> --dry-run
  doctor
  recover <state> --directory <new-directory>`;

export async function runCli(
  args: readonly string[],
  io: CliIo,
  dependencies: CliDependencies = {},
): Promise<number> {
  if (args.length === 1 && args[0] === '--help') {
    io.stdout(HELP_TEXT);
    return 0;
  }

  if (args.length === 1 && args[0] === 'doctor') {
    let doctorOptions = dependencies.doctor;
    if (doctorOptions === undefined) {
      try {
        doctorOptions = await loadBundledDoctorOptions({
          moduleUrl: new URL(import.meta.url),
          startDirectory: process.cwd(),
          nodeVersion: process.versions.node,
          platform: process.platform,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        io.stderr(`Course manifest unavailable. ${message}`);
        return 1;
      }
    }
    if (doctorOptions === undefined) {
      io.stderr(
        'Course manifest unavailable. The doctor command requires a registered course delivery manifest.',
      );
      return 1;
    }
    const { runDoctor } = await import('./commands/doctor.js');
    return (await runDoctor(doctorOptions, io)).exitCode;
  }

  if (
    args.length === 3 &&
    args[0] === 'apply' &&
    args[1] !== undefined &&
    args[2] === '--dry-run'
  ) {
    let applyOptions = dependencies.apply;
    if (applyOptions === undefined) {
      try {
        applyOptions = await loadBundledApplyOptions({
          moduleUrl: new URL(import.meta.url),
          startDirectory: process.cwd(),
          nodeVersion: process.versions.node,
          platform: process.platform,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        io.stderr(`Course manifest unavailable. ${message}`);
        return 1;
      }
    }
    const { runApplyDryRun } = await import('./commands/apply.js');
    return (await runApplyDryRun(args[1], applyOptions, io)).exitCode;
  }

  if (
    (args.length === 2 ||
      (args.length === 3 && args[2] === '--yes')) &&
    args[0] === 'apply' &&
    args[1] !== undefined
  ) {
    let applyOptions = dependencies.apply;
    if (applyOptions === undefined) {
      try {
        applyOptions = await loadBundledApplyOptions({
          moduleUrl: new URL(import.meta.url),
          startDirectory: process.cwd(),
          nodeVersion: process.versions.node,
          platform: process.platform,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        io.stderr(`Course manifest unavailable. ${message}`);
        return 1;
      }
    }
    const { runApply } = await import('./commands/apply.js');
    const result = await runApply(args[1], applyOptions, io, {
      yes: args[2] === '--yes',
    });
    return result.kind === 'applied' || result.kind === 'already-applied'
      ? 0
      : 1;
  }

  const command = args[0] ?? '(none)';
  io.stderr(
    `Unknown command: ${command}\nRun madeup-video-course --help for the planned learner-facing commands.`,
  );
  return 1;
}

if (import.meta.main) {
  const processIo: CliIo = {
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
  };
  if (process.stdin.isTTY && process.stdout.isTTY) {
    processIo.confirm = async (prompt) => {
      const { createInterface } = await import('node:readline/promises');
      const terminal = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        const answer = await terminal.question(`${prompt} [y/N] `);
        return /^(?:y|yes)$/iu.test(answer.trim());
      } finally {
        terminal.close();
      }
    };
  }
  process.exitCode = await runCli(process.argv.slice(2), processIo);
}
