# Trusted npm Publication Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add deterministic, tokenless, stage-only npm publication and exact-artifact GitHub Release workflows with a categorically safe dry run.

**Architecture:** A tested TypeScript helper validates release tags, versions, archives, checksums, and upstream run metadata. `publish.yml` builds and uploads one verified release bundle, then stages it through npm OIDC only for tag pushes; `release.yml` retrieves that exact bundle from the successful upstream run and keeps the GitHub Release draft until registry verification succeeds.

**Tech Stack:** GitHub Actions, Node.js 24.18.0, pnpm 11.17.0, npm 11.18.0, TypeScript 6.0.3, Vitest 4.1.10, npm OIDC trusted publishing, GitHub CLI.

---

### Task 1: Add deterministic release validation

**Files:**
- Create: `tests/scripts/release.test.ts`
- Create: `scripts/release.ts`
- Modify: `package.json`

**Step 1: Write failing tests**

Cover exact `vMAJOR.MINOR.PATCH` validation, development/prerelease rejection,
package/tag equality, exact tarball naming, one-tarball enforcement, checksum
creation and verification, and trusted upstream metadata.

**Step 2: Verify RED**

Run: `pnpm test:release`
Expected: FAIL because `scripts/release.ts` and the script entry do not exist.

**Step 3: Implement the minimum helper and CLI subcommands**

Expose pure validation functions plus `prepare`, `verify-bundle`, and
`verify-upstream` commands. Use Node core modules only. Ensure all inputs are
passed as arguments or controlled environment values and never interpreted by
a shell.

**Step 4: Verify GREEN**

Run: `pnpm test:release`
Expected: all focused release tests pass.

### Task 2: Add and statically validate the publish workflow

**Files:**
- Create: `.github/workflows/publish.yml`
- Create: `tests/workflows/publish.test.ts`
- Modify: `package.json`

**Step 1: Write failing static workflow tests**

Assert the workflow is missing, then specify exact triggers, default read-only
permissions, pinned toolchain/actions, disabled cache, frozen install, every
required gate, exact bundle upload, dry-run guards and summary, `npm`
environment, job-level OIDC, no token, and `npm stage publish` only.

**Step 2: Verify RED**

Run: `pnpm test:workflows`
Expected: FAIL because `publish.yml` does not exist.

**Step 3: Implement `publish.yml`**

Use `workflow_dispatch` and a broad tag glob followed by the tested exact
validator. Build on a GitHub-hosted runner, install npm 11.18.0 explicitly, run
all gates, upload one bundle with a pinned artifact action, and condition the
OIDC stage job strictly on a tag-push output from the validator.

**Step 4: Verify GREEN**

Run: `pnpm test:workflows`
Expected: publish workflow assertions pass.

### Task 3: Add and statically validate exact-artifact releases

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `tests/workflows/publish.test.ts`

**Step 1: Add failing release workflow tests**

Specify a `workflow_run` completion trigger for Publish, reject non-push and
non-success upstream runs, grant only `contents: write`, download by upstream
run ID, verify upstream metadata and bundle locally, never rebuild, create a
draft, verify npm registry integrity/provenance, and publish only afterward.

**Step 2: Verify RED**

Run: `pnpm test:workflows`
Expected: FAIL because `release.yml` does not exist.

**Step 3: Implement `release.yml`**

Use GitHub's API/CLI with the run-scoped token rather than checking out
untrusted code. Extract only the named upstream artifact, validate it, create or
reuse the draft, compare registry `dist.integrity`/attestation evidence with the
tarball, and publish the existing draft only on success.

**Step 4: Verify GREEN**

Run: `pnpm test:workflows`
Expected: all workflow assertions pass.

### Task 4: Document bootstrap and manual checkpoints

**Files:**
- Modify: `README.md`
- Modify: `tests/workflows/publish.test.ts`

**Step 1: Add failing documentation assertions**

Require the no-token bootstrap limitation, public-repository/provenance
constraint, exact publisher identity, stage-only selection, dry-run invocation,
human approval/retry flow, and all external checkpoints.

**Step 2: Verify RED**

Run: `pnpm test:workflows`
Expected: FAIL on missing operational documentation.

**Step 3: Update README**

Separate safe local/PR preparation from post-purge bootstrap and post-package
trusted-publisher setup. Make every mutating command a manual, explicitly
approved action and preserve the PolyForm license wording.

**Step 4: Verify GREEN**

Run: `pnpm test:workflows`
Expected: all workflow/documentation assertions pass.

### Task 5: Full verification, review, commit, and push

**Files:**
- Review all Task 13 changes.

**Step 1: Run complete verification**

Run lint, typecheck, full tests, build, release workflow validation, recipe
replay, `pnpm audit --prod`, real `pnpm pack`, package inspection, exact
tarball-count/checksum verification, license comparison, and a credential/
permission diff scan.

**Step 2: Review requirement-by-requirement**

Confirm dry-run safety, no external mutation, exact tool versions and action
SHAs, exact tag matching, duplicate prevention, exact artifact continuity,
registry evidence, and Task 13-only scope.

**Step 3: Commit**

Run: `git commit -m "ci: publish CLI with trusted provenance"`

**Step 4: Push without merging**

Run: `git push -u origin codex/task-13-trusted-publication`
Expected: branch is available for a dry-run PR; no tag or release is created.
