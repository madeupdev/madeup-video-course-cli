# `@madeup-video/course`

Course infrastructure for the Made Up Video advanced monorepos course. This
package is designed to deliver prepared code and support learner recovery; it
is not a general-purpose project scaffolder.

## Development status

This repository contains the CLI foundation, internal delivery manifest
validation and loading—including canonical course-tree inventories and the
narrow local-artifact policy—and a safe internal layer for inspecting project
identity, repository-relative files, fingerprints, and Git state.

The following learner-facing commands are implemented:

```text
apply <recipe>
apply <recipe> --yes
apply <recipe> --dry-run
doctor
```

`apply` validates the complete change plan before writing, prints a
deterministic preview, and requires either interactive consent or the explicit
`--yes` option. It applies additions, replacements, and deletions as a
transaction, verifies resulting hashes and modes, rolls changes back after a
failure, and recognises an already-applied recipe without writing again.
`--dry-run` performs the strict preflight and preview without changing files.

The `doctor` command is implemented, wired through the executable, and covered
by tests. Given a registered course manifest, it locates the course project,
checks its identity and Git worktree, compares the managed tree with known
recovery states, reports file mismatches and available prepared steps, and
checks the pinned Node.js version.

`recover <state> --directory <new-directory>` downloads the exact immutable
release asset declared for a recovery state, enforces the fixed GitHub redirect
policy and manifest size limit, verifies the asset digest, inspects every
archive header, extracts into a temporary sibling, verifies the complete tree,
and only then renames it to a destination that did not already exist.

Recovery manifests declare the maximum permitted compressed asset size at the
release level. The value is a required safe positive integer in bytes:

```json
{
  "release": {
    "repository": "https://github.com/madeupdev/madeup-video-storefront",
    "tag": "course-v1.0.0",
    "maxAssetBytes": 104857600
  }
}
```

The packed development version contains the compiled `apply`, `doctor`, and
`recover` implementations. It remains non-operational for real course projects
until the version-matched course manifest and its prepared-code and recovery
assets are registered and bundled with the package. Without that manifest,
commands exit with a course-manifest-unavailable diagnosis.

The complete intended learner-facing interface is:

```text
apply <recipe>
apply <recipe> --yes
apply <recipe> --dry-run
doctor
recover <state> --directory <new-directory>
```

Versions containing the `development` prerelease label must not be published.

## Toolchain

- Node.js 24.18.0
- pnpm 11.17.0
- TypeScript 6.0.3
- Vitest 4.1.10
- ESLint 9.39.5
- tar-stream 3.2.0

The runtime and package-manager versions are pinned in `.tool-versions` and
`package.json`. Exact development dependency versions are recorded in
`package.json` and `pnpm-lock.yaml`.

## Local development

Install the pinned tools with asdf, then install dependencies from the
lockfile:

```sh
asdf install
pnpm install --frozen-lockfile
```

