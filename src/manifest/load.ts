import { readFile } from 'node:fs/promises';

import type {
  CourseManifest,
  ManifestIssue,
} from './types.js';
import { validateManifest } from './validate.js';

export type ManifestLoadError =
  | {
      kind: 'file-read';
      path: string;
      message: string;
      code?: string;
    }
  | {
      kind: 'json-syntax';
      path: string;
      message: string;
    }
  | {
      kind: 'manifest-validation';
      path: string;
      message: string;
      issues: ManifestIssue[];
    };

export type ManifestLoadResult =
  | {
      ok: true;
      manifest: CourseManifest;
    }
  | {
      ok: false;
      error: ManifestLoadError;
    };

function displayPath(source: string | URL): string {
  return source instanceof URL ? source.href : source;
}

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

export async function loadManifest(
  source: string | URL,
): Promise<ManifestLoadResult> {
  const path = displayPath(source);
  if (source instanceof URL && source.protocol !== 'file:') {
    return {
      ok: false,
      error: {
        kind: 'file-read',
        path,
        code: 'UNSUPPORTED_URL',
        message: 'Manifest URLs must use the file protocol',
      },
    };
  }

  let contents: string;
  try {
    contents = await readFile(source, 'utf8');
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: 'file-read',
        path,
        message: errorMessage(error),
        ...(errorCode(error) === undefined
          ? {}
          : { code: errorCode(error) }),
      },
    };
  }

  let input: unknown;
  try {
    input = JSON.parse(contents);
  } catch (error) {
    return {
      ok: false,
      error: {
        kind: 'json-syntax',
        path,
        message: errorMessage(error),
      },
    };
  }

  const validation = validateManifest(input);
  if (!validation.ok) {
    return {
      ok: false,
      error: {
        kind: 'manifest-validation',
        path,
        message: 'Manifest validation failed',
        issues: validation.issues,
      },
    };
  }

  return {
    ok: true,
    manifest: validation.manifest,
  };
}
