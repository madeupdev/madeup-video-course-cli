import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import type {
  CourseManifest,
  CourseTreeFile,
  LocalArtifactRule,
} from '../manifest/types.js';
import {
  containsAsciiControl,
  filesystemCollisionKey,
  findPortableFilenameIssue,
} from '../path/portable.js';
import { hashBytes } from '../project/hash.js';

export type CourseTreeMismatch =
  | {
      kind: 'missing';
      path: string;
    }
  | {
      kind: 'unexpected';
      path: string;
    }
  | {
      kind: 'modified';
      path: string;
    }
  | {
      kind: 'mode-mismatched';
      path: string;
      expectedMode: 0o644 | 0o755;
      actualMode: 0o644 | 0o755;
    };

export type CourseStateClassification =
  | {
      kind: 'exact';
      state: string;
      completedRecipe?: string;
      availableRecipes?: string[];
      mismatches: [];
    }
  | {
      kind: 'applicable';
      state: string;
      recipe: string;
      mismatches: [];
    }
  | {
      kind: 'unknown';
      nearestState: string;
      mismatches: CourseTreeMismatch[];
    }
  | {
      kind: 'ambiguous';
      states: string[];
      mismatchCount: number;
    };

export type CourseTreeInspectionFinding =
  | {
      kind: 'root-inaccessible';
      path: string;
      message: string;
      code?: string;
    }
  | {
      kind: 'directory-inaccessible' | 'file-inaccessible';
      path: string;
      message: string;
      code?: string;
    }
  | {
      kind: 'unsafe-path';
      path: string;
      reason: string;
    }
  | {
      kind: 'unsupported-entry';
      path: string;
      entryType: 'symbolic-link' | 'special';
    }
  | {
      kind: 'path-collision';
      paths: string[];
    }
  | {
      kind: 'entry-changed';
      path: string;
    };

export type CourseTreeInspectionResult =
  | {
      ok: true;
      files: CourseTreeFile[];
    }
  | {
      ok: false;
      finding: CourseTreeInspectionFinding;
    };

type Platform = NodeJS.Platform;

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function comparePath(left: string, right: string): number {
  return (
    compareText(filesystemCollisionKey(left), filesystemCollisionKey(right)) ||
    compareText(left, right)
  );
}

function errorDetails(error: unknown): { message: string; code?: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return { message, code: error.code };
  }
  return { message };
}

function unsafePathReason(path: string): string | undefined {
  if (path !== path.normalize('NFC')) {
    return 'not-nfc-normalized';
  }
  if (containsAsciiControl(path)) {
    return 'control-character';
  }
  if (path.includes('\\')) {
    return 'backslash-separator';
  }
  for (const segment of path.split('/')) {
    const issue = findPortableFilenameIssue(segment);
    if (issue !== undefined) {
      return issue.kind;
    }
  }
  return undefined;
}

function isWithinRoot(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);
  return (
    pathFromRoot === '' ||
    (!isAbsolute(pathFromRoot) &&
      pathFromRoot !== '..' &&
      !pathFromRoot.startsWith(`..${sep}`))
  );
}

