# Trusted Release Recovery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Repair checkout-free GitHub Release creation and provide an authenticated, auditable way to recover `v0.1.0` from its successful Publish run.

**Architecture:** Normalize automatic `workflow_run` metadata and manually recovered Actions API metadata into outputs from one validation step. All artifact, checksum, npm-integrity, provenance, and release-publication steps consume those trusted outputs through the existing shared path.

**Tech Stack:** GitHub Actions YAML, GitHub CLI, Node.js, Vitest, pnpm

---

### Task 1: Specify the recovery trust boundary

**Files:**
- Modify: `tests/workflows/publish.test.ts`

1. Add assertions for `GH_REPO`, a numeric `upstream_run_id` input, Actions API lookup,
   upstream repository/workflow/event/status/tag/SHA validation, and shared normalized
   outputs.
2. Run `pnpm test tests/workflows/publish.test.ts` and confirm the new assertions fail
   because manual recovery is absent.

### Task 2: Implement the minimal shared recovery path

**Files:**
- Modify: `.github/workflows/release.yml`

1. Add `workflow_dispatch` with the single required upstream run ID.
2. Add `GH_REPO` and replace direct event metadata with outputs from the validation step.
3. On manual dispatch, query and validate the exact Publish run; on automatic dispatch,
   retain the current event validation.
4. Point artifact download and concurrency at normalized trusted metadata.
5. Run the focused workflow tests and confirm they pass.

### Task 3: Verify and publish the fix

**Files:**
- Modify: `.github/workflows/release.yml`
- Modify: `tests/workflows/publish.test.ts`
- Create: `docs/plans/2026-08-12-release-recovery-design.md`
- Create: `docs/plans/2026-08-12-release-recovery.md`

1. Run lint, type checking, unit tests, replay tests, build, and production audit.
2. Confirm `GH_REPO=madeupdev/madeup-video-course-cli gh release list` works outside a
   checkout.
3. Review the diff, commit, push, and open a focused draft PR.
4. After merge, manually dispatch Release with upstream run ID `31646322750` and verify
   the exact `v0.1.0` GitHub Release and assets.
