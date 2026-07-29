import {
  lstat,
  readFile,
  realpath,
  stat,
} from 'node:fs/promises';
import {
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

import {
  findPortableFilenameIssue,
} from '../path/portable.js';
import type {
  PortableFilenameIssueKind,
} from '../path/portable.js';
import { hashBytes } from './hash.js';

export type UnsafeRepositoryPathReason =
  | 'empty-path'
  | 'absolute-posix-path'
  | 'windows-drive-path'
  | 'leading-backslash-path'
  | 'backslash-separator'
  | 'empty-segment'
  | 'current-directory-segment'
  | 'parent-directory-segment'
  | 'resolved-outside-project'
  | PortableFilenameIssueKind;

export type ProjectPathFinding =
  | {
      kind: 'unsafe-repository-path';
      relativePath: string;
      reason: UnsafeRepositoryPathReason;
    }
  | {
      kind: 'project-root-inaccessible';
      projectRoot: string;
      message: string;
      code?: string;
    }
  | {
      kind: 'symlink-component';
      relativePath: string;
      component: string;
      path: string;
    }
  | {
      kind: 'path-inaccessible';
      relativePath: string;
      path: string;
      message: string;
      code?: string;
    };

export type ResolvedProjectPath = {
  ok: true;
  projectRoot: string;
  relativePath: string;
  path: string;
};

export type ProjectPathResult =
  | ResolvedProjectPath
  | {
      ok: false;
      finding: ProjectPathFinding;
    };

export type ProjectFileFinding =
  | ProjectPathFinding
  | {
      kind: 'missing-file';
      relativePath: string;
      path: string;
    }
  | {
      kind: 'not-a-file';
      relativePath: string;
      path: string;
    }
  | {
      kind: 'file-inaccessible';
      relativePath: string;
      path: string;
      message: string;
      code?: string;
    };

export type ProjectFileInspectionResult =
  | {
      ok: true;
      file: {
        relativePath: string;
        path: string;
        size: number;
        mode: number;
        sha256: string;
      };
    }
  | {
      ok: false;
      finding: ProjectFileFinding;
    };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }

  return undefined;
}

function withErrorDetails<T extends object>(
  finding: T,
  error: unknown,
): T & {
  message: string;
  code?: string;
} {
  const code = errorCode(error);
  return {
    ...finding,
    message: errorMessage(error),
    ...(code === undefined ? {} : { code }),
  };
}

function repositoryPathIssue(
  relativePath: string,
): UnsafeRepositoryPathReason | undefined {
  if (relativePath.length === 0) {
    return 'empty-path';
  }
  if (relativePath.startsWith('/')) {
    return 'absolute-posix-path';
  }
  if (/^[A-Za-z]:/.test(relativePath)) {
    return 'windows-drive-path';
  }
  if (relativePath.startsWith('\\')) {
    return 'leading-backslash-path';
  }
  if (relativePath.includes('\\')) {
    return 'backslash-separator';
  }
  const segments = relativePath.split('/');
  if (segments.some((segment) => segment.length === 0)) {
    return 'empty-segment';
  }
  if (segments.some((segment) => segment === '.')) {
    return 'current-directory-segment';
  }
  if (segments.some((segment) => segment === '..')) {
    return 'parent-directory-segment';
  }

  return segments
    .map((segment) => findPortableFilenameIssue(segment)?.kind)
    .find((issue) => issue !== undefined);
}

function isWithinPath(projectRoot: string, target: string): boolean {
  const pathFromRoot = relative(projectRoot, target);
  return (
    pathFromRoot === '' ||
    (!isAbsolute(pathFromRoot) &&
      pathFromRoot !== '..' &&
      !pathFromRoot.startsWith(`..${sep}`))
  );
}

export async function resolveProjectPath(
  projectRoot: string,
  relativePath: string,
): Promise<ProjectPathResult> {
  const unsafeReason = repositoryPathIssue(relativePath);
  if (unsafeReason !== undefined) {
    return {
      ok: false,
      finding: {
        kind: 'unsafe-repository-path',
        relativePath,
        reason: unsafeReason,
      },
    };
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(projectRoot);
    const rootStat = await stat(canonicalRoot);
    if (!rootStat.isDirectory()) {
      return {
        ok: false,
        finding: {
          kind: 'project-root-inaccessible',
          projectRoot,
          message: 'Project root is not a directory',
          code: 'ENOTDIR',
        },
      };
    }
  } catch (error) {
    return {
      ok: false,
      finding: withErrorDetails(
        {
          kind: 'project-root-inaccessible',
          projectRoot,
        } as const,
        error,
      ),
    };
  }

  const segments = relativePath.split('/');
  const resolvedPath = resolve(canonicalRoot, ...segments);
  if (!isWithinPath(canonicalRoot, resolvedPath)) {
    return {
      ok: false,
      finding: {
        kind: 'unsafe-repository-path',
        relativePath,
        reason: 'resolved-outside-project',
      },
    };
  }

  let inspectedPath = canonicalRoot;
  const inspectedSegments: string[] = [];
  for (const segment of segments) {
    inspectedSegments.push(segment);
    inspectedPath = join(inspectedPath, segment);

    try {
      const componentStat = await lstat(inspectedPath);
      if (componentStat.isSymbolicLink()) {
        return {
          ok: false,
          finding: {
            kind: 'symlink-component',
            relativePath,
            component: inspectedSegments.join('/'),
            path: inspectedPath,
          },
        };
      }
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        break;
      }
      return {
        ok: false,
        finding: withErrorDetails(
          {
            kind: 'path-inaccessible',
            relativePath,
            path: inspectedPath,
          } as const,
          error,
        ),
      };
    }
  }

  return {
    ok: true,
    projectRoot: canonicalRoot,
    relativePath,
    path: resolvedPath,
  };
}

export async function inspectProjectFile(
  projectRoot: string,
  relativePath: string,
): Promise<ProjectFileInspectionResult> {
  const resolved = await resolveProjectPath(projectRoot, relativePath);
  if (!resolved.ok) {
    return resolved;
  }

  let fileStat;
  try {
    fileStat = await lstat(resolved.path);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      return {
        ok: false,
        finding: {
          kind: 'missing-file',
          relativePath,
          path: resolved.path,
        },
      };
    }
    return {
      ok: false,
      finding: withErrorDetails(
        {
          kind: 'file-inaccessible',
          relativePath,
          path: resolved.path,
        } as const,
        error,
      ),
    };
  }

  if (fileStat.isSymbolicLink()) {
    return {
      ok: false,
      finding: {
        kind: 'symlink-component',
        relativePath,
        component: relativePath,
        path: resolved.path,
      },
    };
  }
  if (!fileStat.isFile()) {
    return {
      ok: false,
      finding: {
        kind: 'not-a-file',
        relativePath,
        path: resolved.path,
      },
    };
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(resolved.path);
  } catch (error) {
    return {
      ok: false,
      finding: withErrorDetails(
        {
          kind: 'file-inaccessible',
          relativePath,
          path: resolved.path,
        } as const,
        error,
      ),
    };
  }

  return {
    ok: true,
    file: {
      relativePath,
      path: resolved.path,
      size: bytes.byteLength,
      mode: fileStat.mode & 0o777,
      sha256: hashBytes(bytes),
    },
  };
}
