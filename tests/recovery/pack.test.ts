import { execFileSync } from 'node:child_process';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildRecoveryAssets,
  type BuildRecoveryAssetsOptions,
} from '../../src/recovery/pack.js';
import { main as buildRecoveryAssetsMain } from '../../src/scripts/build-recovery-assets.js';
import { extractRecoveryArchive } from '../../src/recovery/extract.js';

const CLI_REPOSITORY =
  'https://github.com/madeupdev/madeup-video-course-cli';
const PROJECT_REPOSITORY =
  'https://github.com/madeupdev/advanced-monorepos-project';
const FIXTURE_DIRECTORY = fileURLToPath(
  new URL('../fixtures/repository', import.meta.url),
);
const temporaryDirectories: string[] = [];
const injectedFilesystemFailure = vi.hoisted(() => ({
  backupCleanup: false as false | 'partial',
  promotion: false,
}));

vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>(
    'node:fs/promises',
  );
  const path = await vi.importActual<typeof import('node:path')>('node:path');
  return {
    ...actual,
    rename: async (
      oldPath: Parameters<typeof actual.rename>[0],
      newPath: Parameters<typeof actual.rename>[1],
    ) => {
      if (
        injectedFilesystemFailure.promotion &&
        String(oldPath).includes('.staging-')
      ) {
        throw Object.assign(new Error('injected promotion failure'), {
          code: 'EIO',
        });
      }
      return actual.rename(oldPath, newPath);
    },
    rm: async (
      target: Parameters<typeof actual.rm>[0],
      options: Parameters<typeof actual.rm>[1],
    ) => {
      if (
        injectedFilesystemFailure.backupCleanup === 'partial' &&
        String(target).includes('.backup-')
      ) {
        await actual.rm(path.join(String(target), 'keep.json'), { force: true });
        throw Object.assign(new Error('injected partial backup cleanup failure'), {
          code: 'EACCES',
        });
      }
      return actual.rm(target, options);
    },
  };
});

type MutableRegister = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Fixture = Awaited<ReturnType<typeof createFixture>>;

afterEach(async () => {
  injectedFilesystemFailure.backupCleanup = false;
  injectedFilesystemFailure.promotion = false;
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function git(directory: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      LANG: 'C',
      LC_ALL: 'C',
    },
    input,
  }).trim();
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function baseRegister(sourceCommit: string): MutableRegister {
  return {
    schemaVersion: 1,
    courseVersion: '1.0.0',
    cliVersion: '1.0.0',
    cli: {
      packageName: '@madeup-video/course',
      repository: CLI_REPOSITORY,
    },
    project: {
      packageName: '@madeup-video/storefront',
      repository: PROJECT_REPOSITORY,
      localArtifacts: [
        { type: 'file', path: '.env' },
        { type: 'file', path: '.env.local' },
        { type: 'file', path: '.env.test' },
        { type: 'file', path: 'next-env.d.ts' },
        { type: 'directory', path: 'generated/prisma' },
        { type: 'directory', path: 'playwright-report' },
        { type: 'directory', path: 'test-results' },
        { type: 'directory-name', name: '.next' },
        { type: 'directory-name', name: 'coverage' },
        { type: 'directory-name', name: 'node_modules' },
        { type: 'file-suffix', suffix: '.tsbuildinfo' },
        { type: 'directory-name', name: 'dist' },
      ],
    },
    release: {
      repository: PROJECT_REPOSITORY,
      tag: 'course-v1.0.0',
      maxAssetBytes: 1024 * 1024,
    },
    states: [
      {
        id: 'fixture-start',
        sourceCommit,
        asset: 'fixture-start.tar.gz',
        sha256: 'PENDING',
        status: 'draft',
        verification: ['pnpm test'],
      },
    ],
    recipes: [],
  };
}

