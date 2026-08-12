# Trusted npm Publication Design

## Goal

Publish `@madeup-video/course` without a long-lived npm credential, preserve the
exact inspected archive from build through GitHub Release, and require a human
2FA approval for every automated release after bootstrap.

## Registry bootstrap

npm staged publishing, trusted-publisher configuration, and `npm trust` require
an existing registry package. The first version therefore cannot use the final
OIDC path. After the repository-history purge is confirmed and the repository
is public, a maintainer will build, inspect, checksum, and manually publish the
exact tarball with interactive account 2FA. No token will be created or placed
in GitHub. This bootstrap publication will not have npm provenance because it
cannot originate from the future trusted GitHub Actions publisher.

Once the package exists, the maintainer will create the GitHub `npm`
environment and configure the package's trusted publisher for
`madeupdev/madeup-video-course-cli`, workflow `publish.yml`, environment `npm`,
with only `npm stage publish` permission. Token publishing can then be disabled
at package level.

## Automated publication

`publish.yml` supports tag pushes and a safe manual dry run. Its build job has
only `contents: read`, checks out without persisted credentials, installs the
pinned Node and pnpm toolchain without dependency caching, installs from the
frozen lockfile, and runs lint, typecheck, the full suite, build, recipe replay,
production audit, exact packing, inspection, smoke installation, and checksum
verification. A local validator enforces an exact `vMAJOR.MINOR.PATCH` tag and
an exact package-version match. The job produces exactly one tarball and one
`SHA256SUMS` artifact.

The publication job runs only for a validated tag push, uses the protected
`npm` environment, and adds only `id-token: write` to `contents: read`. It
downloads and re-verifies the build artifact, rejects a version already visible
on npm, and submits the exact tarball using npm 11.15 or newer and
`npm stage publish`. Manual dispatch never reaches this job.

## GitHub Release

`release.yml` is triggered only after a successful tag-driven Publish workflow.
It uses `contents: write` solely to manage the matching GitHub Release. It
downloads the artifact from the exact upstream run, validates the upstream
repository, event, commit, and tag, verifies the checksum and archive metadata,
then creates or reuses a draft release containing that tarball and checksum.

Because staging and human approval are asynchronous, the first run is expected
to leave the release as a draft until the version becomes visible in the public
registry. Rerunning the release workflow after 2FA approval reuses the same
upstream artifact, verifies npm's registry integrity and provenance evidence,
and publishes the draft. It never rebuilds the package. Existing live npm
versions prevent a publication rerun; existing published GitHub Releases are
treated idempotently and never replaced.

## Validation and security

Focused tests parse the workflows and exercise local release validators before
the workflow files are introduced. The validators reject loose tag matches,
development versions, mismatched archive names, multiple archives, incorrect
checksums, and unsafe upstream workflow metadata. Pull-request code never runs
in a workflow with OIDC or release-write permission. Third-party actions are
pinned to full commit SHAs.

No implementation step changes repository visibility, npm trust, publishing
access, tags, releases, or registry contents. Each external mutation remains a
manual checkpoint.
