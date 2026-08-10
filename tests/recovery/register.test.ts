import { describe, expect, it } from 'vitest';

import {
  validateRecoveryRegister,
  type RecoveryRegisterValidationResult,
} from '../../src/recovery/register.js';

const CLI_REPOSITORY =
  'https://github.com/madeupdev/madeup-video-course-cli';
const PROJECT_REPOSITORY =
  'https://github.com/madeupdev/advanced-monorepos-project';

type MutableRegister = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function validRegister(): MutableRegister {
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
        { type: 'directory', path: 'generated/prisma' },
        { type: 'directory-name', name: 'node_modules' },
        { type: 'file-suffix', suffix: '.tsbuildinfo' },
      ],
    },
    release: {
      repository: PROJECT_REPOSITORY,
      tag: 'course-v1.0.0',
      maxAssetBytes: 1024 * 1024,
    },
    states: [
      {
        id: 'S01-L01-start',
        sourceCommit: 'a'.repeat(40),
        asset: 'S01-L01-start.tar.gz',
        sha256: 'PENDING',
        status: 'draft',
        verification: ['pnpm test'],
      },
      {
        id: 'S01-L02-start',
        sourceCommit: 'b'.repeat(40),
        asset: 'S01-L02-start.tar.gz',
        sha256: 'c'.repeat(64),
        status: 'published',
        verification: ['pnpm lint'],
      },
    ],
    recipes: [
      {
        id: 'prepared-ui',
        description: 'Prepared UI fixture',
        expectedPackageName: '@madeup-video/storefront',
        startingState: 'S01-L01-start',
        resultState: 'S01-L02-start',
        operations: [
          {
            type: 'delete',
            destination: 'old.txt',
            beforeSha256: 'd'.repeat(64),
          },
        ],
        verification: ['pnpm test'],
      },
    ],
    authoringNotes: 'Private draft metadata',
  };
}

const identity = {
  packageName: '@madeup-video/course',
  repository: CLI_REPOSITORY,
};

function validate(register: unknown): RecoveryRegisterValidationResult {
  return validateRecoveryRegister(register, identity);
}

function issuePaths(result: RecoveryRegisterValidationResult): string[] {
  expect(result.ok).toBe(false);
  return result.ok ? [] : result.issues.map((issue) => issue.path);
}

