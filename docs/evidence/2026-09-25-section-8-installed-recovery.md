# Section 8 private installed CLI rehearsal

Run on 2026-09-25 from `codex/private-installed-recovery-rehearsal` on Darwin arm64 with Node 24.18.0. The runner selected exactly four `draft` states from the private authoring register, built their archives with the production builder against canonical project history, made a temporary edition `1.0.0` candidate package, installed its tarball into a disposable directory, and invoked that installed package's `dist/cli.js recover` entry point. The package and private manifest were removed after the run. Neither public manifest changed.

The candidate package SHA-256 was `25b3d7098fc7b2a382f32f2532b29fb2b8ae866bf583bc445fd0dc2697ad3f4a`. A rehearsal-only Node preload answered only the four exact GitHub release URLs from the temporary manifest with the local archive bytes. The installed CLI itself checked archive digests, extracted each archive, verified the manifest tree, and recovered into a new directory. A separate runner comparison checked every recovered file's SHA-256 and, on this host, mode against the Git source commit. Each state was recovered twice:

| State | Git source | Registered and rebuilt archive SHA-256 | Files checked per recovery |
| --- | --- | --- | ---: |
| `S08-L01-suite-ownership` | `0be47ede1ed4f107f86adcfdd1947031a8d8ae5e` | `76cf1b21919e71a965cb4ca7968ea5a55b7786c61b7c1419622b1da07c95c88e` | 152 |
| `S08-L02-affected-selection` | `7ebc0924e63d8b9ed6b08df3e71a60861ddb5615` | `40327b07b81fc9ddd52e7f91fae9802749123d6a3cf6cfa89c8f0d3c88281cb0` | 154 |
| `S08-L03-cache-integrity` | `8792799489ff437021de19768535bf27057edd24` | `0a5deee6d3b0e29c9ca64b215764734a6aae0b8a5bf8367abf1c4e8fd8ace1d3` | 159 |
| `S08-final` | `833e3dafa44335a3c52e57fdd17ae39e82e9934d` | `e1d51526077880aab55ee51484756bdbcc103b84f96dce06f49ee7520027373f` | 162 |

The installed command refused an existing destination without altering it. With a wrong digest in the disposable installed manifest, it rejected recovery and left no destination.

This is **GREEN for the private installed candidate on macOS**. It is not evidence for the future published package or actual GitHub asset delivery: the candidate's manifest was privately assembled, its package version was changed only in the temporary copy, and asset transport was intercepted locally. After release approval, install and test the exact published package against real release URLs. Native Windows and real WSL remain open host-specific gates. No tag, release, public-manifest update, publishing, push, or lecture recording was performed.

Verification after the runner change: CLI Vitest suite 506/506 across 24 files; the runner's Node guard test 1/1; lint, typecheck, build, and `git diff --check` passed. The initial Vitest run inside the filesystem/network sandbox timed out on loopback recovery tests; a fresh full run with loopback available passed. Both existing public manifest files still matched their repository `HEAD` bytes (`8d5bcd1858825ab3ede0f726587ccb7269c21c55e74c19833152976f64077d38`).

Reproduce with `corepack pnpm build` followed by `node scripts/rehearse-installed-recovery.mjs --project <canonical-project-checkout> --register <private-authoring-register>`. The runner writes its JSON result to standard output and deletes the disposable installation on completion.
