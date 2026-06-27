# Homebrew tap

`brew install pendpost/tap/pendpost` for macOS and Linux users. The formula is a
thin wrapper over the published npm package (`depends_on "node"`), so there is no
separate binary to maintain: a release flows npm -> formula bump -> `brew upgrade`.

## One-time setup (owner)

1. Publish to npm first (`.github/workflows/release-npm.yml`). The formula points at
   the npm tarball, so the package must exist.
2. Create a public repo `pendpost/homebrew-tap`.
3. Copy `pendpost.rb` (next to this file) into it at `Formula/pendpost.rb`, and fill
   `url` + `sha256` for the published version (see the header in `pendpost.rb`).
4. Verify: `brew install --build-from-source pendpost/tap/pendpost && pendpost --version`.

## Keeping it current

Two options once the tap exists:

- Manual, per release: `brew bump-formula-pr --version=<v> pendpost/tap/pendpost`.
- Automated: add a workflow to this repo that runs on `release: published` and uses
  `dawidd6/action-homebrew-bump-formula` with a personal access token scoped to the
  tap repo (`HOMEBREW_TAP_TOKEN`). Left out of the repo until the tap and token exist,
  so there is no dangling, non-functional workflow.

The formula's `url`/`sha256` are the only per-release values; everything else is stable.
