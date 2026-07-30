# `@madeup-video/course`

Course infrastructure for the Made Up Video advanced monorepos course. This
package is designed to deliver prepared code and support learner recovery; it
is not a general-purpose project scaffolder.

## Development status

This repository currently contains the CLI foundation, internal delivery
manifest validation and loading—including canonical course-tree inventories
and the narrow local-artifact policy—and a safe internal layer for inspecting
project identity, repository-relative files, fingerprints, and Git state. The
executable supports `--help`, but no learner-facing course operation is
implemented yet. In particular, recipes and recovery states cannot be applied,
diagnosed, recovered, or created by this development version.

The planned learner-facing interface is:

```text
apply <recipe>
apply <recipe> --dry-run
doctor
recover <state> --directory <new-directory>
```

These commands are documented as the intended interface only. They are not
currently usable.

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
