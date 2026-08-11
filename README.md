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

The `0.0.0-development` package must not be published.

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
pnpm pack:inspect ./madeup-video-course-0.0.0-development.tgz
```

CI runs the install, lint, typecheck, complete test suite, build, and package
dry run on Ubuntu, macOS, and Windows with Node.js 24.18.0 and pnpm 11.17.0.
The Ubuntu job additionally inspects the real tarball, installs that exact
archive into a clean temporary project, and runs
`pnpm exec madeup-video-course --help` from the installed package.

## License

This software is available for noncommercial use under the
[PolyForm Noncommercial License 1.0.0](LICENSE.md).

Required Notice: Copyright 2026 Robert Donnelly.
