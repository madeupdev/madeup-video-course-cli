# `@madeup-video/course`

Prepared-code delivery and project-recovery tooling for the Made Up Video
advanced monorepos course.

This package is built specifically for the course. It is not a general-purpose
project scaffolder.

## Course availability

Run only the exact package version shown in your course materials. Course
commands pin a full version so that recipes, expected project states, and
recovery assets remain in sync.

The current `0.x` packages are infrastructure previews. They do not contain a
version-matched course delivery manifest and are not ready for course exercises.

## Requirements

- Node.js 24.18.0
- pnpm 11.17.0

The course project pins these versions. Run commands from the course project
unless the course directs you otherwise.

## Usage

The course provides copy-and-paste commands with an exact version:

```sh
pnpm dlx @madeup-video/course@COURSE_VERSION doctor
```

Do not replace `COURSE_VERSION` with `latest`; use the version printed in the
course lesson.

### Check your project

```sh
pnpm dlx @madeup-video/course@COURSE_VERSION doctor
```

`doctor` checks that you are in the correct course project, inspects the Git
worktree and managed files, identifies a known course state, reports mismatches,
and lists prepared steps available from that state.

### Apply prepared code

Preview a recipe without changing files:

```sh
pnpm dlx @madeup-video/course@COURSE_VERSION apply RECIPE --dry-run
```

Apply it with an interactive confirmation:

```sh
pnpm dlx @madeup-video/course@COURSE_VERSION apply RECIPE
```

When the course explicitly calls for non-interactive use:

```sh
pnpm dlx @madeup-video/course@COURSE_VERSION apply RECIPE --yes
```

`apply` validates the complete plan before writing, prints a deterministic
preview, applies additions, replacements, and deletions as a transaction, and
verifies the resulting hashes and file modes. If an operation fails, it attempts
to restore the original tree. Applying an already-completed recipe is a no-op.

### Recover into a new directory

```sh
pnpm dlx @madeup-video/course@COURSE_VERSION recover STATE \
  --directory ../made-up-video-recovered
```

Recovery never overwrites the current project or an existing destination. It
downloads the immutable asset registered for the requested state, verifies its
digest and archive structure, extracts it into a temporary sibling directory,
verifies the complete tree, and only then moves it into place.

## Safety model

- Exact course and CLI versions remain aligned.
- Commands refuse an unexpected project identity or unsafe path.
- `apply` refuses a dirty Git worktree and validates all writes in advance.
- Recovery assets are size-limited, checksummed, and extracted safely.
- Recovery always targets a new directory, preserving the learner's work.

## Development

Install the pinned tools and dependencies, then run the repository checks:

```sh
asdf install
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Release maintainers should follow the
[trusted release runbook](https://github.com/madeupdev/madeup-video-course-cli/blob/main/docs/RELEASING.md).

## License

This software is available for noncommercial use under the
[PolyForm Noncommercial License 1.0.0](https://github.com/madeupdev/madeup-video-course-cli/blob/main/LICENSE.md).

Required Notice: Copyright 2026 Robert Donnelly.
