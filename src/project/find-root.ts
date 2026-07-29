import {
  lstat,
  readFile,
  realpath,
  stat,
} from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  sep,
} from 'node:path';

export const EXPECTED_PROJECT_PACKAGE_NAME =
  '@madeup-video/storefront' as const;

type InaccessiblePathRole = 'boundary' | 'start' | 'manifest';

export type ProjectRootFinding =
  | {
      kind: 'path-inaccessible';
      role: InaccessiblePathRole;
      path: string;
      message: string;
      code?: string;
    }
  | {
      kind: 'start-outside-boundary';
      start: string;
      boundary: string;
    }
  | {
      kind: 'package-manifest-not-found';
      start: string;
      boundary: string;
    }
  | {
      kind: 'unsafe-package-manifest';
      candidateRoot: string;
      packageJsonPath: string;
      reason: 'symlink';
    }
  | {
      kind: 'malformed-package-json';
      candidateRoot: string;
      packageJsonPath: string;
      message: string;
    }
  | {
      kind: 'invalid-package-object';
      candidateRoot: string;
      packageJsonPath: string;
      message: string;
    }
  | {
      kind: 'wrong-package-name';
      candidateRoot: string;
      packageJsonPath: string;
      expectedPackageName: typeof EXPECTED_PROJECT_PACKAGE_NAME;
      actualPackageName: string;
    };

export type ProjectRootResult =
  | {
      ok: true;
      root: string;
      packageJsonPath: string;
      packageName: typeof EXPECTED_PROJECT_PACKAGE_NAME;
    }
  | {
      ok: false;
      finding: ProjectRootFinding;
    };

type ProjectRootFailure = Extract<ProjectRootResult, { ok: false }>;

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

function inaccessiblePath(
  role: InaccessiblePathRole,
  path: string,
  error: unknown,
): ProjectRootFailure {
  const code = errorCode(error);
  return {
    ok: false,
    finding: {
      kind: 'path-inaccessible',
      role,
      path,
      message: errorMessage(error),
      ...(code === undefined ? {} : { code }),
    },
  };
}

function isWithinPath(boundary: string, target: string): boolean {
  const pathFromBoundary = relative(boundary, target);
  return (
    pathFromBoundary === '' ||
    (!isAbsolute(pathFromBoundary) &&
      pathFromBoundary !== '..' &&
      !pathFromBoundary.startsWith(`..${sep}`))
  );
}

async function canonicalDirectory(
  path: string,
  role: 'boundary' | 'start',
): Promise<
  | {
      ok: true;
      path: string;
    }
  | ProjectRootFailure
> {
  let canonicalPath: string;
  try {
    canonicalPath = await realpath(path);
    const pathStat = await stat(canonicalPath);
    if (!pathStat.isDirectory()) {
      return inaccessiblePath(
        role,
        path,
        Object.assign(new Error('Path is not a directory'), {
          code: 'ENOTDIR',
        }),
      );
    }
  } catch (error) {
    return inaccessiblePath(role, path, error);
  }

  return {
    ok: true,
    path: canonicalPath,
  };
}

export async function findProjectRoot(
  startDirectory: string,
  workingBoundary: string,
): Promise<ProjectRootResult> {
  const boundaryResult = await canonicalDirectory(
    workingBoundary,
    'boundary',
  );
  if (!boundaryResult.ok) {
    return boundaryResult;
  }

  const startResult = await canonicalDirectory(startDirectory, 'start');
  if (!startResult.ok) {
    return startResult;
  }

  const boundary = boundaryResult.path;
  const start = startResult.path;
  if (!isWithinPath(boundary, start)) {
    return {
      ok: false,
      finding: {
        kind: 'start-outside-boundary',
        start,
        boundary,
      },
    };
  }

  let candidateRoot = start;
  while (isWithinPath(boundary, candidateRoot)) {
    const packageJsonPath = join(candidateRoot, 'package.json');
    let packageStat;
    try {
      packageStat = await lstat(packageJsonPath);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        return inaccessiblePath('manifest', packageJsonPath, error);
      }

      if (candidateRoot === boundary) {
        break;
      }
      candidateRoot = dirname(candidateRoot);
      continue;
    }

    if (packageStat.isSymbolicLink()) {
      return {
        ok: false,
        finding: {
          kind: 'unsafe-package-manifest',
          candidateRoot,
          packageJsonPath,
          reason: 'symlink',
        },
      };
    }
    if (!packageStat.isFile()) {
      return inaccessiblePath(
        'manifest',
        packageJsonPath,
        Object.assign(new Error('Package manifest is not a regular file'), {
          code: 'EINVAL',
        }),
      );
    }

    let contents: string;
    try {
      contents = await readFile(packageJsonPath, 'utf8');
    } catch (error) {
      return inaccessiblePath('manifest', packageJsonPath, error);
    }

    let packageValue: unknown;
    try {
      packageValue = JSON.parse(contents);
    } catch (error) {
      return {
        ok: false,
        finding: {
          kind: 'malformed-package-json',
          candidateRoot,
          packageJsonPath,
          message: errorMessage(error),
        },
      };
    }

    if (
      typeof packageValue !== 'object' ||
      packageValue === null ||
      Array.isArray(packageValue) ||
      !('name' in packageValue) ||
      typeof packageValue.name !== 'string'
    ) {
      return {
        ok: false,
        finding: {
          kind: 'invalid-package-object',
          candidateRoot,
          packageJsonPath,
          message: 'Package manifest must be an object with a string name',
        },
      };
    }

    if (packageValue.name !== EXPECTED_PROJECT_PACKAGE_NAME) {
      return {
        ok: false,
        finding: {
          kind: 'wrong-package-name',
          candidateRoot,
          packageJsonPath,
          expectedPackageName: EXPECTED_PROJECT_PACKAGE_NAME,
          actualPackageName: packageValue.name,
        },
      };
    }

    return {
      ok: true,
      root: candidateRoot,
      packageJsonPath,
      packageName: EXPECTED_PROJECT_PACKAGE_NAME,
    };
  }

  return {
    ok: false,
    finding: {
      kind: 'package-manifest-not-found',
      start,
      boundary,
    },
  };
}