async function createFixture(): Promise<{
  root: string;
  project: string;
  registerPath: string;
  output: string;
  register: MutableRegister;
  sourceCommit: string;
}> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'recovery-pack-')),
  );
  temporaryDirectories.push(root);
  const project = join(root, 'project');
  await mkdir(project);
  git(project, ['init', '-b', 'main']);
  git(project, ['remote', 'add', 'origin', `${PROJECT_REPOSITORY}.git`]);
  await cp(FIXTURE_DIRECTORY, project, { recursive: true });
  await chmod(join(project, 'scripts/run.sh'), 0o755);
  await writeJson(join(project, 'package.json'), {
    name: '@madeup-video/storefront',
    version: '0.0.0',
  });
  const excludedFiles: Record<string, string> = {
    'node_modules/local/index.js': 'excluded node_modules\n',
    '.next/cache/data': 'excluded next\n',
    'dist/generated.js': 'excluded dist\n',
    'coverage/report.txt': 'excluded coverage\n',
    'playwright-report/index.html': 'excluded report\n',
    'test-results/result.txt': 'excluded results\n',
    'generated/prisma/client.js': 'excluded generated\n',
    'cache.tsbuildinfo': 'excluded build info\n',
  };
  for (const [path, contents] of Object.entries(excludedFiles)) {
    await mkdir(dirname(join(project, path)), { recursive: true });
    await writeFile(join(project, path), contents);
  }
  git(project, ['add', '-f', '.']);
  git(project, [
    '-c',
    'user.name=Recovery Tests',
    '-c',
    'user.email=recovery-tests@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    'fixture',
  ]);
  const sourceCommit = git(project, ['rev-parse', 'HEAD']);
  git(project, ['update-ref', 'refs/remotes/origin/main', sourceCommit]);
  const register = baseRegister(sourceCommit);
  const registerPath = join(root, 'delivery-states.json');
  await writeJson(registerPath, register);
  return {
    root,
    project,
    registerPath,
    output: join(root, 'output'),
    register,
    sourceCommit,
  };
}

function options(fixture: Fixture): BuildRecoveryAssetsOptions {
  return {
    projectDirectory: fixture.project,
    registerPath: fixture.registerPath,
    outputDirectory: fixture.output,
    builderIdentity: {
      packageName: '@madeup-video/course',
      repository: CLI_REPOSITORY,
    },
  };
}

async function commitPath(
  fixture: Fixture,
  path: string,
  contents: string,
  { updateOrigin = true }: { updateOrigin?: boolean } = {},
): Promise<string> {
  await mkdir(dirname(join(fixture.project, path)), { recursive: true });
  await writeFile(join(fixture.project, path), contents);
  git(fixture.project, ['add', '-f', path]);
  git(fixture.project, [
    '-c',
    'user.name=Recovery Tests',
    '-c',
    'user.email=recovery-tests@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-m',
    `add ${path}`,
  ]);
  const commit = git(fixture.project, ['rev-parse', 'HEAD']);
  if (updateOrigin) {
    git(fixture.project, ['update-ref', 'refs/remotes/origin/main', commit]);
  }
  return commit;
}

async function useCommit(fixture: Fixture, commit: string): Promise<void> {
  fixture.register.states[0].sourceCommit = commit;
  await writeJson(fixture.registerPath, fixture.register);
}

async function treePaths(archive: string, root: string): Promise<string[]> {
  const destination = join(root, `extract-${Math.random().toString(16).slice(2)}`);
  await extractRecoveryArchive(archive, destination);
  const paths: string[] = [];
  async function visit(directory: string, prefix = ''): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      paths.push(relativePath);
      if (entry.isDirectory()) {
        await visit(join(directory, entry.name), relativePath);
      }
    }
  }
  await visit(destination);
  return paths.sort();
}

