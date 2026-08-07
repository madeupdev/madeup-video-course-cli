# `@madeup-video/course`

Course infrastructure for the Made Up Video advanced monorepos course. This
package is designed to deliver prepared code and support learner recovery; it
is not a general-purpose project scaffolder.

## Development status

This repository currently contains the CLI foundation, internal delivery
manifest validation and loading—including canonical course-tree inventories
and the narrow local-artifact policy—and a safe internal layer for inspecting
project identity, repository-relative files, fingerprints, and Git state.

The `doctor` command is implemented, wired through the executable, and covered
by tests. Given a registered course manifest, it locates the course project,
checks its identity and Git worktree, compares the managed tree with known
recovery states, reports file mismatches and available prepared steps, and
checks the pinned Node.js version.

The packed development version contains the compiled `doctor` implementation,
but it is not operational yet because the version-matched course manifest has
not been registered under `recovery/` and therefore is not bundled with the
package. Without that manifest, the command exits with a
course-manifest-unavailable diagnosis. The `apply` and `recover` commands are
not implemented yet.

The planned learner-facing interface is:

```text
apply <recipe>
apply <recipe> --dry-run
doctor
recover <state> --directory <new-directory>
```

This remains the intended learner-facing interface. Only `doctor` is currently
implemented, and it will become usable from the package once its version-matched
course manifest is bundled. The other learner-facing operations remain planned.

Do not publish `0.0.0-development` from this task.

## Toolchain

- Node.js 24.18.0
- pnpm 11.17.0
- TypeScript 6.0.3
- Vitest 4.1.10
- ESLint 9.39.5

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
```

Inspect the package that would be produced without publishing it:

```sh
pnpm pack:inspect
```
