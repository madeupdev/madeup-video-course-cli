# Private installed recovery rehearsal

## Purpose

Exercise the installed learner CLI's real `recover` command for private draft states before publication. The current published package contract reads a version-matched manifest from its package and downloads immutable GitHub release assets. Draft states and assets must stay out of public manifests and releases.

## Options considered

1. Add manifest and local-archive flags to the learner command. This makes private inputs a permanent production surface and weakens the simple immutable-release contract.
2. Test `runRecover` directly with injected dependencies. This is useful unit coverage but does not exercise an installed CLI command.
3. **Chosen:** build a disposable, locally installed candidate package from the current CLI source, with a private manifest and edition version only in the temporary package. Intercept only its expected release-asset requests in the test process and return the exact private archive bytes. Invoke the installed `madeup-video-course recover` binary into fresh directories. The shipped learner command and public manifests stay unchanged.

## Data flow and evidence

Read the private register, select exactly the four Section 8 draft states, and build their deterministic archives with the production builder from canonical project commits. Independently derive each source-tree inventory from Git. Assemble a temporary candidate manifest with those inventories and the registered digests, validate it with the CLI schema, pack and install the candidate package locally, then run its binary for each state. A rehearsal-only Node preload supplies archive bytes only for the exact release URLs constructed by the manifest. The CLI still performs its normal digest check, extraction, tree verification, and new-directory rename. Independently compare every recovered file's bytes and mode with Git, and check that no extra file appears. Record package and archive digests, commands, and results.

This proves the installed recovery code path under local transport interception. It does **not** prove that the eventual published `1.0.0` package and GitHub release assets are correct. Repeat with the exact approved package and real release URLs at release stage. Native Windows and real WSL require their own hosts.

## Boundaries

The temporary package, manifest, archives, and recovered directories remain outside both source repositories. The tool does not write public manifests, push, tag, release, or publish. It fails on a digest mismatch, unexpected Git tree, invalid package manifest, existing destination, or missing state. Temporary files are removed after a run unless an explicit evidence directory is requested.
