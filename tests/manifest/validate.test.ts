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
    expect(manifest.release.maxAssetBytes).toBe(104857600);
    expect(manifest.project.localArtifacts).toEqual(
      expect.arrayContaining([
        { type: 'directory-name', name: 'node_modules' },
        { type: 'directory-name', name: '.next' },
        { type: 'directory-name', name: 'coverage' },
        { type: 'directory', path: 'generated/prisma' },
        { type: 'directory', path: 'playwright-report' },
        { type: 'directory', path: 'test-results' },
        { type: 'file', path: 'next-env.d.ts' },
        { type: 'file-suffix', suffix: '.tsbuildinfo' },
        { type: 'file', path: '.env' },
        { type: 'file', path: '.env.local' },
        { type: 'file', path: '.env.test' },
      ]),
    );
    expect(
      manifest.recoveryStates[0]?.tree.files.map(({ path }) => path),
    ).toEqual([
      '.env.example',
      'apps/storefront/src/main.ts',
      'migrations/001-initial.sql',
      'package.json',
      'pnpm-lock.yaml',
      'scripts/verify.sh',
    ]);
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

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])(
    'rejects unsafe maximum asset size %s',
    (maxAssetBytes) => {
      const input = freshManifest();
      input.release.maxAssetBytes = maxAssetBytes;

      expect(issuePaths(input)).toContain('$.release.maxAssetBytes');
    },
  );

  it('requires a manifest-declared maximum asset size', () => {
    const input = freshManifest();
    input.release = withoutProperty(
      input.release,
      'maxAssetBytes',
    ) as CourseManifest['release'];

    expect(issuePaths(input)).toContain('$.release.maxAssetBytes');
  });

  it.each([
    ['top level', (input: CourseManifest) => input],
    ['project', (input: CourseManifest) => input.project],
    ['release', (input: CourseManifest) => input.release],
    ['recovery state', (input: CourseManifest) => input.recoveryStates[0]!],
    [
      'recovery tree',
      (input: CourseManifest) => input.recoveryStates[0]!.tree,
    ],
    [
      'recovery tree file',
      (input: CourseManifest) => input.recoveryStates[0]!.tree.files[0]!,
    ],
    [
      'local-artifact rule',
      (input: CourseManifest) => input.project.localArtifacts[0]!,
    ],
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

  it('requires every recovery state to declare its complete tree', () => {
    const input = freshManifest();
    input.recoveryStates[0] = withoutProperty(
      input.recoveryStates[0]!,
      'tree',
    ) as CourseManifest['recoveryStates'][number];

    expect(issuePaths(input)).toContain('$.recoveryStates[0].tree');
  });

  it.each(['course-tree-v2', 'unknown'])(
    'rejects the tree algorithm %s',
    (algorithm) => {
      const input = freshManifest();
      input.recoveryStates[0]!.tree.algorithm =
        algorithm as 'course-tree-v1';

      expect(issuePaths(input)).toContain(
        '$.recoveryStates[0].tree.algorithm',
      );
    },
  );

  it('rejects an empty course-tree inventory', () => {
    const input = freshManifest();
    input.recoveryStates[0]!.tree.files = [];

    expect(issuePaths(input)).toContain(
      '$.recoveryStates[0].tree.files',
    );
  });

  it.each([
    ['absolute path', '/etc/passwd'],
    ['backslash', String.raw`apps\storefront\main.ts`],
    ['empty segment', 'apps//main.ts'],
    ['parent traversal', 'apps/../main.ts'],
    ['control character', 'apps/control\nmain.ts'],
    ['Windows-invalid character', 'apps/main?.ts'],
    ['reserved Windows basename', 'apps/CON.ts'],
    ['trailing period', 'apps/main.'],
  ])('rejects a tree file with an unsafe %s', (_label, path) => {
    const input = freshManifest();
    input.recoveryStates[0]!.tree.files[0]!.path = path;

    expect(issuePaths(input)).toContain(
      '$.recoveryStates[0].tree.files[0].path',
    );
  });

  it('rejects a tree path that is not normalized to NFC', () => {
    const input = freshManifest();
    input.recoveryStates[0]!.tree.files[1]!.path =
      'apps/storefront/src/cafe\u0301.ts';

    expect(issuePaths(input)).toContain(
      '$.recoveryStates[0].tree.files[1].path',
    );
  });

  it('rejects repository Git metadata from a course-tree inventory', () => {
    const input = freshManifest();
    input.recoveryStates[0]!.tree.files[0]!.path = '.git/config';

    expect(issuePaths(input)).toContain(
      '$.recoveryStates[0].tree.files[0].path',
    );
  });

  it('requires tree files to use deterministic path order', () => {
    const input = freshManifest();
    const files = input.recoveryStates[0]!.tree.files;
    [files[0], files[1]] = [files[1]!, files[0]!];

    expect(issuePaths(input)).toContain(
      '$.recoveryStates[0].tree.files[1].path',
    );
  });

  it.each([
    ['exact duplicate', 'apps/storefront/src/main.ts'],
    ['case-only collision', 'APPS/STOREFRONT/SRC/MAIN.TS'],
  ])('rejects a tree path %s', (_label, collidingPath) => {
    const input = freshManifest();
    input.recoveryStates[0]!.tree.files.splice(2, 0, {
      path: collidingPath,
      mode: 0o644,
      sha256: '9'.repeat(64),
    });

    expect(issuePaths(input)).toContain(
      '$.recoveryStates[0].tree.files[2].path',
    );
  });

  it('rejects Unicode-normalization tree path collisions', () => {
    const input = freshManifest();
    const files = input.recoveryStates[0]!.tree.files;
    files[1]!.path = 'apps/storefront/src/café.ts';
    files.splice(2, 0, {
      path: 'apps/storefront/src/cafe\u0301.ts',
      mode: 0o644,
      sha256: '9'.repeat(64),
    });

    expect(issuePaths(input)).toContain(
      '$.recoveryStates[0].tree.files[2].path',
    );
  });

  it.each([0, 0o600, 0o700, 0o777])(
    'rejects tree mode %s',
    (mode) => {
      const input = freshManifest();
      input.recoveryStates[0]!.tree.files[0]!.mode = mode as 0o644;

      expect(issuePaths(input)).toContain(
        '$.recoveryStates[0].tree.files[0].mode',
      );
    },
  );

  it.each([
    ['short value', 'abc123'],
    ['uppercase value', 'A'.repeat(64)],
  ])('rejects a tree SHA-256 %s', (_label, sha256) => {
    const input = freshManifest();
    input.recoveryStates[0]!.tree.files[0]!.sha256 = sha256;

    expect(issuePaths(input)).toContain(
      '$.recoveryStates[0].tree.files[0].sha256',
    );
  });

  it('rejects unknown tree and tree-file fields', () => {
    const input = freshManifest();
    Object.assign(input.recoveryStates[0]!.tree, {
      digest: '9'.repeat(64),
    });
    Object.assign(input.recoveryStates[0]!.tree.files[0]!, { size: 123 });

    expect(issuePaths(input)).toEqual(
      expect.arrayContaining([
        '$.recoveryStates[0].tree.digest',
        '$.recoveryStates[0].tree.files[0].size',
      ]),
    );
  });

  it('rejects an invalid local-artifact discriminator', () => {
    const input = freshManifest() as unknown as {
      project: { localArtifacts: unknown[] };
    };
    input.project.localArtifacts = [
      {
        type: 'glob',
        pattern: '**/.cache/**',
        path: '/outside',
        name: 'bad/name',
        suffix: '*',
      },
    ];

    expect(issuePaths(input)).toEqual(
      expect.arrayContaining([
        '$.project.localArtifacts[0].name',
        '$.project.localArtifacts[0].path',
        '$.project.localArtifacts[0].pattern',
        '$.project.localArtifacts[0].suffix',
        '$.project.localArtifacts[0].type',
      ]),
    );
  });

  it.each([
    ['file', '/absolute.env'],
    ['file', '../outside.env'],
    ['directory', String.raw`generated\prisma`],
    ['directory', 'coverage//reports'],
  ] as const)(
    'rejects an unsafe local-artifact %s path',
    (type, path) => {
      const input = freshManifest();
      input.project.localArtifacts = [{ type, path }];

      expect(issuePaths(input)).toContain(
        '$.project.localArtifacts[0].path',
      );
    },
  );

  it.each([
    ['empty', ''],
    ['multiple segments', 'build/cache'],
    ['parent traversal', '..'],
    ['control character', 'bad\nname'],
    ['Windows-dangerous character', 'bad?name'],
    ['reserved Windows name', 'CON'],
  ])('rejects a directory-name rule with an %s name', (_label, name) => {
    const input = freshManifest();
    input.project.localArtifacts = [{ type: 'directory-name', name }];

    expect(issuePaths(input)).toContain(
      '$.project.localArtifacts[0].name',
    );
  });

  it.each([
    ['empty suffix', ''],
    ['every-extension suffix', '.'],
    ['missing leading period', 'tsbuildinfo'],
    ['separator', '.cache/file'],
    ['backslash', String.raw`.cache\file`],
    ['traversal-like value', '..'],
    ['control character', '.bad\n'],
    ['Windows-dangerous character', '.bad?'],
  ])('rejects a dangerous %s', (_label, suffix) => {
    const input = freshManifest();
    input.project.localArtifacts = [{ type: 'file-suffix', suffix }];

    expect(issuePaths(input)).toContain(
      '$.project.localArtifacts[0].suffix',
    );
  });

  it.each([
    [{ type: 'file', path: '.git' }, 'path'],
    [{ type: 'directory', path: '.git/objects' }, 'path'],
    [{ type: 'directory-name', name: '.git' }, 'name'],
    [{ type: 'file-suffix', suffix: '.git' }, 'suffix'],
  ] as const)(
    'rejects repository Git metadata as an author-editable local rule',
    (rule, property) => {
      const input = freshManifest();
      input.project.localArtifacts = [rule];

      expect(issuePaths(input)).toContain(
        `$.project.localArtifacts[0].${property}`,
      );
    },
  );

  it('requires local-artifact rules to use deterministic order', () => {
    const input = freshManifest();
    const rules = input.project.localArtifacts;
    [rules[0], rules[1]] = [rules[1]!, rules[0]!];

    expect(issuePaths(input)).toContain(
      '$.project.localArtifacts[1].path',
    );
  });

  it.each([
    ['exact duplicate', '.env'],
    ['case-only collision', '.ENV'],
  ])('rejects a local-artifact rule %s', (_label, path) => {
    const input = freshManifest();
    input.project.localArtifacts = [
      { type: 'file', path: '.env' },
      { type: 'file', path },
    ];

    expect(issuePaths(input)).toContain(
      '$.project.localArtifacts[1].path',
    );
  });

  it('rejects Unicode-normalization local-artifact collisions', () => {
    const input = freshManifest();
    input.project.localArtifacts = [
      { type: 'file', path: 'café.local' },
      { type: 'file', path: 'cafe\u0301.local' },
    ];

    expect(issuePaths(input)).toContain(
      '$.project.localArtifacts[1].path',
    );
  });

  it.each([
    [{ type: 'file', path: '.env.example' }, 'path'],
    [{ type: 'directory', path: 'apps' }, 'path'],
    [{ type: 'directory-name', name: 'src' }, 'name'],
    [{ type: 'file-suffix', suffix: '.json' }, 'suffix'],
  ] as const)(
    'rejects a local-artifact rule that hides an inventory file',
    (rule, property) => {
      const input = freshManifest();
      input.project.localArtifacts = [rule];

      expect(issuePaths(input)).toContain(
        `$.project.localArtifacts[0].${property}`,
      );
    },
  );

  it.each([
    { type: 'file', path: 'apps/storefront' },
    { type: 'directory', path: 'apps/store' },
    { type: 'directory-name', name: 'main.ts' },
    { type: 'file-suffix', suffix: '.src' },
  ] as const)(
    'does not broaden local-artifact matching for $type rules',
    (rule) => {
      const input = freshManifest();
      input.project.localArtifacts = [rule];

      expect(validateManifest(input).ok).toBe(true);
    },
  );

  it('aggregates tree and local-policy errors deterministically', () => {
    const input = freshManifest();
    input.recoveryStates[0]!.tree.files[0]!.path = '/outside';
    input.recoveryStates[0]!.tree.files[0]!.mode = 0o777 as 0o644;
    input.recoveryStates[0]!.tree.files[0]!.sha256 = 'ABC';
    input.project.localArtifacts = [
      { type: 'directory-name', name: 'bad/name' },
      { type: 'file-suffix', suffix: '*' },
    ];

    const first = invalidIssues(input);
    const second = invalidIssues(input);

    expect(first).toEqual(second);
    expect(first.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        '$.project.localArtifacts[0].name',
        '$.project.localArtifacts[1].suffix',
        '$.recoveryStates[0].tree.files[0].mode',
        '$.recoveryStates[0].tree.files[0].path',
        '$.recoveryStates[0].tree.files[0].sha256',
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

  it.each([
    ['C0 control character', 'apps/control\nname.ts'],
    ['DEL control character', 'apps/control\u007fname.ts'],
    ['less-than character', 'apps/file<name.ts'],
    ['greater-than character', 'apps/file>name.ts'],
    ['colon character', 'apps/file:ads.ts'],
    ['double-quote character', 'apps/file"name.ts'],
    ['pipe character', 'apps/file|name.ts'],
    ['question-mark character', 'apps/file?.ts'],
    ['asterisk character', 'apps/file*.ts'],
    ['trailing period', 'apps/trailing-dot.'],
    ['trailing space', 'apps/trailing-space '],
    ['CON device basename', 'apps/CON.ts'],
    ['PRN device basename', 'apps/prn'],
    ['AUX device basename', 'apps/Aux.json'],
    ['NUL device basename', 'apps/nul.txt'],
    ['COM1 device basename', 'apps/COM1.ts'],
    ['COM9 device basename', 'apps/com9.js'],
    ['LPT1 device basename', 'apps/LPT1.ts'],
    ['LPT9 device basename', 'apps/lpt9.log'],
    ['reserved intermediate directory', 'apps/CON/file.ts'],
    ['invalid intermediate directory', 'apps/unsafe?/file.ts'],
  ])('rejects a path segment containing a %s', (_label, path) => {
    const input = freshManifest();
    const operation = input.recipes[0]!.operations[0]!;
    if (operation.type !== 'add') {
      throw new Error('Fixture operation must be add');
    }
    operation.destination = path;
    operation.template = path;

    expect(issuePaths(input)).toEqual(
      expect.arrayContaining([
        '$.recipes[0].operations[0].destination',
        '$.recipes[0].operations[0].template',
      ]),
    );
  });

  it('accepts ordinary portable Unicode filenames', () => {
    const input = freshManifest();
    const operation = input.recipes[0]!.operations[0]!;
    if (operation.type !== 'add') {
      throw new Error('Fixture operation must be add');
    }
    operation.destination = 'apps/storefront/src/café.ts';
    operation.template = 'recipes/fixture-prepared-code/café.ts';
    input.recoveryStates[0]!.asset = 'fixture-état.tar.gz';

    expect(validateManifest(input).ok).toBe(true);
  });

  it('accepts non-reserved device-like filenames', () => {
    const input = freshManifest();
    const operation = input.recipes[0]!.operations[0]!;
    if (operation.type !== 'add') {
      throw new Error('Fixture operation must be add');
    }
    operation.destination = 'apps/COM10.ts';
    operation.template = 'recipes/LPT10.ts';
    input.recoveryStates[0]!.asset = 'NUL-safe.tar.gz';

    expect(validateManifest(input).ok).toBe(true);
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

  it('rejects NFC-equivalent destination collisions', () => {
    const input = freshManifest();
    input.recipes[0]!.operations[0]!.destination = 'apps/café.ts';
    input.recipes[0]!.operations[1]!.destination =
      'apps/cafe\u0301.ts';

    expect(issuePaths(input)).toContain(
      '$.recipes[0].operations[1].destination',
    );
  });

  it('rejects NFC-equivalent template collisions', () => {
    const input = freshManifest();
    const first = input.recipes[0]!.operations[0]!;
    const second = input.recipes[0]!.operations[1]!;
    if (first.type !== 'add' || second.type !== 'replace') {
      throw new Error('Fixture operations must be add then replace');
    }
    first.template = 'recipes/café.ts';
    second.template = 'recipes/cafe\u0301.ts';

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

  it.each([
    ['control character', 'bad\nname.tar.gz'],
    ['DEL control character', 'bad\u007fname.tar.gz'],
    ['less-than character', 'bad<name.tar.gz'],
    ['greater-than character', 'bad>name.tar.gz'],
    ['colon character', 'bad:name.tar.gz'],
    ['double-quote character', 'bad"name.tar.gz'],
    ['pipe character', 'bad|name.tar.gz'],
    ['question-mark character', 'bad?name.tar.gz'],
    ['asterisk character', 'bad*name.tar.gz'],
    ['CON device basename', 'CON.tar.gz'],
    ['PRN device basename', 'prn.tar.gz'],
    ['AUX device basename', 'Aux.tar.gz'],
    ['NUL device basename', 'nul.tar.gz'],
    ['COM1 device basename', 'COM1.tar.gz'],
    ['COM9 device basename', 'com9.tar.gz'],
    ['LPT1 device basename', 'LPT1.tar.gz'],
    ['LPT9 device basename', 'lpt9.tar.gz'],
  ])('rejects an asset basename containing a %s', (_label, asset) => {
    const input = freshManifest();
    input.recoveryStates[0]!.asset = asset;

    expect(issuePaths(input)).toContain('$.recoveryStates[0].asset');
  });

  it.each([
    ['case', 'Fixture-start.tar.gz'],
    ['Unicode normalization', 'fixture-cafe\u0301.tar.gz'],
  ])('rejects recovery asset collisions by %s', (label, collidingAsset) => {
    const input = freshManifest();
    if (label === 'Unicode normalization') {
      input.recoveryStates[0]!.asset = 'fixture-café.tar.gz';
    }
    input.recoveryStates[1]!.asset = collidingAsset;

    expect(issuePaths(input)).toContain('$.recoveryStates[1].asset');
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
