import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { loadBundledDoctorOptions, runCli } from '../../src/cli.js';
import type { CourseManifest, CourseTreeFile } from '../../src/manifest/types.js';
import { runDoctor } from '../../src/commands/doctor.js';
import {
  classifyCourseState,
  inspectCourseTree,
} from '../../src/state/classify.js';
import { hashBytes } from '../../src/project/hash.js';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

function treeFile(
  path: string,
  contents: string,
  mode: 0o644 | 0o755 = 0o644,
): CourseTreeFile {
  return {
    path,
    mode,
    sha256: hashBytes(Buffer.from(contents)),
  };
}

function manifest(
  states: Array<{ id: string; files: CourseTreeFile[] }>,
  recipes: CourseManifest['recipes'] = [],
): CourseManifest {
  return {
    schemaVersion: 1,
    courseVersion: '1.0.0',
    project: {
      packageName: '@madeup-video/storefront',
      repository: 'https://github.com/madeupdev/madeup-video-storefront',
      localArtifacts: [
        { type: 'file', path: '.env' },
        { type: 'directory', path: 'generated/prisma' },
        { type: 'directory-name', name: 'node_modules' },
        { type: 'file-suffix', suffix: '.tsbuildinfo' },
      ],
    },
    release: {
      repository: 'https://github.com/madeupdev/madeup-video-storefront',
      tag: 'course-v1.0.0',
      maxAssetBytes: 1024 * 1024,
    },
    recoveryStates: states.map(({ id, files }, index) => ({
      id,
      sourceCommit: String(index + 1).repeat(40).slice(0, 40),
      asset: `${id}.tar.gz`,
      sha256: String(index + 1).repeat(64).slice(0, 64),
      tree: {
        algorithm: 'course-tree-v1',
        files,
      },
      verification: ['pnpm test'],
    })),
    recipes,
  };
}

const startFiles = [
  treeFile('package.json', 'package-start'),
  treeFile('src/index.ts', 'start'),
];
const resultFiles = [
  treeFile('package.json', 'package-start'),
  treeFile('src/index.ts', 'result'),
];
const standaloneFiles = [
  treeFile('package.json', 'standalone'),
  treeFile('src/index.ts', 'standalone'),
];

const adminRecipe: CourseManifest['recipes'][number] = {
  id: 'admin-ui',
  description: 'Add the prepared admin UI',
  expectedPackageName: '@madeup-video/storefront',
  startingState: 'section-start',
  resultState: 'section-result',
  operations: [
    {
      type: 'replace',
      destination: 'src/index.ts',
      template: 'admin-ui/src/index.ts',
      beforeSha256: startFiles[1]!.sha256,
      afterSha256: resultFiles[1]!.sha256,
      mode: 0o644,
    },
  ],
  verification: ['pnpm test'],
};

