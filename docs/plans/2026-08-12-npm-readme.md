# npm README Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the npm-facing README with concise learner documentation and preserve release operations in a maintainer runbook.

**Architecture:** Keep the repository root README as the exact document packed by npm. Move release procedures into `docs/RELEASING.md`, which remains public in GitHub but is excluded by the package file allowlist.

**Tech Stack:** Markdown, pnpm, Vitest, the existing package inspector and release-bundle validator.

---

### Task 1: Split learner and maintainer documentation

**Files:**
- Modify: `README.md`
- Create: `docs/RELEASING.md`

**Step 1:** Move the safe dry-run, bootstrap record, trusted-publisher identity, and release procedure into `docs/RELEASING.md` and update them to current state.

**Step 2:** Rewrite `README.md` around purpose, pre-release status, exact-version `pnpm dlx` usage, commands, safety, requirements, contributing, release-document link, and license.

**Step 3:** Check headings, links, stale statements, and whitespace.

Run: `rg -n "pending GitHub Support|0.0.0-development|npm publish release-bundle" README.md docs/RELEASING.md && git diff --check`

Expected: no stale pending-purge or development-version text; bootstrap command appears only as historical context if needed; whitespace check passes.

### Task 2: Verify repository and packed documentation

**Files:**
- Verify: `README.md`
- Verify: `docs/RELEASING.md`

**Step 1:** Run all repository gates.

Run: `pnpm install --frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test && pnpm test:replay && pnpm build && pnpm audit --prod`

Expected: every command passes with zero known production vulnerabilities.

**Step 2:** Create and inspect the exact package locally.

Run: `mkdir release-bundle && pnpm pack --pack-destination release-bundle && node scripts/release.ts prepare v0.1.0 release-bundle && node scripts/release.ts verify-bundle v0.1.0 release-bundle && node scripts/inspect-pack.ts release-bundle/madeup-video-course-0.1.0.tgz`

Expected: one verified tarball; package inspection passes; `README.md` and `LICENSE.md` are included; `docs/RELEASING.md` is excluded.

**Step 3:** Remove the reproducible local bundle, review the scoped diff, commit, push, and open a draft PR.
