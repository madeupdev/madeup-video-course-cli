#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildRecoveryAssets } from '../recovery/pack.js';

type Arguments = Readonly<{
  projectDirectory: string;
  registerPath: string;
  outputDirectory: string;
}>;

function usage(): string {
  return 'Usage: build-recovery-assets --project <repository> --register <delivery-states.json> --output <directory>';
}

function parseArguments(argv: readonly string[]): Arguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (
      option === undefined ||
      value === undefined ||
      value.startsWith('--') ||
      !['--project', '--register', '--output'].includes(option) ||
      values.has(option)
    ) {
      throw new Error(usage());
    }
    values.set(option, value);
  }
  const projectDirectory = values.get('--project');
  const registerPath = values.get('--register');
  const outputDirectory = values.get('--output');
  if (
    values.size !== 3 ||
    projectDirectory === undefined ||
    registerPath === undefined ||
    outputDirectory === undefined
  ) {
    throw new Error(usage());
  }
  return { projectDirectory, registerPath, outputDirectory };
}

function canonicalPackageRepository(value: unknown): string {
  const repository =
    typeof value === 'string'
      ? value
      : typeof value === 'object' && value !== null && 'url' in value
        ? (value as { url?: unknown }).url
        : undefined;
  if (typeof repository !== 'string') {
    throw new Error('Builder package.json is missing repository.url');
  }
  const canonical = repository
    .replace(/^git\+/u, '')
    .replace(/\.git$/u, '')
    .replace(/\/+$/u, '');
  if (!canonical.startsWith('https://github.com/')) {
    throw new Error('Builder package.json repository must be a GitHub HTTPS URL');
  }
  return canonical;
}

async function readBuilderIdentity(): Promise<{
  packageName: string;
  repository: string;
}> {
  const packagePath = fileURLToPath(new URL('../../package.json', import.meta.url));
  const packageValue = JSON.parse(await readFile(packagePath, 'utf8')) as {
    name?: unknown;
    repository?: unknown;
  };
  if (typeof packageValue.name !== 'string') {
    throw new Error('Builder package.json is missing name');
  }
  return {
    packageName: packageValue.name,
    repository: canonicalPackageRepository(packageValue.repository),
  };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArguments(argv);
  const result = await buildRecoveryAssets({
    ...args,
    builderIdentity: await readBuilderIdentity(),
  });
  process.stdout.write(
    `Built ${String(result.assets.length)} deterministic recovery archives in ${result.outputDirectory}\n`,
  );
  for (const warning of result.warnings) {
    process.stderr.write(
      `Warning: backup cleanup failed after recovery assets committed; retained backup: ${warning.backupPath}; ${warning.message}\n`,
    );
  }
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  import.meta.url === pathToFileURL(resolve(entryPoint)).href
) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