describe('deterministic recovery archive packing', () => {
  it('builds identical bytes from immutable Git objects despite worktree bytes and mtimes', async () => {
    const fixture = await createFixture();
    const firstOutput = join(fixture.root, 'first');
    const secondOutput = join(fixture.root, 'second');

    await buildRecoveryAssets({ ...options(fixture), outputDirectory: firstOutput });
    await writeFile(join(fixture.project, 'src/index.ts'), 'uncommitted learner bytes\n');
    await writeJson(join(fixture.project, 'package.json'), { name: '@wrong/worktree-package' });
    await utimes(join(fixture.project, '.env.example'), new Date(1), new Date());
    await buildRecoveryAssets({ ...options(fixture), outputDirectory: secondOutput });

    const first = await readFile(join(firstOutput, 'fixture-start.tar.gz'));
    const second = await readFile(join(secondOutput, 'fixture-start.tar.gz'));
    expect(second).toEqual(first);
    expect(JSON.parse(await readFile(join(firstOutput, 'manifest.json'), 'utf8')))
      .toEqual(JSON.parse(await readFile(join(secondOutput, 'manifest.json'), 'utf8')));
  });

  it('excludes generated/local artifacts but retains tracked source, examples, migrations, lockfiles, and executable modes', async () => {
    const fixture = await createFixture();
    await buildRecoveryAssets(options(fixture));

    const archive = join(fixture.output, 'fixture-start.tar.gz');
    const paths = await treePaths(archive, fixture.root);
    expect(paths).toEqual(expect.arrayContaining([
      '.env.example',
      'package.json',
      'pnpm-lock.yaml',
      'prisma/migrations/001_init/migration.sql',
      'scripts/run.sh',
      'src/index.ts',
    ]));
    expect(paths).not.toEqual(expect.arrayContaining([
      'node_modules', '.next', 'dist', 'coverage', 'generated',
      'playwright-report', 'test-results', 'cache.tsbuildinfo',
    ]));

    const destination = join(fixture.root, 'mode-check');
    await extractRecoveryArchive(archive, destination);
    expect((await stat(join(destination, 'scripts/run.sh'))).mode & 0o777).toBe(0o755);
    expect((await stat(join(destination, 'src/index.ts'))).mode & 0o777).toBe(0o644);
  });

  it('writes computed metadata only after every archive succeeds', async () => {
    const fixture = await createFixture();
    const result = await buildRecoveryAssets(options(fixture));

    expect(result.assets).toHaveLength(1);
    expect(result.assets[0]).toMatchObject({
      id: 'fixture-start',
      sourceCommit: fixture.sourceCommit,
      asset: 'fixture-start.tar.gz',
    });
    expect(result.assets[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.assets[0]?.size).toBeGreaterThan(0);
    expect(await readdir(fixture.output)).toEqual([
      'SHA256SUMS',
      'fixture-start.tar.gz',
      'manifest.json',
    ]);
    expect(await readFile(join(fixture.output, 'SHA256SUMS'), 'utf8')).toBe(
      `${result.assets[0]?.sha256}  fixture-start.tar.gz\n`,
    );
  });

  it('replaces an existing output and removes its backup after successful cleanup', async () => {
    const fixture = await createFixture();
    await mkdir(fixture.output);
    await writeFile(join(fixture.output, 'keep.json'), 'old bytes\n');

    const result = await buildRecoveryAssets(options(fixture));

    expect(result.warnings).toEqual([]);
    expect(await readdir(fixture.output)).toEqual([
      'SHA256SUMS',
      'fixture-start.tar.gz',
      'manifest.json',
    ]);
    expect(
      (await readdir(fixture.root)).filter((name) =>
        /\.(?:backup|staging)-/u.test(name),
      ),
    ).toEqual([]);
  });

  it('restores an untouched existing output when promotion fails before commit', async () => {
    const fixture = await createFixture();
    const previousBytes = Buffer.from([0, 1, 2, 255]);
    await mkdir(fixture.output);
    await writeFile(join(fixture.output, 'keep.json'), previousBytes);
    injectedFilesystemFailure.promotion = true;

    await expect(buildRecoveryAssets(options(fixture))).rejects.toThrow(
      'injected promotion failure',
    );
    injectedFilesystemFailure.promotion = false;

    expect(await readdir(fixture.output)).toEqual(['keep.json']);
    expect(await readFile(join(fixture.output, 'keep.json'))).toEqual(
      previousBytes,
    );
    expect(
      (await readdir(fixture.root)).filter((name) =>
        /\.(?:backup|staging)-/u.test(name),
      ),
    ).toEqual([]);
  });

  it('keeps committed output and warns when backup cleanup partially fails', async () => {
    const fixture = await createFixture();
    await mkdir(fixture.output);
    await writeFile(join(fixture.output, 'keep.json'), 'old removable bytes\n');
    await mkdir(join(fixture.output, 'retained'));
    await writeFile(join(fixture.output, 'retained/old.json'), 'old retained bytes\n');
    injectedFilesystemFailure.backupCleanup = 'partial';

    const outcome = await buildRecoveryAssets(options(fixture)).then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    injectedFilesystemFailure.backupCleanup = false;

    expect(await readdir(fixture.output)).toEqual([
      'SHA256SUMS',
      'fixture-start.tar.gz',
      'manifest.json',
    ]);
    expect(outcome).toHaveProperty('result');
    if (!('result' in outcome)) return;
    expect(outcome.result.assets).toHaveLength(1);
    expect(outcome.result.warnings).toHaveLength(1);
    expect(outcome.result.warnings[0]).toMatchObject({
      kind: 'backup-cleanup-failed',
      message: 'injected partial backup cleanup failure',
    });
    const backupPath = outcome.result.warnings[0]?.backupPath;
    expect(backupPath).toBeTypeOf('string');
    if (backupPath === undefined) return;
    expect(dirname(backupPath)).toBe(fixture.root);
    expect(await readdir(backupPath)).toEqual(['retained']);
    expect(await readFile(join(backupPath, 'retained/old.json'), 'utf8')).toBe(
      'old retained bytes\n',
    );
    expect(
      (await readdir(fixture.root)).filter((name) => name.includes('.staging-')),
    ).toEqual([]);
  });

  it('prints post-commit cleanup warnings without failing the command', async () => {
    const fixture = await createFixture();
    await mkdir(fixture.output);
    await writeFile(join(fixture.output, 'keep.json'), 'old removable bytes\n');
    await mkdir(join(fixture.output, 'retained'));
    await writeFile(join(fixture.output, 'retained/old.json'), 'old retained bytes\n');
    const standardOutput = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const standardError = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    injectedFilesystemFailure.backupCleanup = 'partial';

    await expect(buildRecoveryAssetsMain([
      '--project', fixture.project,
      '--register', fixture.registerPath,
      '--output', fixture.output,
    ])).resolves.toBeUndefined();
    injectedFilesystemFailure.backupCleanup = false;

    expect(standardOutput).toHaveBeenCalledWith(
      expect.stringContaining('Built 1 deterministic recovery archives'),
    );
    expect(standardError).toHaveBeenCalledWith(
      expect.stringMatching(
        /Warning: backup cleanup failed after recovery assets committed.*\.backup-.*injected partial backup cleanup failure/u,
      ),
    );
  });

  it('preflights malformed JSON without creating a missing output', async () => {
    const fixture = await createFixture();
    await writeFile(fixture.registerPath, '{"states":');

    await expect(buildRecoveryAssets(options(fixture))).rejects.toThrow('Malformed JSON');
    await expect(lstat(fixture.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preflights every later state and leaves an existing output byte-for-byte unchanged', async () => {
    const fixture = await createFixture();
    fixture.register.states.push({
      ...fixture.register.states[0],
      id: 'later-state',
      asset: 'later-state.tar.gz',
      sourceCommit: 'f'.repeat(40),
    });
    await writeJson(fixture.registerPath, fixture.register);
    await mkdir(fixture.output);
    await writeFile(join(fixture.output, 'existing.bin'), Buffer.from([0, 1, 2, 255]));

    await expect(buildRecoveryAssets(options(fixture))).rejects.toThrow('$.states[1].sourceCommit');
    expect(await readdir(fixture.output)).toEqual(['existing.bin']);
    expect(await readFile(join(fixture.output, 'existing.bin'))).toEqual(Buffer.from([0, 1, 2, 255]));
  });

  it.each([
    ['project package', async (fixture: Fixture) => commitPath(fixture, 'package.json', '{"name":"@wrong/project"}\n')],
    ['project origin', async (fixture: Fixture) => git(fixture.project, ['remote', 'set-url', 'origin', 'https://github.com/other/project.git'])],
  ])('rejects a mismatched %s identity', async (_label, mutate) => {
    const fixture = await createFixture();
    await mutate(fixture);

    await expect(buildRecoveryAssets(options(fixture))).rejects.toThrow(/project\.(packageName|repository)/);
    await expect(lstat(fixture.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a source SHA that names a non-commit object', async () => {
    const fixture = await createFixture();
    const blob = git(fixture.project, ['hash-object', 'package.json']);
    await useCommit(fixture, blob);

    await expect(buildRecoveryAssets(options(fixture))).rejects.toThrow('not a commit');
    await expect(lstat(fixture.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a valid commit not reachable from canonical origin/main', async () => {
    const fixture = await createFixture();
    const unreachable = await commitPath(fixture, 'unreachable.txt', 'unreachable\n', { updateOrigin: false });
    await useCommit(fixture, unreachable);

    await expect(buildRecoveryAssets(options(fixture))).rejects.toThrow('origin/main');
    await expect(lstat(fixture.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects portable path collisions present in an immutable Git tree', async () => {
    const fixture = await createFixture();
    const blob = git(fixture.project, ['hash-object', '-w', '--stdin'], 'collision\n');
    const packageBlob = git(fixture.project, [
      'rev-parse',
      `${fixture.sourceCommit}:package.json`,
    ]);
    const tree = git(
      fixture.project,
      ['mktree'],
      `100644 blob ${blob}\tREADME\n100644 blob ${packageBlob}\tpackage.json\n100644 blob ${blob}\treadme\n`,
    );
    const commit = git(
      fixture.project,
      ['-c', 'user.name=Recovery Tests', '-c', 'user.email=recovery-tests@example.invalid', 'commit-tree', tree, '-p', fixture.sourceCommit, '-m', 'collision'],
    );
    git(fixture.project, ['update-ref', 'refs/remotes/origin/main', commit]);
    await useCommit(fixture, commit);

    await expect(buildRecoveryAssets(options(fixture))).rejects.toThrow('portable path collision');
    await expect(lstat(fixture.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['tracked secret', '.env', 'SECRET=tracked\n'],
    ['symbolic link', 'linked-file', 'target'],
  ])('rejects a %s in a source tree', async (label, path, contents) => {
    const fixture = await createFixture();
    let commit: string;
    if (label === 'symbolic link') {
      await symlink(contents, join(fixture.project, path));
      git(fixture.project, ['add', path]);
      git(fixture.project, ['-c', 'user.name=Recovery Tests', '-c', 'user.email=recovery-tests@example.invalid', 'commit', '-m', 'unsafe link']);
      commit = git(fixture.project, ['rev-parse', 'HEAD']);
      git(fixture.project, ['update-ref', 'refs/remotes/origin/main', commit]);
    } else {
      commit = await commitPath(fixture, path, contents);
    }
    await useCommit(fixture, commit);

    await expect(buildRecoveryAssets(options(fixture))).rejects.toThrow(/secret|link/i);
    await expect(lstat(fixture.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a submodule entry in a source tree', async () => {
    const fixture = await createFixture();
    git(fixture.project, ['update-index', '--add', '--cacheinfo', `160000,${fixture.sourceCommit},vendor`]);
    git(fixture.project, ['-c', 'user.name=Recovery Tests', '-c', 'user.email=recovery-tests@example.invalid', 'commit', '-m', 'unsafe submodule']);
    const commit = git(fixture.project, ['rev-parse', 'HEAD']);
    git(fixture.project, ['update-ref', 'refs/remotes/origin/main', commit]);
    await useCommit(fixture, commit);

    await expect(buildRecoveryAssets(options(fixture))).rejects.toThrow('submodule');
    await expect(lstat(fixture.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects symlinked output components without touching their targets', async () => {
    const fixture = await createFixture();
    const target = join(fixture.root, 'outside');
    await mkdir(target);
    await writeFile(join(target, 'marker'), 'unchanged\n');
    const linkedParent = join(fixture.root, 'linked-output');
    await symlink(target, linkedParent);
    fixture.output = join(linkedParent, 'assets');

    await expect(buildRecoveryAssets(options(fixture))).rejects.toThrow(/symbolic link|symlink/i);
    expect(await readdir(target)).toEqual(['marker']);
    expect(await readFile(join(target, 'marker'), 'utf8')).toBe('unchanged\n');
  });

  it('rejects oversized archives before promotion', async () => {
    const fixture = await createFixture();
    fixture.register.release.maxAssetBytes = 16;
    await writeJson(fixture.registerPath, fixture.register);

    await expect(buildRecoveryAssets(options(fixture))).rejects.toThrow('maxAssetBytes');
    await expect(lstat(fixture.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
