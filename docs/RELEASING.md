# Trusted release runbook

This document is for maintainers of `@madeup-video/course`. Learners should use
the exact commands supplied by the course and do not need these procedures.

## Security invariants

- Use GitHub-hosted runners only.
- Do not create or use an npm publication token.
- Do not add `NODE_AUTH_TOKEN` to a publication job.
- Keep the npm trusted publisher stage-only.
- Require a protected GitHub environment and human approval before staging.
- Require separate npm 2FA approval before a staged version becomes public.
- Build, inspect, checksum, stage, and release the same tarball.
- Never reuse a published or staged package version.
- Never create a release tag until the matching version commit is reviewed and
  merged to `main`.

## Current configuration

The repository and npm package are public. The GitHub environment is named
`npm` and permits only tags matching `v*`; exact SemVer is enforced again by the
workflow before any publication job runs. The environment requires review,
permits the maintainer to approve their own deployment, and does not permit an
administrator bypass.

The npm trusted publisher is:

- Provider: GitHub Actions
- GitHub owner: `madeupdev`
- Repository: `madeup-video-course-cli`
- Workflow filename: `publish.yml`
- Environment: `npm`
- Permission: `npm stage publish` only (`createStagedPackage`)

The workflow uses Node.js 24.18.0, pnpm 11.17.0, and npm 11.18.0. Its publication
job grants only `contents: read` and `id-token: write`.

## Safe dry run

Open **Actions → Publish → Run workflow** on any branch. A manual run is always
a dry run. It performs installation, lint, typecheck, the complete test suite,
recipe replay, build, production audit, packing, inspection, checksum
verification, and an installed-package smoke test.

A manual run cannot stage or publish npm content, mutate npm trust, create a
tag, create a GitHub Release, or change repository visibility. Confirm that the
run summary contains the explicit `DRY RUN` notice.

## Normal staged release

1. Update `package.json` to the new stable version in a focused pull request.
2. Run the full repository suite and inspect a real package archive.
3. Confirm `npm view "@madeup-video/course@VERSION" version` reports that the
   version does not exist.
4. Merge the reviewed version commit to `main`.
5. Obtain explicit approval to create the matching exact tag `vMAJOR.MINOR.PATCH`.
6. Create that tag on the intended merged `main` commit and push only the tag.
7. In GitHub Actions, review the waiting `npm` environment deployment and allow
   the stage job to proceed.
8. Confirm the Publish workflow stages exactly one inspected tarball through
   OIDC. Record the stage ID from its output.
9. Review the staged package on npmjs.com or with `npm stage view <stage-id>` and
   `npm stage download <stage-id>`.
10. Obtain explicit approval, then approve the stage with npm account 2FA.
11. Allow for npm's publish-time security scan before expecting the version to
    be installable. Do not publish the version again while scanning is pending.
12. If the Release workflow stopped while waiting for the npm version, rerun the
    failed Release workflow. It reuses the draft and exact upstream artifact.
13. Confirm the workflow verifies registry integrity and provenance before it
    publishes the GitHub Release.

The published GitHub Release must contain the exact `.tgz` and `SHA256SUMS` from
the Publish workflow. It must not independently rebuild the package.

## One-time bootstrap record

The package had to exist before npm could configure trusted publishing or stage
a version. Version `0.0.1` was therefore published manually with interactive
account authentication, public access, and provenance explicitly disabled. Its
verified archive SHA-256 is:

```text
5c797b8a76abb013c86736de71a933e4e4a0ba6df5ae374bd563d8797f459564
```

That exception is complete and must not be repeated. Version `0.0.1` cannot be
replayed through the tag workflow. All subsequent releases use the stage-only
trusted publisher and receive provenance from GitHub Actions.

## Hardening after the first trusted release

Only after the complete staged flow has succeeded:

1. Change npm package publishing access to **Require two-factor authentication
   and disallow tokens**.
2. Verify that the stage-only OIDC publisher still works on the next release.
3. Enable immutable GitHub Releases only after the release workflow has been
   proven to create and publish the intended draft correctly.

These are separate external-change checkpoints. Do not combine them with the
first trusted release merely for convenience.
