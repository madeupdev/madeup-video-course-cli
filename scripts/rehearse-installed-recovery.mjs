#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify, TextDecoder } from 'node:util';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ids = ['S08-L01-suite-ownership', 'S08-L02-affected-selection', 'S08-L03-cache-integrity', 'S08-final'];
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function selectSection8States(register) {
  if (!Array.isArray(register?.states)) throw new Error('Private register has no states');
  const section8 = register.states.filter((state) => typeof state.id === 'string' && state.id.startsWith('S08-'));
  if (section8.length !== 4 || new Set(section8.map((state) => state.id)).size !== 4) {
    throw new Error('Private register must contain exactly four distinct Section 8 states');
  }
  const states = ids.map((id) => register.states.find((state) => state.id === id));
  if (states.some((state) => state === undefined)) throw new Error('Private register must contain all four Section 8 states');
  if (states.some((state) => state.status !== 'draft')) throw new Error('Section 8 states must remain draft');
  if (states.some((state) => !/^[a-f0-9]{64}$/.test(state.sha256))) throw new Error('Section 8 states require pinned digests');
  return states;
}

async function command(executable, args, options = {}) {
  try {
    return await exec(executable, args, { maxBuffer: 32 * 1024 * 1024, ...options });
  } catch (error) {
    throw new Error(`${error.message}\n${String(error.stdout ?? '')}\n${String(error.stderr ?? '')}`);
  }
}

async function gitTree(project, commit) {
  const { stdout } = await command('git', ['ls-tree', '-rz', '--full-tree', commit], { cwd: project, encoding: 'buffer' });
  const files = [];
  for (const record of stdout.subarray(0, -1).toString('binary').split('\0')) {
    if (!record) continue;
    const entry = Buffer.from(record, 'binary');
    const tab = entry.indexOf(9);
    if (tab < 0) throw new Error(`Malformed Git tree at ${commit}`);
    const [mode, type, object] = entry.subarray(0, tab).toString('ascii').split(' ');
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new Error(`Unsupported Git entry at ${commit}`);
    const path = new TextDecoder('utf-8', { fatal: true }).decode(entry.subarray(tab + 1));
    const blob = await command('git', ['cat-file', 'blob', object], { cwd: project, encoding: 'buffer' });
    files.push({ path, mode: mode === '100755' ? 0o755 : 0o644, sha256: sha256(blob.stdout) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return { algorithm: 'course-tree-v1', files };
}

async function verifyAgainstGit(destination, expected) {
  const actual = [];
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = join(directory, entry.name);
      if (entry.isDirectory()) await visit(target, path);
      else if (entry.isFile()) {
        const stat = await lstat(target);
        actual.push({ path, mode: stat.mode & 0o777, sha256: sha256(await readFile(target)) });
      } else throw new Error(`Unsupported recovered entry: ${path}`);
    }
  }
  await visit(destination);
  const byPath = new Map(actual.map((file) => [file.path, file]));
  if (actual.length !== expected.files.length) throw new Error('Recovered source-tree file count differs from Git');
  for (const file of expected.files) {
    const found = byPath.get(file.path);
    if (!found || found.sha256 !== file.sha256 || (process.platform !== 'win32' && found.mode !== file.mode)) {
      throw new Error(`Recovered source-tree mismatch: ${file.path}`);
    }
  }
  return actual.length;
}

function argumentsFrom(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (!['--project', '--register'].includes(argv[index]) || !argv[index + 1]) {
      throw new Error('Usage: node scripts/rehearse-installed-recovery.mjs --project <project> --register <private-register>');
    }
    values.set(argv[index], resolve(argv[index + 1]));
  }
  if (values.size !== 2) throw new Error('Both --project and --register are required');
  return { project: values.get('--project'), registerPath: values.get('--register') };
}

