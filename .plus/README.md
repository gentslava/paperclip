# Paperclip plus

This branch contains the integrated application source and the build configuration for
`ghcr.io/gentslava/paperclip:plus`. The application and prior config histories are both
preserved by a merge; compatible PR commits remain reachable through this branch.

`.github/workflows/plus.yml` retains the daily schedule and manual builds:

1. Clone fresh upstream `paperclipai/paperclip` `master`, or the exact `upstream_sha`
   supplied with `expected_tree` for a qualified manual build.
2. Merge the open PRs in `prs.txt` in order. `N` fetches upstream `pull/N/head`;
   `N@<full commit SHA>` fetches a compatible fork commit preserved in this branch's
   history. Legacy `N@branch` entries remain supported. Merged/closed PRs are skipped.
3. Apply `fixups/*.patch`; an obsolete patch is skipped with a warning.
4. Refresh the lockfile and verify the complete source tree against `expected_tree`
   when supplied. This tree belongs to the freshly composed build source, not this
   branch's additional `.plus` files or fork workflow configuration.
5. Build the upstream `Dockerfile` production target and publish the existing `plus`
   and dated tags with the upstream, source revision and selected-PR labels.

The workflow still does not push source commits or update this branch. A conflict
fails the run and retains the last good image. Upstream release, provider-evaluation
and other workflows are omitted here; the existing plus workflow is the fork's only
active workflow. No replacement patch branches or tags are needed.

The qualified source baseline is `716b64c0f60caa319d2a797b51ab0c0768637bbd`
(upstream `970127a0220d3145efe2111b0643aaa883cb162f`, composed build tree
`b929f06a42f88df2011788eaaa6ed14abb080dfa`). Later upstream updates require
their own validation; baseline test results do not qualify later application changes.
