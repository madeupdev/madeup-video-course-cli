import { readFile } from 'node:fs/promises';

import { expect, test } from 'vitest';

const publishWorkflowUrl = new URL('../../.github/workflows/publish.yml', import.meta.url);
const releaseWorkflowUrl = new URL('../../.github/workflows/release.yml', import.meta.url);
const releaseRunbookUrl = new URL('../../docs/RELEASING.md', import.meta.url);

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

test('passes the release tarball to npm as an explicit local package path', async () => {
  const workflow = await readNormalizedText(publishWorkflowUrl);

  expect(workflow).toContain(
    'npm stage publish "./release-bundle/$TARBALL" --access public',
  );
  expect(workflow).not.toContain(
    'npm stage publish "release-bundle/$TARBALL" --access public',
  );
});

test('installs locked runtime verifier dependencies safely before staging', async () => {
  const workflow = await readNormalizedText(publishWorkflowUrl);
  const stageJob = workflow.slice(workflow.indexOf('\n  stage:'));

  expect(stageJob).toContain('corepack install --global pnpm@11.17.0');
  expect(stageJob).toContain('pnpm install --frozen-lockfile --prod --ignore-scripts');
  expect(stageJob.indexOf('pnpm install --frozen-lockfile --prod --ignore-scripts')).toBeLessThan(
    stageJob.indexOf('node scripts/release.ts verify-bundle'),
  );
});

test('releases only a successful trusted Publish tag run with narrow write permission', async () => {
  const workflow = await readNormalizedText(releaseWorkflowUrl);

  expect(workflow).toMatch(/^name: Release$/mu);
  expect(workflow).toContain('workflow_run:');
  expect(workflow).toMatch(/^[ ]{2}workflow_dispatch:\n[ ]{4}inputs:\n[ ]{6}upstream_run_id:/mu);
  expect(workflow).toContain('workflows: [Publish]');
  expect(workflow).toContain('types: [completed]');
  expect(workflow).toMatch(/^permissions:\n[ ]{2}actions: read\n[ ]{2}contents: write$/mu);
  expect(workflow).not.toContain('id-token: write');
  expect(workflow).not.toContain('pull_request_target');
  expect(workflow).toContain('github.event.workflow_run.event == \'push\'');
  expect(workflow).toContain('github.event.workflow_run.conclusion == \'success\'');
  expect(workflow).toContain('Validate trusted upstream metadata');
});

test('authenticates manual recovery from one exact successful Publish run', async () => {
  const workflow = await readNormalizedText(releaseWorkflowUrl);

  expect(workflow).toContain('GH_REPO: ${{ github.repository }}');
  expect(workflow).toContain('REQUESTED_RUN_ID: ${{');
  expect(workflow).toContain('inputs.upstream_run_id');
  expect(workflow).toContain('actions/runs/${REQUESTED_RUN_ID}');
  for (const trustedValue of [
    'Publish',
    '.github/workflows/publish.yml',
    'push',
    'completed',
    'success',
    'head_branch',
    'head_sha',
    'head_repository.full_name',
    'repository.full_name',
  ]) {
    expect(workflow).toContain(trustedValue);
  }
  expect(workflow).toContain('echo "run_id=$RUN_ID" >> "$GITHUB_OUTPUT"');
  expect(workflow).toContain('echo "TAG=$TAG" >> "$GITHUB_ENV"');
  expect(workflow).toContain('run-id: ${{ steps.upstream.outputs.run_id }}');
  expect(workflow).toContain('git/ref/tags/${TAG}');
  expect(workflow).toContain('ref.object?.type !== "commit"');
  expect(workflow).toContain('ref.object.sha !== process.env.UPSTREAM_SHA');
  expect(workflow).not.toContain('actions/checkout');
});

test('downloads and verifies the exact upstream artifact without rebuilding', async () => {
  const workflow = await readNormalizedText(releaseWorkflowUrl);

  expect(workflow).toMatch(/uses: actions\/download-artifact@[a-f0-9]{40}/u);
  expect(workflow).toContain('run-id: ${{ steps.upstream.outputs.run_id }}');
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

test('records the completed one-time bootstrap exception', async () => {
  const runbook = await readNormalizedText(releaseRunbookUrl);

  expect(runbook).toContain('Version `0.0.1` was therefore published manually');
  expect(runbook).toContain('interactive\naccount authentication');
  expect(runbook).toContain('provenance explicitly disabled');
  expect(runbook).toContain('That exception is complete and must not be repeated');
  expect(runbook).toContain('All subsequent releases use the stage-only\ntrusted publisher');
  expect(runbook).toContain('Do not create or use an npm publication token');
});

test('documents the exact stage-only trusted publisher and approval flow', async () => {
  const runbook = await readNormalizedText(releaseRunbookUrl);

  for (const value of [
    'madeupdev',
    'madeup-video-course-cli',
    'publish.yml',
    'npm` environment',
    'npm stage publish',
    'stage-only',
  ]) {
    expect(runbook).toContain(value);
  }
  expect(runbook).toContain('Actions → Publish → Run workflow');
  expect(runbook).toContain('`DRY RUN` notice');
  expect(runbook).toContain('approve the stage with npm account 2FA');
  expect(runbook).toMatch(/rerun the\s+failed Release workflow/iu);
  expect(runbook).toContain('Actions → Release → Run workflow');
  expect(runbook).toContain('successful Publish workflow run ID');
});

test('documents every remaining external release checkpoint', async () => {
  const runbook = await readNormalizedText(releaseRunbookUrl);

  for (const checkpoint of [
    'Obtain explicit approval to create the matching exact tag',
    'review the waiting `npm` environment deployment',
    'Review the staged package on npmjs.com',
    'Obtain explicit approval, then approve the stage',
    'Require two-factor authentication',
    'Enable immutable GitHub Releases',
  ]) {
    expect(runbook).toContain(checkpoint);
  }
});