describe('recovery register ingestion', () => {
  it('accepts draft states with PENDING digests as archive build inputs', () => {
    const result = validate(validRegister());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.register.states[0]?.sha256).toBe('PENDING');
    }
  });

  it('aggregates and deterministically sorts useful JSON-path diagnostics', () => {
    const register = validRegister();
    register.courseVersion = 'latest';
    register.cliVersion = '^1';
    register.release.tag = 'mutable';
    register.states[0].sourceCommit = 'short';

    const result = validate(register);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThanOrEqual(4);
      expect(result.issues).toEqual(
        [...result.issues].sort((left, right) =>
          left.path.localeCompare(right.path) ||
          left.message.localeCompare(right.message),
        ),
      );
      expect(
        new Set(
          result.issues.map(({ path, message }) => `${path}\0${message}`),
        ).size,
      ).toBe(result.issues.length);
    }
  });

  it.each([
    ['unknown root field', (value: MutableRegister) => (value.secret = true), '$.secret'],
    ['missing states', (value: MutableRegister) => delete value.states, '$.states'],
    ['unsupported schema', (value: MutableRegister) => (value.schemaVersion = 2), '$.schemaVersion'],
    ['unpinned course version', (value: MutableRegister) => (value.courseVersion = '^1.0.0'), '$.courseVersion'],
    ['unpinned CLI version', (value: MutableRegister) => (value.cliVersion = 'latest'), '$.cliVersion'],
    ['misaligned CLI version', (value: MutableRegister) => (value.cliVersion = '1.0.1'), '$.cliVersion'],
    ['misaligned tag', (value: MutableRegister) => (value.release.tag = 'v1.0.0'), '$.release.tag'],
    ['missing asset limit', (value: MutableRegister) => delete value.release.maxAssetBytes, '$.release.maxAssetBytes'],
    ['fractional asset limit', (value: MutableRegister) => (value.release.maxAssetBytes = 1.5), '$.release.maxAssetBytes'],
    ['non-positive asset limit', (value: MutableRegister) => (value.release.maxAssetBytes = 0), '$.release.maxAssetBytes'],
    ['unsafe asset limit', (value: MutableRegister) => (value.release.maxAssetBytes = Number.MAX_SAFE_INTEGER + 1), '$.release.maxAssetBytes'],
    ['wrong CLI package', (value: MutableRegister) => (value.cli.packageName = '@evil/course'), '$.cli.packageName'],
    ['wrong CLI repository', (value: MutableRegister) => (value.cli.repository = 'https://github.com/evil/course'), '$.cli.repository'],
    ['noncanonical project repository', (value: MutableRegister) => {
      value.project.repository = `${PROJECT_REPOSITORY}.git`;
      value.release.repository = `${PROJECT_REPOSITORY}.git`;
    }, '$.project.repository'],
    ['release/project mismatch', (value: MutableRegister) => (value.release.repository = 'https://github.com/other/project'), '$.release.repository'],
    ['invalid recipe start', (value: MutableRegister) => (value.recipes[0].startingState = 'missing-state'), '$.recipes[0].startingState'],
    ['invalid recipe result', (value: MutableRegister) => (value.recipes[0].resultState = 'missing-state'), '$.recipes[0].resultState'],
    ['published pending digest', (value: MutableRegister) => (value.states[1].sha256 = 'PENDING'), '$.states[1].sha256'],
  ])('rejects %s', (_label, mutate, expectedPath) => {
    const register = validRegister();
    mutate(register);

    expect(issuePaths(validate(register))).toContain(expectedPath);
  });

  it.each([
    ['separator', 'S01/L01'],
    ['backslash', String.raw`S01\L01`],
    ['dot segment', '..'],
    ['control character', 'S01\u0000L01'],
    ['portable filename punctuation', 'S01:L01'],
    ['reserved portable filename', 'CON'],
    ['leading hyphen', '-S01'],
  ])('rejects a recovery ID containing a %s', (_label, id) => {
    const register = validRegister();
    register.states[0].id = id;
    register.states[0].asset = `${id}.tar.gz`;

    expect(issuePaths(validate(register))).toContain('$.states[0].id');
  });

  it.each([
    ['traversal', '../S01-L01-start.tar.gz'],
    ['absolute POSIX path', '/tmp/S01-L01-start.tar.gz'],
    ['absolute Windows path', 'C:\\tmp\\S01-L01-start.tar.gz'],
    ['nested path', 'assets/S01-L01-start.tar.gz'],
    ['wrong basename', 'other.tar.gz'],
  ])('rejects an asset with %s', (_label, asset) => {
    const register = validRegister();
    register.states[0].asset = asset;

    expect(issuePaths(validate(register))).toContain('$.states[0].asset');
  });

  it('rejects duplicate and portable case-colliding IDs and assets', () => {
    const register = validRegister();
    register.states[1].id = register.states[0].id.toLowerCase();
    register.states[1].asset = register.states[0].asset.toLowerCase();

    const paths = issuePaths(validate(register));
    expect(paths).toContain('$.states[1].id');
    expect(paths).toContain('$.states[1].asset');
  });

  it('rejects malformed source commits', () => {
    const register = validRegister();
    register.states[0].sourceCommit = 'ABC123';

    expect(issuePaths(validate(register))).toContain(
      '$.states[0].sourceCommit',
    );
  });

  it('returns a malformed JSON diagnostic without exposing parser internals', () => {
    const result = validateRecoveryRegister('{"states":', identity);

    expect(result).toEqual({
      ok: false,
      issues: [{ path: '$', message: 'Malformed JSON' }],
    });
  });
});