async function run(argv) {
  const { project, registerPath } = argumentsFrom(argv);
  const register = JSON.parse(await readFile(registerPath, 'utf8'));
  const states = selectSection8States(register);
  if (register.courseVersion !== '1.0.0' || register.cliVersion !== '1.0.0') throw new Error('Expected edition 1.0.0');
  const workspace = await mkdtemp(join(await realpath(tmpdir()), 'course-installed-recovery-'));
  try {
    const subsetPath = join(workspace, 'private-register.json');
    const builderStates = states.map((state) => Object.fromEntries(Object.entries(state).filter(([key]) => key !== 'trustedCI')));
    await writeFile(subsetPath, JSON.stringify({ ...register, states: builderStates, recipes: [] }));
    const assets = join(workspace, 'assets');
    await command(process.execPath, [join(root, 'dist/scripts/build-recovery-assets.js'), '--project', project, '--register', subsetPath, '--output', assets]);
    const recoveryStates = [];
    const assetMap = {};
    for (const state of states) {
      const archive = join(assets, state.asset);
      const digest = sha256(await readFile(archive));
      if (digest !== state.sha256) throw new Error(`Archive digest mismatch for ${state.id}`);
      recoveryStates.push({ id: state.id, sourceCommit: state.sourceCommit, asset: state.asset, sha256: state.sha256, tree: await gitTree(project, state.sourceCommit), verification: state.verification });
      assetMap[`${register.release.repository}/releases/download/${encodeURIComponent(register.release.tag)}/${encodeURIComponent(state.asset)}`] = archive;
    }
    const packageRoot = join(workspace, 'candidate');
    await mkdir(join(packageRoot, 'recovery'), { recursive: true });
    for (const name of ['dist', 'recipes']) await cp(join(root, name), join(packageRoot, name), { recursive: true });
    for (const name of ['README.md', 'LICENSE.md']) await copyFile(join(root, name), join(packageRoot, name));
    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    packageJson.version = register.courseVersion;
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify(packageJson, null, 2));
    const manifest = { schemaVersion: 1, courseVersion: register.courseVersion, project: register.project, release: register.release, recoveryStates, recipes: [] };
    await writeFile(join(packageRoot, 'recovery', `course-v${register.courseVersion}.json`), JSON.stringify(manifest, null, 2));
    const npmEnvironment = { ...process.env, npm_config_cache: join(workspace, 'npm-cache') };
    const { stdout: packed } = await command('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', workspace], { cwd: packageRoot, env: npmEnvironment });
    const tarball = join(workspace, JSON.parse(packed)[0].filename);
    const packageDigest = sha256(await readFile(tarball));
    const consumer = join(workspace, 'consumer');
    await mkdir(consumer);
    await command('corepack', ['pnpm', 'add', '--ignore-scripts', '--dir', consumer, tarball], { env: npmEnvironment });
    const installed = join(consumer, 'node_modules', '@madeup-video', 'course');
    const installedManifest = JSON.parse(await readFile(join(installed, 'recovery', `course-v${register.courseVersion}.json`), 'utf8'));
    if (installedManifest.recoveryStates.length !== 4) throw new Error('Installed candidate has the wrong state count');
    const mapPath = join(workspace, 'asset-map.json');
    await writeFile(mapPath, JSON.stringify(assetMap));
    const preload = join(workspace, 'local-assets.mjs');
    await writeFile(preload, `import { readFile } from 'node:fs/promises';\nconst map = JSON.parse(await readFile(process.env.COURSE_REHEARSAL_ASSET_MAP, 'utf8'));\nglobalThis.fetch = async (input) => { const url = String(input); const path = map[url]; if (!path) throw new Error('Unapproved rehearsal asset URL: ' + url); const bytes = await readFile(path); return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } }); };\n`);
    const binary = join(installed, 'dist', 'cli.js');
    const results = [];
    let refusalChecks = false;
    for (const state of recoveryStates) {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const destination = join(workspace, `recovered-${state.id}-${attempt}`);
        const { stdout } = await command(process.execPath, ['--import', preload, binary, 'recover', state.id, '--directory', destination], { cwd: consumer, env: { ...process.env, COURSE_REHEARSAL_ASSET_MAP: mapPath } });
        if (!stdout.includes(`Verified asset digest: ${state.sha256}`) || !stdout.includes(`Source commit: ${state.sourceCommit}`)) throw new Error(`Installed CLI did not report expected identity for ${state.id}`);
        const fileCount = await verifyAgainstGit(destination, state.tree);
        results.push({ id: state.id, attempt, sourceCommit: state.sourceCommit, archiveSha256: state.sha256, files: fileCount });
        if (!refusalChecks) {
          let existingFailure = '';
          try {
            await command(process.execPath, ['--import', preload, binary, 'recover', state.id, '--directory', destination], { cwd: consumer, env: { ...process.env, COURSE_REHEARSAL_ASSET_MAP: mapPath } });
          } catch (error) { existingFailure = error.message; }
          if (!existingFailure.includes('Recovery destination already exists')) throw new Error('Installed CLI did not refuse an existing directory');
          await verifyAgainstGit(destination, state.tree);
          const manifestPath = join(installed, 'recovery', `course-v${register.courseVersion}.json`);
          const corruptManifest = JSON.parse(JSON.stringify(installedManifest));
          corruptManifest.recoveryStates[0].sha256 = '0'.repeat(64);
          await writeFile(manifestPath, JSON.stringify(corruptManifest));
          const failedDestination = join(workspace, 'rejected-bad-digest');
          let digestFailure = '';
          try {
            await command(process.execPath, ['--import', preload, binary, 'recover', state.id, '--directory', failedDestination], { cwd: consumer, env: { ...process.env, COURSE_REHEARSAL_ASSET_MAP: mapPath } });
          } catch (error) { digestFailure = error.message; }
          await writeFile(manifestPath, JSON.stringify(installedManifest));
          if (!digestFailure.includes('digest mismatch')) throw new Error('Installed CLI did not reject a wrong digest');
          try { await lstat(failedDestination); throw new Error('Failed recovery left a destination'); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          refusalChecks = true;
        }
      }
    }
    process.stdout.write(`${JSON.stringify({ host: `${process.platform}/${process.arch}`, installedCandidateSha256: packageDigest, transport: 'local fetch interception of exact manifest URLs', refusalChecks: ['existing destination', 'wrong digest and cleanup'], results }, null, 2)}\n`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
