import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));
const ignoredStorefrontDirectories = new Set([
  '.next',
  'node_modules',
  'playwright-report',
  'test-results',
]);

async function storefrontSourceFiles(directory) {
  const files = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory() && !ignoredStorefrontDirectories.has(entry.name)) {
      files.push(...await storefrontSourceFiles(path));
    } else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) {
      files.push(path);
    }
  }

  return files.sort();
}
const courseTags = new Map([
  ['@madeup-video/admin', ['runtime:browser', 'scope:rental', 'type:app']],
  ['@madeup-video/admin-e2e', ['runtime:browser', 'scope:rental', 'type:test']],
  ['@madeup-video/storefront', ['runtime:universal', 'scope:storefront', 'type:app']],
  ['@madeup-video/api', ['runtime:server', 'scope:rental', 'type:app']],
  ['@madeup-video/api-e2e', ['runtime:server', 'scope:rental', 'type:test']],
  ['@madeup-video/contracts', ['runtime:universal', 'scope:rental', 'type:contract']],
  ['@madeup-video/rental-domain', ['runtime:universal', 'scope:rental', 'type:domain']],
  ['@madeup-video/database', ['runtime:server', 'scope:rental', 'type:data-access']],
  ['@madeup-video/ui', ['runtime:browser', 'scope:shared', 'type:ui']],
  ['@madeup-video/testing', ['runtime:server', 'scope:shared', 'type:test']],
]);

test('models the storefront, admin, API projects, and five approved libraries', async () => {
  const { stdout } = await exec('pnpm', ['exec', 'nx', 'show', 'projects', '--json'], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.deepEqual(JSON.parse(stdout).sort(), [
    '@madeup-video/admin',
    '@madeup-video/admin-e2e',
    '@madeup-video/api',
    '@madeup-video/api-e2e',
    '@madeup-video/contracts',
    '@madeup-video/database',
    '@madeup-video/rental-domain',
    '@madeup-video/storefront',
    '@madeup-video/testing',
    '@madeup-video/ui',
  ]);
});

test('locates the storefront and admin projects at their canonical roots', async () => {
  for (const [projectName, expectedRoot] of [
    ['@madeup-video/storefront', 'apps/storefront'],
    ['@madeup-video/admin', 'apps/admin'],
    ['@madeup-video/admin-e2e', 'apps/admin-e2e'],
  ]) {
    const { stdout } = await exec(
      'pnpm',
      ['exec', 'nx', 'show', 'project', projectName, '--json'],
      { cwd: root, encoding: 'utf8' },
    );

    assert.equal(JSON.parse(stdout).root, expectedRoot, projectName);
  }
});

test('keeps generated API output out of project inference', async () => {
  const { stdout } = await exec(
    'pnpm',
    ['exec', 'nx', 'show', 'project', '@madeup-video/api', '--json'],
    { cwd: root, encoding: 'utf8' },
  );

  assert.equal(JSON.parse(stdout).root, 'apps/api');
});

test('preserves the accepted final storefront dependency edges', async () => {
  const { stdout } = await exec(
    'pnpm',
    ['exec', 'nx', 'graph', '--file=stdout'],
    { cwd: root, encoding: 'utf8' },
  );
  const graph = JSON.parse(stdout).graph;

  assert.deepEqual(
    graph.dependencies['@madeup-video/storefront']
      .map(({ target }) => target)
      .sort(),
    [
      '@madeup-video/contracts',
      '@madeup-video/rental-domain',
      '@madeup-video/testing',
      '@madeup-video/ui',
    ],
  );
});

test('keeps the complete storefront free of database imports', async () => {
  const sourceFiles = await storefrontSourceFiles(join(root, 'apps/storefront'));
  const violations = [];

  for (const file of sourceFiles) {
    const source = await readFile(file, 'utf8');

    if (source.includes('@madeup-video/database')) {
      violations.push(relative(root, file));
    }
  }

  assert.deepEqual(violations, []);
});

test('tracks root Prisma sources as cached storefront build inputs', async () => {
  const project = JSON.parse(
    await readFile(
      new URL('../../apps/storefront/project.json', import.meta.url),
    ),
  );

  assert.deepEqual(project.targets.build.inputs, [
    'default',
    '^default',
    '{workspaceRoot}/prisma/**/*',
    '{workspaceRoot}/prisma.config.ts',
  ]);
});

test('tracks the admin API URL as a cached build input', async () => {
  const project = JSON.parse(
    await readFile(new URL('../../apps/admin/project.json', import.meta.url)),
  );

  assert.deepEqual(
    project.targets.build.inputs.filter((input) => typeof input === 'object'),
    [{ env: 'VITE_API_URL' }],
  );
});

test('tracks and generates root Prisma sources for cached API builds', async () => {
  const project = JSON.parse(
    await readFile(new URL('../../apps/api/project.json', import.meta.url)),
  );
  const build = project.targets.build;

  assert.deepEqual(build.inputs, [
    'default',
    '^default',
    '{workspaceRoot}/prisma/**/*',
    '{workspaceRoot}/prisma.config.ts',
  ]);
  assert.ok(
    build.outputs.includes('{workspaceRoot}/generated/prisma/**/*'),
  );
  assert.deepEqual(build.options.commands, [
    'pnpm --dir ../.. db:generate',
    'pnpm exec webpack-cli build',
  ]);
  assert.equal(build.options.parallel, false);
});

test('repository aggregates cover the API and admin projects', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url)),
  );
  const scripts = packageJson.scripts;

  assert.equal(scripts.lint, 'eslint .');
  assert.match(scripts.build, /@madeup-video\/api/);
  assert.match(scripts.build, /@madeup-video\/admin/);
  assert.match(scripts.build, /--parallel=1/);
  assert.match(scripts.typecheck, /@madeup-video\/api-e2e/);
  assert.match(scripts.typecheck, /@madeup-video\/admin/);
  assert.match(scripts.typecheck, /@madeup-video\/admin-e2e/);
  assert.match(scripts['test:api'], /@madeup-video\/api-e2e/);
  assert.match(scripts['test:all'], /test:api/);
  assert.match(scripts['test:e2e'], /@madeup-video\/admin-e2e/);
});