describe('course-state classification', () => {
  it('recognises an exact recovery state with no prepared next step', () => {
    const courseManifest = manifest([
      { id: 'standalone', files: standaloneFiles },
    ]);

    expect(
      classifyCourseState(courseManifest, standaloneFiles, {
        platform: 'linux',
      }),
    ).toEqual({
      kind: 'exact',
      state: 'standalone',
      mismatches: [],
    });
  });

  it('recognises when a recipe can be applied from an exact starting state', () => {
    const courseManifest = manifest(
      [
        { id: 'section-start', files: startFiles },
        { id: 'section-result', files: resultFiles },
      ],
      [adminRecipe],
    );

    expect(
      classifyCourseState(courseManifest, startFiles, {
        platform: 'linux',
      }),
    ).toEqual({
      kind: 'applicable',
      state: 'section-start',
      recipe: 'admin-ui',
      mismatches: [],
    });
  });

  it('recognises an exact recipe result without treating it as applicable', () => {
    const courseManifest = manifest(
      [
        { id: 'section-start', files: startFiles },
        { id: 'section-result', files: resultFiles },
      ],
      [adminRecipe],
    );

    expect(
      classifyCourseState(courseManifest, resultFiles, {
        platform: 'linux',
      }),
    ).toEqual({
      kind: 'exact',
      state: 'section-result',
      completedRecipe: 'admin-ui',
      mismatches: [],
    });
  });

  it('reports modified, missing, unexpected, and mode-mismatched files', () => {
    const courseManifest = manifest([
      {
        id: 'nearest',
        files: [
          treeFile('a.txt', 'a'),
          treeFile('missing.txt', 'missing'),
          treeFile('modified.txt', 'before'),
          treeFile('script.sh', 'script', 0o755),
        ],
      },
    ]);
    const actual = [
      treeFile('a.txt', 'a'),
      treeFile('modified.txt', 'after'),
      treeFile('script.sh', 'script', 0o644),
      treeFile('unexpected.txt', 'unexpected'),
    ];

    expect(
      classifyCourseState(courseManifest, actual, { platform: 'linux' }),
    ).toEqual({
      kind: 'unknown',
      nearestState: 'nearest',
      mismatches: [
        { kind: 'missing', path: 'missing.txt' },
        { kind: 'modified', path: 'modified.txt' },
        {
          kind: 'mode-mismatched',
          path: 'script.sh',
          expectedMode: 0o755,
          actualMode: 0o644,
        },
        { kind: 'unexpected', path: 'unexpected.txt' },
      ],
    });
  });

  it('does not fail state identity solely on executable intent on Windows', () => {
    const expected = [treeFile('script.sh', 'script', 0o755)];
    const actual = [treeFile('script.sh', 'script', 0o644)];
    const courseManifest = manifest([{ id: 'windows-state', files: expected }]);

    expect(
      classifyCourseState(courseManifest, actual, { platform: 'win32' }),
    ).toMatchObject({
      kind: 'exact',
      state: 'windows-state',
    });
  });

  it('reports ambiguity when inventories are equally near', () => {
    const courseManifest = manifest([
      {
        id: 'alpha',
        files: [treeFile('package.json', 'same'), treeFile('a.txt', 'a')],
      },
      {
        id: 'beta',
        files: [treeFile('package.json', 'same'), treeFile('b.txt', 'b')],
      },
    ]);

    expect(
      classifyCourseState(
        courseManifest,
        [treeFile('package.json', 'same')],
        { platform: 'linux' },
      ),
    ).toEqual({
      kind: 'ambiguous',
      states: ['alpha', 'beta'],
      mismatchCount: 1,
    });
  });

  it('preserves exact path spelling when comparing portable paths', () => {
    const courseManifest = manifest([
      { id: 'case-state', files: [treeFile('src/File.ts', 'same')] },
    ]);

    expect(
      classifyCourseState(
        courseManifest,
        [treeFile('src/file.ts', 'same')],
        { platform: 'linux' },
      ),
    ).toEqual({
      kind: 'unknown',
      nearestState: 'case-state',
      mismatches: [
        { kind: 'missing', path: 'src/File.ts' },
        { kind: 'unexpected', path: 'src/file.ts' },
      ],
    });
  });
});

