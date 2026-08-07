import { realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';

export type GitChangeKind =
  | 'added'
  | 'copied'
  | 'deleted'
  | 'modified'
  | 'renamed'
  | 'type-changed'
  | 'unmerged'
  | 'untracked';

export type GitChange = {
  path: string;
  index: GitChangeKind | null;
  worktree: GitChangeKind | null;
  originalPath?: string;
};

export type GitInspectionFinding =
  | {
      kind: 'not-git-repository';
      directory: string;
      message: string;
    }
  | {
      kind: 'git-unavailable';
      directory: string;
      message: string;
      code?: string;
    }
  | {
      kind: 'git-inspection-failed';
      directory: string;
      message: string;
      exitCode: number | null;
      stderr: string;
    }
  | {
      kind: 'invalid-git-status';
      directory: string;
      message: string;
    };

export type GitInspectionResult =
  | {
      ok: true;
      repositoryRoot: string;
      clean: boolean;
      changes: GitChange[];
    }
  | {
      ok: false;
      finding: GitInspectionFinding;
    };

type GitCommandResult =
  | {
      ok: true;
      stdout: string;
      stderr: string;
    }
  | {
      ok: false;
      stdout: string;
      stderr: string;
      exitCode: number | null;
      error?: Error & {
        code?: string;
      };
    };

const unsafeGitEnvironmentVariables = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_SYSTEM',
  'GIT_DIR',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_GRAFT_FILE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_NAMESPACE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_QUARANTINE_PATH',
  'GIT_REPLACE_REF_BASE',
  'GIT_SHALLOW_FILE',
  'GIT_WORK_TREE',
]);
const inlineGitConfigVariablePattern =
  /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/;

function sanitizedGitEnvironment(): NodeJS.ProcessEnv {
  const environment = {
    ...process.env,
  };
  for (const name of Object.keys(environment)) {
    const normalizedName = name.toUpperCase();
    if (
      unsafeGitEnvironmentVariables.has(normalizedName) ||
      inlineGitConfigVariablePattern.test(normalizedName)
    ) {
      delete environment[name];
    }
  }

  environment.LANG = 'C';
  environment.LC_ALL = 'C';
  environment.GIT_OPTIONAL_LOCKS = '0';
  return environment;
}

function runGit(args: readonly string[]): Promise<GitCommandResult> {
  return new Promise((resolveResult) => {
    const child = spawn('git', args, {
      env: sanitizedGitEnvironment(),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let spawnError:
      | (Error & {
          code?: string;
        })
      | undefined;

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('close', (exitCode) => {
      const output = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (exitCode === 0 && spawnError === undefined) {
        resolveResult({
          ok: true,
          ...output,
        });
        return;
      }

      resolveResult({
        ok: false,
        ...output,
        exitCode,
        ...(spawnError === undefined ? {} : { error: spawnError }),
      });
    });
  });
}

function statusKind(status: string): GitChangeKind | null {
  switch (status) {
    case ' ':
      return null;
    case 'A':
      return 'added';
    case 'C':
      return 'copied';
    case 'D':
      return 'deleted';
    case 'M':
      return 'modified';
    case 'R':
      return 'renamed';
    case 'T':
      return 'type-changed';
    case 'U':
      return 'unmerged';
    default:
      throw new Error(`Unsupported Git status code: ${JSON.stringify(status)}`);
  }
}

function parsePorcelainV1(output: string): GitChange[] {
  const records = output.split('\0');
  if (records.at(-1) === '') {
    records.pop();
  }

  const changes: GitChange[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (
      record === undefined ||
      record.length < 4 ||
      record[2] !== ' '
    ) {
      throw new Error('Git returned an invalid porcelain status record');
    }

    const indexCode = record[0];
    const worktreeCode = record[1];
    const path = record.slice(3);
    if (indexCode === '?' && worktreeCode === '?') {
      changes.push({
        path,
        index: null,
        worktree: 'untracked',
      });
      continue;
    }

    const indexKind = statusKind(indexCode ?? '');
    const worktreeKind = statusKind(worktreeCode ?? '');
    const change: GitChange = {
      path,
      index: indexKind,
      worktree: worktreeKind,
    };
    if (indexKind === 'renamed' || indexKind === 'copied') {
      const originalPath = records[index + 1];
      if (originalPath === undefined) {
        throw new Error('Git omitted the original path for a rename or copy');
      }
      change.originalPath = originalPath;
      index += 1;
    }
    changes.push(change);
  }

  return changes;
}

function commandFailure(
  directory: string,
  result: Exclude<GitCommandResult, { ok: true }>,
): GitInspectionResult {
  if (result.error?.code === 'ENOENT') {
    return {
      ok: false,
      finding: {
        kind: 'git-unavailable',
        directory,
        message: result.error.message,
        code: result.error.code,
      },
    };
  }
  if (result.stderr.includes('not a git repository')) {
    return {
      ok: false,
      finding: {
        kind: 'not-git-repository',
        directory,
        message: result.stderr.trim(),
      },
    };
  }

  return {
    ok: false,
    finding: {
      kind: 'git-inspection-failed',
      directory,
      message: 'Git inspection failed',
      exitCode: result.exitCode,
      stderr: result.stderr,
    },
  };
}

export async function inspectGitRepository(
  directory: string,
): Promise<GitInspectionResult> {
  const rootResult = await runGit([
    '-C',
    directory,
    'rev-parse',
    '--show-toplevel',
  ]);
  if (!rootResult.ok) {
    return commandFailure(directory, rootResult);
  }

  const reportedRoot = rootResult.stdout.trim();
  let repositoryRoot: string;
  try {
    repositoryRoot = await realpath(reportedRoot);
  } catch {
    repositoryRoot = reportedRoot;
  }

  const statusResult = await runGit([
    '-C',
    repositoryRoot,
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--ignore-submodules=none',
  ]);
  if (!statusResult.ok) {
    return commandFailure(directory, statusResult);
  }

  let changes: GitChange[];
  try {
    changes = parsePorcelainV1(statusResult.stdout);
  } catch (error) {
    return {
      ok: false,
      finding: {
        kind: 'invalid-git-status',
        directory,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  return {
    ok: true,
    repositoryRoot,
    clean: changes.length === 0,
    changes,
  };
}
