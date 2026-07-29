import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type {
  CourseManifest,
  ManifestIssue,
} from '../../src/manifest/types.js';
import { validateManifest } from '../../src/manifest/validate.js';

const fixtureUrl = new URL('../fixtures/manifests/valid.json', import.meta.url);
const validFixture = JSON.parse(
  readFileSync(fixtureUrl, 'utf8'),
) as CourseManifest;

function freshManifest(): CourseManifest {
  return structuredClone(validFixture);
}

function invalidIssues(input: unknown): ManifestIssue[] {
  const result = validateManifest(input);

  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error('Expected manifest validation to fail');
  }

  return result.issues;
}

function issuePaths(input: unknown): string[] {
  return invalidIssues(input).map((issue) => issue.path);
}

function withoutProperty<T extends object>(
  value: T,
  property: string,
): unknown {
  const copy = Object.fromEntries(Object.entries(value));
  delete copy[property];
  return copy;
}

describe('validateManifest', () => {
  it('accepts the complete fixture and returns a typed manifest', () => {
    const result = validateManifest(validFixture);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('Expected manifest validation to succeed');
    }

    const manifest: CourseManifest = result.manifest;
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.recipes[0]?.operations.map(({ type }) => type)).toEqual([
      'add',
      'replace',
      'delete',
    ]);
  });

  it('rejects an unknown schema version', () => {
    const input = { ...freshManifest(), schemaVersion: 2 };

    expect(issuePaths(input)).toContain('$.schemaVersion');
  });

  it.each([
    ['malformed', 'not-a-version'],
    ['incomplete', '1.0'],
    ['range', '^1.0.0'],
    ['wildcard', '1.x'],
    ['tag', 'latest'],
    ['leading-zero', '01.0.0'],
  ])('rejects a %s course version', (_label, courseVersion) => {
    const input = { ...freshManifest(), courseVersion };

    expect(issuePaths(input)).toContain('$.courseVersion');
  });

  it('rejects a release tag that does not match the course version', () => {
    const input = freshManifest();
    input.release.tag = 'course-v2.0.0';

    expect(issuePaths(input)).toContain('$.release.tag');
  });

  it.each([
    ['top level', (input: CourseManifest) => input],
    ['project', (input: CourseManifest) => input.project],
    ['release', (input: CourseManifest) => input.release],
    ['recovery state', (input: CourseManifest) => input.recoveryStates[0]!],
    ['recipe', (input: CourseManifest) => input.recipes[0]!],
    [
      'operation',
      (input: CourseManifest) => input.recipes[0]!.operations[0]!,
    ],
  ])('rejects unknown fields at the %s', (label, selectObject) => {
    const input = freshManifest();
    Object.assign(selectObject(input), { unexpectedField: true });

    if (label === 'top level') {
      expect(issuePaths(input)).toContain('$.unexpectedField');
    } else {
      expect(issuePaths(input)).toEqual([
        expect.stringContaining('.unexpectedField'),
      ]);
    }
  });

  it('rejects duplicate recipe IDs', () => {
    const input = freshManifest();
    input.recipes.push(structuredClone(input.recipes[0]!));

    expect(issuePaths(input)).toContain('$.recipes[1].id');
  });

  it('rejects duplicate recovery-state IDs and assets', () => {
    const input = freshManifest();
    input.recoveryStates[1]!.id = input.recoveryStates[0]!.id;
    input.recoveryStates[1]!.asset = input.recoveryStates[0]!.asset;

    expect(issuePaths(input)).toEqual(
      expect.arrayContaining([
        '$.recoveryStates[1].asset',
        '$.recoveryStates[1].id',
      ]),
    );
  });

  it.each([
    ['absolute POSIX path', '/etc/passwd'],
    ['Windows drive path', 'C:/course/file.ts'],
    ['UNC path', String.raw`\\server\share\file.ts`],
    ['leading backslash', String.raw`\file.ts`],
    ['backslash', String.raw`apps\storefront\file.ts`],
    ['current-directory segment', 'apps/./file.ts'],
    ['parent traversal', 'apps/../file.ts'],
    ['empty segment', 'apps//file.ts'],
    ['NUL character', 'apps/\0/file.ts'],
    ['trailing separator', 'apps/file.ts/'],
    ['empty path', ''],
  ])('rejects a destination containing a %s', (_label, destination) => {
    const input = freshManifest();
    input.recipes[0]!.operations[0]!.destination = destination;

    expect(issuePaths(input)).toContain(
      '$.recipes[0].operations[0].destination',
    );
  });

  it('applies the portable path rules to template paths', () => {
    const input = freshManifest();
    const operation = input.recipes[0]!.operations[0]!;
    if (operation.type !== 'add') {
      throw new Error('Fixture operation must be add');
    }
    operation.template = '../outside.ts';

    expect(issuePaths(input)).toContain(
      '$.recipes[0].operations[0].template',
    );
  });

  it('rejects an empty operation array', () => {
    const input = freshManifest();
    input.recipes[0]!.operations = [];

    expect(issuePaths(input)).toContain('$.recipes[0].operations');
  });

  it('rejects case-insensitive destination collisions', () => {
    const input = freshManifest();
    input.recipes[0]!.operations[1]!.destination =
      input.recipes[0]!.operations[0]!.destination.toUpperCase();

    expect(issuePaths(input)).toContain(
      '$.recipes[0].operations[1].destination',
    );
  });

  it('rejects case-insensitive template collisions', () => {
    const input = freshManifest();
    const first = input.recipes[0]!.operations[0]!;
    const second = input.recipes[0]!.operations[1]!;
    if (first.type !== 'add' || second.type !== 'replace') {
      throw new Error('Fixture operations must be add then replace');
    }
    second.template = first.template.toUpperCase();

    expect(issuePaths(input)).toContain(
      '$.recipes[0].operations[1].template',
    );
  });

  it('rejects invalid SHA-256 values and source commits', () => {
    const input = freshManifest();
    input.recoveryStates[0]!.sha256 = 'PENDING';
    input.recoveryStates[0]!.sourceCommit = 'abc123';

    expect(issuePaths(input)).toEqual(
      expect.arrayContaining([
        '$.recoveryStates[0].sha256',
        '$.recoveryStates[0].sourceCommit',
      ]),
    );
  });

  it.each([0, 0o600, 0o700, 0o777])('rejects operation mode %s', (mode) => {
    const input = freshManifest();
    const operation = input.recipes[0]!.operations[0]!;
    if (operation.type !== 'add') {
      throw new Error('Fixture operation must be add');
    }
    operation.mode = mode;

    expect(issuePaths(input)).toContain(
      '$.recipes[0].operations[0].mode',
    );
  });

  it('rejects add operations with a before hash', () => {
    const input = freshManifest();
    Object.assign(input.recipes[0]!.operations[0]!, {
      beforeSha256: '2'.repeat(64),
    });

    expect(issuePaths(input)).toContain(
      '$.recipes[0].operations[0].beforeSha256',
    );
  });

  it.each(['beforeSha256', 'afterSha256'])(
    'rejects replace operations missing %s',
    (property) => {
      const input = freshManifest();
      input.recipes[0]!.operations[1] = withoutProperty(
        input.recipes[0]!.operations[1]!,
        property,
      ) as CourseManifest['recipes'][number]['operations'][number];

      expect(issuePaths(input)).toContain(
        `$.recipes[0].operations[1].${property}`,
      );
    },
  );

  it.each(['template', 'afterSha256', 'mode'])(
    'rejects delete operations with %s',
    (property) => {
      const input = freshManifest();
      Object.assign(input.recipes[0]!.operations[2]!, {
        [property]: property === 'mode' ? 0o644 : '2'.repeat(64),
      });

      expect(issuePaths(input)).toContain(
        `$.recipes[0].operations[2].${property}`,
      );
    },
  );

  it('rejects unknown starting and result states', () => {
    const input = freshManifest();
    input.recipes[0]!.startingState = 'missing-start';
    input.recipes[0]!.resultState = 'missing-result';

    expect(issuePaths(input)).toEqual(
      expect.arrayContaining([
        '$.recipes[0].resultState',
        '$.recipes[0].startingState',
      ]),
    );
  });

  it('rejects identical starting and result states', () => {
    const input = freshManifest();
    input.recipes[0]!.resultState = input.recipes[0]!.startingState;

    expect(issuePaths(input)).toContain('$.recipes[0].resultState');
  });

  it.each([
    [
      'recipe description',
      (input: CourseManifest) => {
        input.recipes[0]!.description = '   ';
      },
      '$.recipes[0].description',
    ],
    [
      'recipe verification command',
      (input: CourseManifest) => {
        input.recipes[0]!.verification[0] = ' ';
      },
      '$.recipes[0].verification[0]',
    ],
    [
      'recovery verification command',
      (input: CourseManifest) => {
        input.recoveryStates[0]!.verification[0] = '\t';
      },
      '$.recoveryStates[0].verification[0]',
    ],
  ])('rejects an empty %s', (_label, mutate, path) => {
    const input = freshManifest();
    mutate(input);

    expect(issuePaths(input)).toContain(path);
  });

  it('rejects empty verification arrays', () => {
    const input = freshManifest();
    input.recipes[0]!.verification = [];
    input.recoveryStates[0]!.verification = [];

    expect(issuePaths(input)).toEqual(
      expect.arrayContaining([
        '$.recipes[0].verification',
        '$.recoveryStates[0].verification',
      ]),
    );
  });

  it.each([
    ['HTTP URL', 'http://github.com/madeupdev/project'],
    ['non-GitHub URL', 'https://example.com/madeupdev/project'],
    ['query string', 'https://github.com/madeupdev/project?ref=main'],
    ['fragment', 'https://github.com/madeupdev/project#readme'],
    ['missing repository', 'https://github.com/madeupdev'],
    ['extra path', 'https://github.com/madeupdev/project/tree/main'],
  ])('rejects a repository with a %s', (_label, repository) => {
    const input = freshManifest();
    input.project.repository = repository;

    expect(issuePaths(input)).toContain('$.project.repository');
  });

  it.each([
    ['empty query delimiter', 'https://github.com/madeupdev/project?'],
    ['empty fragment delimiter', 'https://github.com/madeupdev/project#'],
    [
      'backslash-normalized URL',
      String.raw`https://github.com\madeupdev/project`,
    ],
    ['extra protocol slashes', 'https:////github.com/madeupdev/project'],
  ])('rejects a noncanonical repository with %s', (_label, repository) => {
    const input = freshManifest();
    input.project.repository = repository;
    input.release.repository = repository;

    expect(issuePaths(input)).toEqual(
      expect.arrayContaining([
        '$.project.repository',
        '$.release.repository',
      ]),
    );
  });

  it('collects field and unknown-key issues for an invalid operation type', () => {
    const input = freshManifest() as unknown as {
      recipes: Array<{ operations: unknown[] }>;
    };
    input.recipes[0]!.operations[0] = {
      type: 'move',
      destination: '/outside.ts',
      template: '../outside.ts',
      mode: 1,
      'bad.key': true,
    };

    expect(issuePaths(input)).toEqual(
      expect.arrayContaining([
        '$.recipes[0].operations[0].destination',
        '$.recipes[0].operations[0].mode',
        '$.recipes[0].operations[0].template',
        '$.recipes[0].operations[0].type',
        '$.recipes[0].operations[0]["bad.key"]',
      ]),
    );
  });

  it.each([
    ['directory', 'recovery/fixture.tar.gz'],
    ['backslash directory', String.raw`recovery\fixture.tar.gz`],
    ['parent traversal', '../fixture.tar.gz'],
    ['wrong extension', 'fixture.zip'],
    ['bare extension', '.tar.gz'],
  ])('rejects an unsafe asset name containing a %s', (_label, asset) => {
    const input = freshManifest();
    input.recoveryStates[0]!.asset = asset;

    expect(issuePaths(input)).toContain('$.recoveryStates[0].asset');
  });

  it('rejects invalid and unstable identifiers', () => {
    const input = freshManifest();
    input.recoveryStates[0]!.id = '-bad--id-';
    input.recipes[0]!.id = 'bad_id';

    expect(issuePaths(input)).toEqual(
      expect.arrayContaining([
        '$.recipes[0].id',
        '$.recoveryStates[0].id',
      ]),
    );
  });

  it('returns multiple simultaneous issues with useful deterministic paths', () => {
    const input = {
      ...freshManifest(),
      schemaVersion: 2,
      courseVersion: 'latest',
    };
    input.release.tag = 'wrong';
    input.recoveryStates[0]!.sourceCommit = 'short';
    input.recipes[0]!.operations[0]!.destination = '/outside.ts';

    const first = invalidIssues(input);
    const second = invalidIssues(input);

    expect(first).toEqual(second);
    expect(first.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        '$.courseVersion',
        '$.recipes[0].operations[0].destination',
        '$.recoveryStates[0].sourceCommit',
        '$.release.tag',
        '$.schemaVersion',
      ]),
    );
  });
});