describe('course-tree inspection', () => {
  it('excludes only declared local artifacts and repository-root Git metadata', async () => {
    const root = await temporaryDirectory('course-doctor-tree-');
    await mkdir(join(root, '.git'), { recursive: true });
    await mkdir(join(root, 'generated', 'prisma'), { recursive: true });
    await mkdir(join(root, 'nested', 'node_modules'), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, '.git', 'config'), 'git');
    await writeFile(join(root, '.env'), 'secret');
    await writeFile(join(root, 'generated', 'prisma', 'client.js'), 'generated');
    await writeFile(join(root, 'nested', 'node_modules', 'package.js'), 'dependency');
    await writeFile(join(root, 'cache.tsbuildinfo'), 'cache');
    await writeFile(join(root, 'src', 'index.ts'), 'managed');

    const result = await inspectCourseTree(
      root,
      manifest([{ id: 'state', files: [treeFile('src/index.ts', 'managed')] }])
        .project.localArtifacts,
      { platform: 'linux' },
    );

    expect(result).toEqual({
      ok: true,
      files: [treeFile('src/index.ts', 'managed')],
    });
  });

  it('rejects symlinks instead of following them', async () => {
    const root = await temporaryDirectory('course-doctor-link-');
    const outside = await temporaryDirectory('course-doctor-outside-');
    await writeFile(join(outside, 'secret.txt'), 'secret');
    try {
      await symlink(join(outside, 'secret.txt'), join(root, 'linked.txt'));
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        ['EACCES', 'EPERM', 'ENOTSUP'].includes(String(error.code))
      ) {
        return;
      }
      throw error;
    }

    await expect(
      inspectCourseTree(root, [], { platform: 'linux' }),
    ).resolves.toMatchObject({
      ok: false,
      finding: {
        kind: 'unsupported-entry',
        path: 'linked.txt',
        entryType: 'symbolic-link',
      },
    });
  });

  it('rejects normalization and case collisions in actual paths', async () => {
    const root = await temporaryDirectory('course-doctor-collision-');
    await writeFile(join(root, 'A.txt'), 'one');
    await writeFile(join(root, 'a.txt'), 'two');
    if ((await readdir(root)).length < 2) {
      return;
    }

    await expect(
      inspectCourseTree(root, [], { platform: 'linux' }),
    ).resolves.toMatchObject({
      ok: false,
      finding: {
        kind: 'path-collision',
        paths: ['A.txt', 'a.txt'],
      },
    });
  });

  it('records portable executable intent on POSIX', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const root = await temporaryDirectory('course-doctor-mode-');
    const script = join(root, 'script.sh');
    await writeFile(script, 'script');
    await chmod(script, 0o755);

    await expect(
      inspectCourseTree(root, [], { platform: 'linux' }),
    ).resolves.toEqual({
      ok: true,
      files: [treeFile('script.sh', 'script', 0o755)],
    });
  });

  it('rejects a literal backslash in a POSIX filename', async () => {
    if (process.platform === 'win32') {
      return;
    }
    const root = await temporaryDirectory('course-doctor-backslash-');
    await writeFile(join(root, String.raw`src\evil.ts`), 'unsafe');

    await expect(
      inspectCourseTree(root, [], { platform: 'linux' }),
    ).resolves.toEqual({
      ok: false,
      finding: {
        kind: 'unsafe-path',
        path: String.raw`src\evil.ts`,
        reason: 'backslash-separator',
      },
    });
  });
});

async function writeProject(
  root: string,
  packageName = '@madeup-video/storefront',
): Promise<CourseTreeFile[]> {
  const packageContents = JSON.stringify({ name: packageName });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'package.json'), packageContents);
  await writeFile(join(root, 'src', 'index.ts'), 'start');
  return [
    treeFile('package.json', packageContents),
    treeFile('src/index.ts', 'start'),
  ];
}

function initializeGit(root: string): void {
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'course@example.test'],
    ['config', 'user.name', 'Course Test'],
    ['config', 'commit.gpgsign', 'false'],
    ['add', '.'],
    ['commit', '-qm', 'fixture'],
  ]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(result.stderr);
    }
  }
}