function isSameEntry(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function artifactMatches(
  rule: LocalArtifactRule,
  path: string,
  entryType: 'file' | 'directory',
): boolean {
  const pathKey = filesystemCollisionKey(path);
  if (rule.type === 'file') {
    return entryType === 'file' && pathKey === filesystemCollisionKey(rule.path);
  }
  if (rule.type === 'directory') {
    const ruleKey = filesystemCollisionKey(rule.path);
    return (
      (entryType === 'directory' && pathKey === ruleKey) ||
      pathKey.startsWith(`${ruleKey}/`)
    );
  }

  const segments = pathKey.split('/');
  const basename = segments.pop() ?? '';
  if (rule.type === 'directory-name') {
    if (entryType === 'directory') {
      segments.push(basename);
    }
    const nameKey = filesystemCollisionKey(rule.name);
    return segments.some((segment) => segment === nameKey);
  }

  return (
    entryType === 'file' &&
    basename.endsWith(filesystemCollisionKey(rule.suffix))
  );
}

function isExcluded(
  rules: readonly LocalArtifactRule[],
  path: string,
  entryType: 'file' | 'directory',
): boolean {
  if (filesystemCollisionKey(path) === '.git') {
    return true;
  }
  return rules.some((rule) => artifactMatches(rule, path, entryType));
}

export async function inspectCourseTree(
  projectRoot: string,
  localArtifacts: readonly LocalArtifactRule[],
  options: { platform: Platform },
): Promise<CourseTreeInspectionResult> {
  let root: string;
  try {
    root = await realpath(projectRoot);
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory()) {
      return {
        ok: false,
        finding: {
          kind: 'root-inaccessible',
          path: projectRoot,
          message: 'Project root is not a directory',
          code: 'ENOTDIR',
        },
      };
    }
  } catch (error) {
    return {
      ok: false,
      finding: {
        kind: 'root-inaccessible',
        path: projectRoot,
        ...errorDetails(error),
      },
    };
  }

  const files: CourseTreeFile[] = [];
  const seenPaths = new Map<string, string>();

  async function validateDirectory(
    directory: string,
    path: string,
  ): Promise<
    | { ok: true; stat: Awaited<ReturnType<typeof lstat>> }
    | { ok: false; finding: CourseTreeInspectionFinding }
  > {
    let firstStat;
    try {
      firstStat = await lstat(directory);
    } catch (error) {
      return {
        ok: false,
        finding: {
          kind: 'directory-inaccessible',
          path,
          ...errorDetails(error),
        },
      };
    }
    if (firstStat.isSymbolicLink()) {
      return {
        ok: false,
        finding: {
          kind: 'unsupported-entry',
          path,
          entryType: 'symbolic-link',
        },
      };
    }
    if (!firstStat.isDirectory()) {
      return {
        ok: false,
        finding: { kind: 'entry-changed', path },
      };
    }

    let resolvedDirectory: string;
    try {
      resolvedDirectory = await realpath(directory);
    } catch (error) {
      return {
        ok: false,
        finding: {
          kind: 'directory-inaccessible',
          path,
          ...errorDetails(error),
        },
      };
    }
    if (!isWithinRoot(root, resolvedDirectory)) {
      return {
        ok: false,
        finding: {
          kind: 'unsafe-path',
          path,
          reason: 'resolved-outside-project',
        },
      };
    }

    let secondStat;
    try {
      secondStat = await lstat(directory);
    } catch {
      return { ok: false, finding: { kind: 'entry-changed', path } };
    }
    if (
      secondStat.isSymbolicLink() ||
      !secondStat.isDirectory() ||
      !isSameEntry(firstStat, secondStat)
    ) {
      return { ok: false, finding: { kind: 'entry-changed', path } };
    }
    return { ok: true, stat: secondStat };
  }

  async function readRegularFile(
    absolutePath: string,
    path: string,
  ): Promise<
    | { ok: true; bytes: Buffer; mode: 0o644 | 0o755 }
    | { ok: false; finding: CourseTreeInspectionFinding }
  > {
    let handle;
    try {
      handle = await open(
        absolutePath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
    } catch (error) {
      return {
        ok: false,
        finding: {
          kind: 'file-inaccessible',
          path,
          ...errorDetails(error),
        },
      };
    }

    try {
      const openedStat = await handle.stat();
      if (!openedStat.isFile()) {
        return {
          ok: false,
          finding: {
            kind: 'unsupported-entry',
            path,
            entryType: 'special',
          },
        };
      }

      let firstPathStat;
      try {
        firstPathStat = await lstat(absolutePath);
      } catch {
        return { ok: false, finding: { kind: 'entry-changed', path } };
      }
      if (
        firstPathStat.isSymbolicLink() ||
        !firstPathStat.isFile() ||
        !isSameEntry(openedStat, firstPathStat)
      ) {
        return { ok: false, finding: { kind: 'entry-changed', path } };
      }

      let resolvedPath: string;
      try {
        resolvedPath = await realpath(absolutePath);
      } catch {
        return { ok: false, finding: { kind: 'entry-changed', path } };
      }
      if (!isWithinRoot(root, resolvedPath)) {
        return {
          ok: false,
          finding: {
            kind: 'unsafe-path',
            path,
            reason: 'resolved-outside-project',
          },
        };
      }

      let secondPathStat;
      try {
        secondPathStat = await lstat(absolutePath);
      } catch {
        return { ok: false, finding: { kind: 'entry-changed', path } };
      }
      if (
        secondPathStat.isSymbolicLink() ||
        !secondPathStat.isFile() ||
        !isSameEntry(openedStat, secondPathStat)
      ) {
        return { ok: false, finding: { kind: 'entry-changed', path } };
      }

      return {
        ok: true,
        bytes: await handle.readFile(),
        mode:
          options.platform === 'win32' || (openedStat.mode & 0o111) === 0
            ? 0o644
            : 0o755,
      };
    } catch (error) {
      return {
        ok: false,
        finding: {
          kind: 'file-inaccessible',
          path,
          ...errorDetails(error),
        },
      };
    } finally {
      await handle.close();
    }
  }

  async function visit(directory: string, relativeDirectory: string): Promise<CourseTreeInspectionFinding | undefined> {
    const directoryPath = relativeDirectory || '.';
    const beforeDirectory = await validateDirectory(directory, directoryPath);
    if (!beforeDirectory.ok) {
      return beforeDirectory.finding;
    }
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      return {
        kind: 'directory-inaccessible',
        path: relativeDirectory || '.',
        ...errorDetails(error),
      };
    }

    const afterDirectory = await validateDirectory(directory, directoryPath);
    if (
      !afterDirectory.ok ||
      !isSameEntry(beforeDirectory.stat, afterDirectory.stat)
    ) {
      return afterDirectory.ok
        ? { kind: 'entry-changed', path: directoryPath }
        : afterDirectory.finding;
    }

    entries.sort((left, right) => comparePath(left.name, right.name));
    for (const entry of entries) {
      const path = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const unsafeReason = unsafePathReason(path);
      if (unsafeReason !== undefined) {
        return {
          kind: 'unsafe-path',
          path,
          reason: unsafeReason,
        };
      }

      const absolutePath = join(directory, entry.name);
      let entryStat;
      try {
        entryStat = await lstat(absolutePath);
      } catch (error) {
        return {
          kind: 'file-inaccessible',
          path,
          ...errorDetails(error),
        };
      }

      if (entryStat.isSymbolicLink()) {
        return {
          kind: 'unsupported-entry',
          path,
          entryType: 'symbolic-link',
        };
      }
      if (entryStat.isDirectory()) {
        if (isExcluded(localArtifacts, path, 'directory')) {
          continue;
        }
        const finding = await visit(absolutePath, path);
        if (finding !== undefined) {
          return finding;
        }
        continue;
      }
      if (!entryStat.isFile()) {
        return {
          kind: 'unsupported-entry',
          path,
          entryType: 'special',
        };
      }
      if (isExcluded(localArtifacts, path, 'file')) {
        continue;
      }

      const key = filesystemCollisionKey(path);
      const collidingPath = seenPaths.get(key);
      if (collidingPath !== undefined) {
        return {
          kind: 'path-collision',
          paths: [collidingPath, path].sort(compareText),
        };
      }
      seenPaths.set(key, path);

      const inspectedFile = await readRegularFile(absolutePath, path);
      if (!inspectedFile.ok) {
        return inspectedFile.finding;
      }
      files.push({
        path,
        mode: inspectedFile.mode,
        sha256: hashBytes(inspectedFile.bytes),
      });
    }

    return undefined;
  }

  const finding = await visit(root, '');
  if (finding !== undefined) {
    return { ok: false, finding };
  }

  files.sort((left, right) => comparePath(left.path, right.path));
  return { ok: true, files };
}