test('lets the local admin E2E use a validated port override', async () => {
  const config = await readFile(
    new URL('../../apps/admin-e2e/playwright.config.ts', import.meta.url),
    'utf8',
  );
  const viteConfig = await readFile(
    new URL('../../apps/admin/vite.config.ts', import.meta.url),
    'utf8',
  );

  assert.match(config, /ADMIN_PORT/);
  assert.match(config, /Number\.isSafeInteger/);
  assert.match(config, /--port=\$\{adminPort\}/);
  assert.match(viteConfig, /strictPort:\s*true/);
});

test('keeps the prepared admin boundary local and makes its E2E journey self-contained', async () => {
  const [api, application, project, playwrightConfig] = await Promise.all([
    readFile(new URL('../../apps/admin/src/app/api.ts', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/admin/src/app/app.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/admin-e2e/project.json', import.meta.url), 'utf8'),
    readFile(new URL('../../apps/admin-e2e/playwright.config.ts', import.meta.url), 'utf8'),
  ]);

  assert.doesNotMatch(api, /@madeup-video\/contracts/);
  assert.doesNotMatch(application, /@madeup-video\/(?:contracts|ui)/);
  assert.match(api, /safeParse|\.parse\(/);
  assert.match(project, /@madeup-video\/api/);
  assert.match(project, /prepare-test-database/);
  assert.match(playwrightConfig, /API_PORT/);
  assert.match(playwrightConfig, /@madeup-video\/api:dev/);
  assert.equal((playwrightConfig.match(/reuseExistingServer:\s*false/g) ?? []).length, 2);
});

test('CI validates the complete API and storefront workspace', async () => {
  const workflow = await readFile(
    new URL('../../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );

  assert.match(workflow, /run: pnpm lint/);
  assert.match(workflow, /run: pnpm typecheck/);
  assert.match(workflow, /run: pnpm test:tooling/);
  assert.match(workflow, /run: pnpm test:unit/);
  assert.match(workflow, /run: pnpm test:integration/);
  assert.match(workflow, /run: pnpm build/);
  assert.match(workflow, /run: pnpm test:api/);
  assert.match(workflow, /run: pnpm test:e2e/);
});

test('exposes only the five approved library entry points', async () => {
  const tsconfig = JSON.parse(
    await readFile(new URL('../../tsconfig.base.json', import.meta.url)),
  );

  assert.deepEqual(Object.keys(tsconfig.compilerOptions.paths ?? {}).sort(), [
    '@madeup-video/contracts',
    '@madeup-video/database',
    '@madeup-video/rental-domain',
    '@madeup-video/testing',
    '@madeup-video/ui',
  ]);
  for (const [name, [entryPoint]] of Object.entries(tsconfig.compilerOptions.paths ?? {})) {
    assert.equal(entryPoint, `./libs/${name.replace('@madeup-video/', '')}/src/index.ts`);
  }
});

test('classifies each project by purpose, runtime, and scope', async () => {
  for (const [projectName, expectedTags] of courseTags) {
    const { stdout } = await exec(
      'pnpm',
      ['exec', 'nx', 'show', 'project', projectName, '--json'],
      { cwd: root, encoding: 'utf8' },
    );
    const project = JSON.parse(stdout);
    const controlledTags = project.tags
      .filter((tag) => !tag.startsWith('npm:'))
      .sort();

    assert.deepEqual(controlledTags, expectedTags, projectName);
  }
});