Run the project checks:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm pack --dry-run
```

Create and inspect the actual package tarball without publishing it. Pass the
exact path printed by `pnpm pack`; the inspector reads the tarball itself and
fails if required runtime/recovery files are missing or if unsafe, private,
sensitive, source, test, fixture, environment, or temporary-archive content is
present:

```sh
pnpm pack
pnpm pack:inspect ./madeup-video-course-0.0.1.tgz
```

CI runs the install, lint, typecheck, complete test suite, build, and package
dry run on Ubuntu, macOS, and Windows with Node.js 24.18.0 and pnpm 11.17.0.
The Ubuntu job additionally inspects the real tarball, installs that exact
archive into a clean temporary project, and runs
`pnpm exec madeup-video-course --help` from the installed package.

## Trusted publication

Release automation uses Node.js 24.18.0, pnpm 11.17.0, and npm 11.18.0 on
GitHub-hosted runners. The Publish workflow installs from the frozen lockfile,
runs every repository gate and the production audit, creates exactly one
tarball, inspects it, smoke-tests it, and verifies `SHA256SUMS`. A tag is
accepted only when it is exact `vMAJOR.MINOR.PATCH` and exactly matches the
package version. A duplicate registry version is rejected before staging.

No npm token, `NODE_AUTH_TOKEN`, or long-lived publication credential is used.
For automated releases, the exact verified tarball is submitted through OIDC
with `npm stage publish`. A maintainer reviews and approves it with 2FA. The
Release workflow downloads that same upstream artifact, creates or reuses a
draft GitHub Release, and publishes the draft only after the npm registry's
integrity and provenance evidence match the tarball.

### Safe dry run

After this workflow is present on the default branch, open
**Actions → Publish → Run workflow**. A manual run is always a **DRY RUN**: it
performs installation, lint, typecheck, the full test suite, recipe replay,
build, production audit, packing, inspection, checksum verification and the
installed-package smoke test. It cannot publish or stage npm content, mutate
npm trust, create a tag, create a GitHub Release, or change repository
visibility. Pull requests also exercise the workflow validation tests through
normal CI without receiving publication or release permissions.

### One-time package bootstrap

There is an unavoidable registry bootstrap exception. `npm stage publish`
cannot create a new package, and `npm trust` requires an existing package.
Therefore `@madeup-video/course` must first be published manually from the
exact locally inspected and checksummed archive with interactive account 2FA.
No npm token is needed or permitted. Because npm provenance must originate in a
supported cloud CI environment and link a public GitHub repository and a public
npm package, the bootstrap version cannot have npm provenance.

The one-time bootstrap version is `0.0.1`. It is published under the
`bootstrap` dist-tag so this unavoidable non-provenance package does not become
the default `latest` install. The first automated OIDC release will be `0.1.0`.

Only after every checkpoint below is approved, run the full local gates. The
manual bootstrap publication command must target the exact archive already
inspected and checksummed; `--provenance=false` explicitly overrides this
repository's normal trusted-publication setting for this one unavoidable local
publication:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm test:replay
pnpm build
pnpm audit --prod
mkdir release-bundle
pnpm pack --pack-destination release-bundle
node scripts/release.ts prepare v0.0.1 release-bundle
node scripts/release.ts verify-bundle v0.0.1 release-bundle
npm publish release-bundle/madeup-video-course-0.0.1.tgz --access public --tag bootstrap --provenance=false
```

The final command is an external mutation and must not be run without explicit
approval at that checkpoint. The first automated OIDC release must use `0.1.0`
or another later, previously unpublished version; the bootstrap version cannot
be replayed through the tag workflow.

### Trusted-publisher configuration

After the package exists, create the protected GitHub `npm` environment and
configure one npm trusted publisher with these exact values:

- Provider: GitHub Actions
- GitHub owner: `madeupdev`
- Repository: `madeup-video-course-cli`
- Workflow filename: `publish.yml`
- Environment: `npm`
- Allowed action: `npm stage publish` only (stage-only)

Stage-only permission deliberately retains a human proof-of-presence gate.
Direct OIDC publication would be simpler and faster, but it would allow the
workflow to make a version public without separate human 2FA approval. After a
staged release succeeds, set package publishing access to require 2FA and
disallow tokens. July 2026 npm changes make bypass-2FA tokens unsuitable for
account/package administration and are removing their direct-publish role; the
workflow does not create or depend on one.

For each automated release, update `package.json` to a new stable version,
merge the reviewed commit, then create and push the matching exact tag. The
Publish workflow stages the archive. Approve the staged npm package in npmjs.com
or interactively with `npm stage approve <stage-id>`. If the Release workflow
has already stopped at its approval gate, rerun the failed `Release` workflow.
It will reuse the draft and exact upstream artifact, verify registry integrity
and provenance, and then publish the GitHub Release.

### External-change checkpoints

Stop and obtain explicit approval separately before each action:

1. Confirm the private-email history purge has completed.
2. Make the repository public.
3. Perform the first npm publication with the exact bootstrap tarball and 2FA.
4. Create the protected GitHub environment named `npm`.
5. Configure the npm trusted publisher with the exact stage-only identity above.
6. Disable token publication only after the trusted staged flow is proven.
7. Enable immutable GitHub Releases only after the release flow is proven.
8. Create and push the first automated release tag.
9. Approve the staged npm package and permit the draft release to be published.

The pending GitHub Support history purge currently blocks checkpoints 2–9 and
all provenance-bearing publication. It does not block review, CI, or a safe
dry-run PR.

## License

This software is available for noncommercial use under the
[PolyForm Noncommercial License 1.0.0](LICENSE.md).

Required Notice: Copyright 2026 Robert Donnelly.