function mismatchesForState(
  expectedFiles: readonly CourseTreeFile[],
  actualFiles: readonly CourseTreeFile[],
  platform: Platform,
): CourseTreeMismatch[] {
  const expectedByPath = new Map(
    expectedFiles.map((file) => [file.path, file]),
  );
  const actualByPath = new Map(
    actualFiles.map((file) => [file.path, file]),
  );
  const mismatches: CourseTreeMismatch[] = [];

  for (const expected of expectedFiles) {
    const actual = actualByPath.get(expected.path);
    if (actual === undefined) {
      mismatches.push({ kind: 'missing', path: expected.path });
    } else if (actual.sha256 !== expected.sha256) {
      mismatches.push({ kind: 'modified', path: expected.path });
    } else if (platform !== 'win32' && actual.mode !== expected.mode) {
      mismatches.push({
        kind: 'mode-mismatched',
        path: expected.path,
        expectedMode: expected.mode,
        actualMode: actual.mode,
      });
    }
  }

  for (const actual of actualFiles) {
    if (!expectedByPath.has(actual.path)) {
      mismatches.push({ kind: 'unexpected', path: actual.path });
    }
  }

  const kindOrder = new Map([
    ['missing', 0],
    ['modified', 1],
    ['mode-mismatched', 2],
    ['unexpected', 3],
  ]);
  mismatches.sort(
    (left, right) =>
      comparePath(left.path, right.path) ||
      (kindOrder.get(left.kind) ?? 0) - (kindOrder.get(right.kind) ?? 0),
  );
  return mismatches;
}

export function classifyCourseState(
  manifest: CourseManifest,
  actualFiles: readonly CourseTreeFile[],
  options: { platform: Platform },
): CourseStateClassification {
  const comparisons = manifest.recoveryStates.map((state) => ({
    state: state.id,
    mismatches: mismatchesForState(
      state.tree.files,
      actualFiles,
      options.platform,
    ),
  }));
  const smallestCount = Math.min(
    ...comparisons.map(({ mismatches }) => mismatches.length),
  );
  const nearest = comparisons.filter(
    ({ mismatches }) => mismatches.length === smallestCount,
  );

  if (nearest.length !== 1) {
    return {
      kind: 'ambiguous',
      states: nearest.map(({ state }) => state).sort(compareText),
      mismatchCount: smallestCount,
    };
  }

  const { state, mismatches } = nearest[0]!;
  if (mismatches.length > 0) {
    return {
      kind: 'unknown',
      nearestState: state,
      mismatches,
    };
  }

  const applicableRecipes = manifest.recipes
    .filter((recipe) => recipe.startingState === state)
    .map(({ id }) => id)
    .sort(compareText);
  if (applicableRecipes.length === 1) {
    return {
      kind: 'applicable',
      state,
      recipe: applicableRecipes[0]!,
      mismatches: [],
    };
  }

  const completedRecipes = manifest.recipes
    .filter((recipe) => recipe.resultState === state)
    .map(({ id }) => id)
    .sort(compareText);
  return {
    kind: 'exact',
    state,
    ...(completedRecipes.length === 1
      ? { completedRecipe: completedRecipes[0] }
      : {}),
    ...(applicableRecipes.length > 1
      ? { availableRecipes: applicableRecipes }
      : {}),
    mismatches: [],
  };
}