describe('doctor command', () => {
  it('prints a healthy applicable state and returns zero', async () => {
    const root = await temporaryDirectory('course-doctor-command-');
    const files = await writeProject(root);
    initializeGit(root);
    const courseManifest = manifest(
      [
        { id: 'section-start', files },
        { id: 'section-result', files: resultFiles },
      ],
      [adminRecipe],
    );
    const stdout: string[] = [];
    const stderr: string[] = [];

    const result = await runDoctor(
      {
        startDirectory: root,
        workingBoundary: root,
        manifest: courseManifest,
        cliVersion: '1.0.0',
        nodeVersion: '24.18.0',
        expectedNodeVersion: '24.18.0',
        platform: process.platform,
      },
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(result).toMatchObject({
      exitCode: 0,
      diagnosis: {
        kind: 'applicable',
        state: 'section-start',
        recipe: 'admin-ui',
      },
    });
    expect(stderr).toEqual([]);
    expect(stdout.join('\n')).toContain('Project: @madeup-video/storefront');
    expect(stdout.join('\n')).toContain('Course CLI: 1.0.0');
    expect(stdout.join('\n')).toContain('Detected state: section-start');
    expect(stdout.join('\n')).toContain('Next prepared step: admin-ui');
    expect(stdout.join('\n')).toContain('Worktree: clean');
  });

  it('rejects the wrong project identity structurally', async () => {
    const root = await temporaryDirectory('course-doctor-wrong-project-');
    await writeProject(root, '@madeup-video/not-storefront');
    const stdout: string[] = [];
    const stderr: string[] = [];

    const result = await runDoctor(
      {
        startDirectory: root,
        workingBoundary: root,
        manifest: manifest([{ id: 'state', files: standaloneFiles }]),
        cliVersion: '1.0.0',
        nodeVersion: '24.18.0',
        expectedNodeVersion: '24.18.0',
        platform: process.platform,
      },
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
    );

    expect(result).toMatchObject({
      exitCode: 1,
      diagnosis: { kind: 'wrong-project' },
    });
    expect(stdout).toEqual([]);
    expect(stderr.join('\n')).toContain('Expected @madeup-video/storefront');
  });

  it('returns non-zero for a dirty worktree even when the state is recognised', async () => {
    const root = await temporaryDirectory('course-doctor-dirty-');
    const files = await writeProject(root);
    initializeGit(root);
    await writeFile(join(root, '.env'), 'untracked local environment');

    const result = await runDoctor(
      {
        startDirectory: root,
        workingBoundary: root,
        manifest: manifest([{ id: 'state', files }]),
        cliVersion: '1.0.0',
        nodeVersion: '24.18.0',
        expectedNodeVersion: '24.18.0',
        platform: process.platform,
      },
      { stdout: () => undefined, stderr: () => undefined },
    );

    expect(result).toMatchObject({
      exitCode: 1,
      diagnosis: { kind: 'exact', state: 'state' },
      worktree: { kind: 'dirty' },
    });
  });

  it('returns non-zero for an incompatible Node version', async () => {
    const root = await temporaryDirectory('course-doctor-node-');
    const files = await writeProject(root);

    const result = await runDoctor(
      {
        startDirectory: root,
        workingBoundary: root,
        manifest: manifest([{ id: 'state', files }]),
        cliVersion: '1.0.0',
        nodeVersion: '22.0.0',
        expectedNodeVersion: '24.18.0',
        platform: process.platform,
      },
      { stdout: () => undefined, stderr: () => undefined },
    );

    expect(result).toMatchObject({
      exitCode: 1,
      environment: {
        compatible: false,
        actualNodeVersion: '22.0.0',
        expectedNodeVersion: '24.18.0',
      },
    });
  });

  it('wires doctor through the CLI entry point with injected course data', async () => {
    const root = await temporaryDirectory('course-doctor-cli-');
    const files = await writeProject(root);
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCli(
      ['doctor'],
      {
        stdout: (line) => stdout.push(line),
        stderr: (line) => stderr.push(line),
      },
      {
        doctor: {
          startDirectory: root,
          workingBoundary: root,
          manifest: manifest([{ id: 'state', files }]),
          cliVersion: '1.0.0',
          nodeVersion: '24.18.0',
          expectedNodeVersion: '24.18.0',
          platform: process.platform,
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join('\n')).toContain('Detected state: state');
  });

  it('loads the pinned manifest and runtime contract from the installed package', async () => {
    const packageRoot = await temporaryDirectory('course-doctor-package-');
    const projectRoot = await temporaryDirectory('course-doctor-installed-project-');
    const files = await writeProject(projectRoot);
    const courseManifest = manifest([{ id: 'installed-state', files }]);
    await mkdir(join(packageRoot, 'dist'), { recursive: true });
    await mkdir(join(packageRoot, 'recovery'), { recursive: true });
    await writeFile(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@madeup-video/course',
        version: '1.0.0',
        engines: { node: '24.18.0' },
      }),
    );
    await writeFile(
      join(packageRoot, 'recovery', 'course-v1.0.0.json'),
      JSON.stringify(courseManifest),
    );

    const result = await loadBundledDoctorOptions({
      moduleUrl: pathToFileURL(join(packageRoot, 'dist', 'cli.js')),
      startDirectory: projectRoot,
      nodeVersion: '24.18.0',
      platform: process.platform,
    });

    expect(result).toMatchObject({
      startDirectory: projectRoot,
      manifest: { courseVersion: '1.0.0' },
      cliVersion: '1.0.0',
      nodeVersion: '24.18.0',
      expectedNodeVersion: '24.18.0',
      platform: process.platform,
    });
  });
});
