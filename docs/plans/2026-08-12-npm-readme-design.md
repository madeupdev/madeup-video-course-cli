# npm README design

## Goal

Make the package README useful and credible on npm while preserving the public
release-operational documentation for maintainers.

## Approaches considered

1. Add a quick-start section above the existing README. This is the smallest
   change, but leaves stale bootstrap status and a long operator runbook on the
   npm landing page.
2. Use a generated, package-only README during packing. This can tailor npm and
   GitHub independently, but adds release-time file mutation and makes the
   inspected source harder to compare with the published archive.
3. Keep one concise learner-facing README and move maintenance procedures to
   `docs/RELEASING.md`. This keeps the packed README identical to the reviewed
   repository README and gives each audience a clear document.

Approach 3 is selected.

## README structure

The README will lead with the package's course-specific purpose and its current
pre-release status. It will state that learners should use only the exact
version shown in their course materials and demonstrate the intended
`pnpm dlx @madeup-video/course@VERSION` form without suggesting `latest`.

It will summarize `apply`, `doctor`, and `recover`, explain their safety model,
list the pinned Node requirement, link to contributor and release information,
and retain the PolyForm Noncommercial license notice. It will not imply that
version `0.1.0` contains a usable course manifest when it does not.

## Release documentation

`docs/RELEASING.md` will contain the safe dry run, trusted-publishing design,
one-time bootstrap record, current trusted-publisher identity, and the ongoing
release procedure. Completed historical checkpoints will be marked as such;
stale claims about a pending history purge will be removed.

## Validation

Static workflow tests will continue to validate release behavior. The full
repository suite will run, and a real `0.1.0` tarball will be inspected to prove
that the concise README and license are packed while internal `docs/` content is
not included in the npm package.
