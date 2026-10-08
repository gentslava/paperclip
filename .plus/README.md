# Paperclip plus

This branch holds only the build config for `ghcr.io/gentslava/paperclip:plus`:
upstream `paperclipai/paperclip` `master` + the PRs in `prs.txt` + the patches in `fixups/`.

`.github/workflows/plus.yml` runs every night (and on demand: Actions → plus → Run workflow):

1. Clone fresh upstream `master`.
2. Merge each PR from `prs.txt` (`pull/N/head`). Merged or closed PRs are skipped.
   A line `N@branch` merges our own rebase of PR N from `branch` in this repo instead, for a PR that
   conflicts with `master` while its author has not updated it. Once N is merged or closed upstream,
   the line is skipped like any other, so the copy retires by itself.
3. Apply `fixups/*.patch` (small follow-ups for PRs that drifted from `master`). A patch that no longer applies is skipped with a warning.
4. Build the upstream `Dockerfile` (`production` target) and push `ghcr.io/gentslava/paperclip:plus` and `:plus-<date>-<upstream sha>`.

Nothing is pushed back to the repo. The image labels `dev.gentslava.plus.upstream` and `dev.gentslava.plus.prs` record what went in.
If a PR stops merging cleanly, the run fails and the last good `:plus` image stays in place.

To add or drop a PR, edit `prs.txt` and run the workflow.
