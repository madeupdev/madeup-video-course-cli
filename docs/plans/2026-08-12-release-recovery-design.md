# Trusted Release Recovery Design

## Problem

The checkout-free Release workflow invokes `gh release` without repository context. The
successful `v0.1.0` Publish run therefore could not create its GitHub Release. A rerun
cannot consume a workflow fix merged later because GitHub reruns use the original
workflow commit.

## Design

Set `GH_REPO` from `github.repository` for every GitHub CLI release operation. Add a
manual recovery trigger whose only input is the numeric upstream Publish run ID. For
both automatic and recovery events, resolve trusted upstream metadata into one set of
job outputs before downloading an artifact.

Recovery queries the Actions API and rejects the run unless it belongs to this
repository, is the `Publish` workflow, was triggered by a tag push, completed
successfully, and exposes a valid semantic-version tag and commit SHA. The remaining
release path stays shared: download the named artifact from that exact run, verify its
checksum and packed package metadata, create or reuse a draft, compare the archive to
npm integrity and provenance evidence, and only then publish the GitHub Release.

## Testing

Static workflow tests require explicit repository context, the minimal manual input,
the upstream API validation rules, and normalized metadata outputs consumed by all
later steps. Existing tests continue to enforce checkout-free artifact reuse, immutable
actions, narrow permissions, checksum validation, and registry evidence gates.
