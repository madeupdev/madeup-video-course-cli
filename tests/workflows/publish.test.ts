import { readFile } from 'node:fs/promises';

import { expect, test } from 'vitest';

const publishWorkflowUrl = new URL('../../.github/workflows/publish.yml', import.meta.url);
const releaseWorkflowUrl = new URL('../../.github/workflows/release.yml', import.meta.url);
const readmeUrl = new URL('../../README.md', import.meta.url);

function normalizeNewlines(text: string): string {
  return text.replaceAll('\r\n', '\n');
}

async function readNormalizedText(url: URL): Promise<string> {
  return normalizeNewlines(await readFile(url, 'utf8'));
}

test('normalizes Windows checkout line endings before static assertions', () => {
  expect(normalizeNewlines('first\r\nsecond\r\n')).toBe('first\nsecond\n');
});

test('uses safe triggers, least privilege, concurrency, and immutable actions', async () => {
  const workflow = await readNormalizedText(publishWorkflowUrl);

  expect(workflow).toMatch(/^name: Publish$/mu);
  expect(workflow).toMatch(/^[ ]{2}workflow_dispatch:$/mu);
  expect(workflow).toMatch(/^[ ]{2}push:\n[ ]{4}tags:\n[ ]{6}- ['"]v\*['"]$/mu);
  expect(workflow).toMatch(/^permissions:\n[ ]{2}contents: read$/mu);
  expect(workflow).toContain('cancel-in-progress: false');
  expect(workflow).toContain('persist-credentials: false');
  expect(workflow).toMatch(/uses: actions\/checkout@[a-f0-9]{40}/u);
  expect(workflow).toMatch(/uses: actions\/setup-node@[a-f0-9]{40}/u);
  expect(workflow).toMatch(/uses: actions\/upload-artifact@[a-f0-9]{40}/u);
  expect(workflow).not.toMatch(/uses: [^\n]+@(?![a-f0-9]{40}(?:\s|$))[^\s#]+/u);
});

test('pins artifact transfer to current Node 24 action releases', async () => {
  const publishWorkflow = await readNormalizedText(publishWorkflowUrl);
  const releaseWorkflow = await readNormalizedText(releaseWorkflowUrl);

  expect(publishWorkflow).toContain(
    'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1',
  );
  expect(publishWorkflow).toContain(
    'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1',
  );
  expect(releaseWorkflow).toContain(
    'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c # v8.0.1',
  );
});

test('pins the release toolchain and runs every build gate without caching', async () => {
  const workflow = await readNormalizedText(publishWorkflowUrl);

  expect(workflow).toContain('node-version: 24.18.0');
  expect(workflow).toContain('package-manager-cache: false');
  expect(workflow).toContain('pnpm@11.17.0');
  expect(workflow).toContain('npm@11.18.0');
  for (const command of [
    'pnpm install --frozen-lockfile',
    'pnpm lint',
    'pnpm typecheck',
    'pnpm test',
    'pnpm test:replay',
    'pnpm build',
    'pnpm audit --prod',
    'pnpm pack --pack-destination',
    'node scripts/inspect-pack.ts',
    'node scripts/release.ts prepare',
    'node scripts/release.ts verify-bundle',
    'madeup-video-course --help',
  ]) {
    expect(workflow).toContain(command);
  }
  expect(workflow).toContain('name: trusted-publication-bundle');
  expect(workflow).toContain('if-no-files-found: error');
  expect(workflow).toContain('retention-days: 7');
});

test('makes manual dispatch an unmistakable non-publishing dry run', async () => {
  const workflow = await readNormalizedText(publishWorkflowUrl);

  expect(workflow).toContain("github.event_name == 'workflow_dispatch'");
  expect(workflow).toContain('DRY RUN: npm publication and GitHub Release creation were skipped');
  expect(workflow).toContain('dry_run=true');
  expect(workflow).toContain("needs.build.outputs.dry_run == 'false'");
  expect(workflow).not.toContain('pull_request_target');
  expect(workflow).not.toContain('repository_dispatch');
});

test('stages only the exact verified tag artifact through OIDC and the npm environment', async () => {
  const workflow = await readNormalizedText(publishWorkflowUrl);

  expect(workflow).toContain('environment: npm');
  expect(workflow).toMatch(/permissions:\n[ ]{6}contents: read\n[ ]{6}id-token: write/u);
  expect(workflow).toContain('npm stage publish');
  expect(workflow).not.toMatch(/\bnpm publish\b/u);
  expect(workflow).not.toContain('NODE_AUTH_TOKEN');
  expect(workflow).not.toMatch(/NPM_TOKEN|secrets\./u);
  expect(workflow).toContain('npm view "@madeup-video/course@${VERSION}" version');
  expect(workflow).toContain('Stage ID:');
});

test('releases only a successful trusted Publish tag run with narrow write permission', async () => {
  const workflow = await readNormalizedText(releaseWorkflowUrl);

  expect(workflow).toMatch(/^name: Release$/mu);
  expect(workflow).toContain('workflow_run:');
  expect(workflow).toContain('workflows: [Publish]');
  expect(workflow).toContain('types: [completed]');
  expect(workflow).toMatch(/^permissions:\n[ ]{2}contents: write$/mu);
  expect(workflow).not.toContain('id-token: write');
  expect(workflow).not.toContain('pull_request_target');
  expect(workflow).toContain('github.event.workflow_run.event == \'push\'');
  expect(workflow).toContain('github.event.workflow_run.conclusion == \'success\'');
  expect(workflow).toContain('Validate trusted upstream metadata');
});

test('downloads and verifies the exact upstream artifact without rebuilding', async () => {
  const workflow = await readNormalizedText(releaseWorkflowUrl);

  expect(workflow).toMatch(/uses: actions\/download-artifact@[a-f0-9]{40}/u);
  expect(workflow).toContain('run-id: ${{ github.event.workflow_run.id }}');
  expect(workflow).toContain('github-token: ${{ github.token }}');
  expect(workflow).toContain('name: trusted-publication-bundle');
  expect(workflow).toContain('sha256sum --check --strict SHA256SUMS');
  expect(workflow).toContain("tar -xOf \"$TARBALL\" package/package.json");
  expect(workflow).not.toMatch(/pnpm (?:install|build|pack|test)/u);
  expect(workflow).not.toContain('actions/checkout');
});

test('keeps a draft until npm integrity and provenance are verified', async () => {
  const workflow = await readNormalizedText(releaseWorkflowUrl);

  expect(workflow).toContain('gh release create "$TAG"');
  expect(workflow).toContain('gh release upload "$TAG"');
  expect(workflow).toContain('--clobber');
  expect(workflow).toContain('--draft');
  expect(workflow).toContain('release-bundle/SHA256SUMS');
  expect(workflow).toContain('npm view "@madeup-video/course@${VERSION}" dist --json');
  expect(workflow).toContain('Registry integrity differs from the release tarball');
  expect(workflow).toContain('Registry provenance evidence is missing');
  expect(workflow).toContain('gh release edit "$TAG" --draft=false');
  expect(workflow.indexOf('verify-registry')).toBeLessThan(workflow.indexOf('--draft=false'));
  expect(workflow).not.toContain('NODE_AUTH_TOKEN');
  expect(workflow).not.toMatch(/NPM_TOKEN|secrets\./u);
});

test('documents the unavoidable tokenless bootstrap and provenance limitation', async () => {
  const readme = await readNormalizedText(readmeUrl);

  expect(readme).toContain('`npm stage publish`\ncannot create a new package');
  expect(readme).toContain('`npm trust` requires an existing package');
  expect(readme).toContain('interactive account 2FA');
  expect(readme).toContain('--provenance=false');
  expect(readme).toMatch(/the bootstrap version cannot have npm provenance/iu);
  expect(readme).toMatch(/public GitHub repository and a public\s+npm package/iu);
  expect(readme).toContain('No npm token');
});

test('documents the exact stage-only trusted publisher and approval flow', async () => {
  const readme = await readNormalizedText(readmeUrl);

  for (const value of [
    'madeupdev',
    'madeup-video-course-cli',
    'publish.yml',
    'npm` environment',
    'npm stage publish',
    'stage-only',
    'npm stage approve',
    'rerun the failed `Release` workflow',
  ]) {
    expect(readme).toContain(value);
  }
  expect(readme).toContain('Actions → Publish → Run workflow');
  expect(readme).toContain('DRY RUN');
  expect(readme).toMatch(/direct OIDC publication/iu);
});

test('documents every external checkpoint and the pending purge blocker', async () => {
  const readme = await readNormalizedText(readmeUrl);

  for (const checkpoint of [
    'Confirm the private-email history purge',
    'Make the repository public',
    'Perform the first npm publication',
    'Create the protected GitHub environment',
    'Configure the npm trusted publisher',
    'Disable token publication',
    'Enable immutable GitHub Releases',
    'Create and push the first automated release tag',
    'Approve the staged npm package',
  ]) {
    expect(readme).toContain(checkpoint);
  }
});
