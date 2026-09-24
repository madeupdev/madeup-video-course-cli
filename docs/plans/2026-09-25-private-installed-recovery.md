# Private Installed Recovery Implementation Plan

**Goal:** Rehearse all four private Section 8 states through a disposable installed candidate package without publishing draft metadata or assets.

**Architecture:** A development-only runner selects four draft states from the private register, calls the production archive builder, derives Git tree inventories, installs a temporary edition-matched package, and runs its real `recover` binary with a narrowly scoped local asset transport preload. It independently compares recovered files with their Git commits and emits a bounded evidence report.

**Tech stack:** Node.js 24, TypeScript/JavaScript, npm package tarball, Git, Vitest.

---

### Task 1: Input and inventory gates

**Files:** `scripts/rehearse-installed-recovery.mjs`, `tests/scripts/rehearse-installed-recovery.test.ts`

1. Write tests that reject missing, non-draft, and non-Section-8 states and that derive exact bytes and modes from a fixture Git commit.
2. Run the focused tests and observe RED.
3. Implement strict four-state selection and Git inventory derivation.
4. Run the focused tests and observe GREEN.

### Task 2: Disposable installed package

**Files:** `scripts/rehearse-installed-recovery.mjs`, `tests/scripts/rehearse-installed-recovery.test.ts`

1. Write a test for package/manifest version agreement and rejection of public-manifest writes.
2. Observe RED, then implement temporary package creation and installation from a local tarball.
3. Add a preload that maps only the manifest's four expected HTTPS release URLs to exact local archive bytes.
4. Observe GREEN with an installed binary invocation, including digest failure cleanup.

### Task 3: Four-state evidence

**Files:** `scripts/rehearse-installed-recovery.mjs`, `docs/evidence/2026-09-25-section-8-installed-recovery.md`

1. Run the production builder for the four-state private register subset.
2. Invoke the installed binary into a new directory for each state; compare digest, source commit, bytes, modes, and file set independently with Git.
3. Record package digest, checks, host, and precise transport limitation.
4. Run CLI tests, build, lint, typecheck, diff check, and confirm all repositories' public manifests are unchanged.
5. Commit the isolated CLI branch with a conventional message. Do not push or publish without a separate instruction.
