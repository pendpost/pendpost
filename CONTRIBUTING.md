# Contributing to pendpost

Thanks for your interest in pendpost. This guide covers how to run it, the rules that keep it coherent, and what we will not merge.

## Running it

pendpost runs with zero credentials in mock mode. You do not need any real accounts to develop against it.

```bash
npm start            # boot the server on http://127.0.0.1:8090
npm run check        # run the full check: syntax, parity, and the test suite
```

The first run ships an example "Acme Launch" campaign so you have content to work with, and every platform lane runs through the credential-free mock driver. Drive the full loop `draft -> approve -> schedule -> publish -> insights` in mock mode before you touch live credentials. Build the dashboard with `npm run build` if it is not already built.

## Branching and releases

pendpost uses three long-lived branches:

- `develop` is the default branch where all changes integrate first. Open your pull requests against this branch.
- `staging` is a pre-release branch for verifying a batch of changes before release.
- `main` is the released branch. Releases are tagged here.

Work on a short-lived feature branch and open a pull request into `develop`. Changes promote in one direction only: `develop` to `staging` to `main`. Please do not open pull requests against `main` directly.

## Commit messages

pendpost follows [Conventional Commits](https://www.conventionalcommits.org). Prefix the subject with a type (`feat`, `fix`, `docs`, `refactor`, `test`, `chore`, or `ci`) followed by a short imperative summary, for example `fix: stop the cadence cap from dropping bursts`. Keep the subject under about 72 characters. This keeps the history readable and lets the release notes group changes by type. For a user-facing change, add a line under `## [Unreleased]` in `CHANGELOG.md`.

## The parity rule

Every capability ships on both faces: the JSON API (`/api`) and the MCP face (`/mcp`). If you add a write capability to one face, add it to the other. `test/parity-check.mjs` enforces this statically by reading the route table in `lib/api.mjs` (each entry carries an `mcpTool` key) and the tools array in `lib/mcp.mjs`, and it fails the build on any drift. If a capability is genuinely single-faced by design, document the exemption in `docs/plans/platform/API-CONTRACT.md` with a one-line justification. `npm run check` runs this for you.

## House style

- No em dashes or en dashes anywhere. Use a hyphen, a comma, or restructure. This is also a brand-lint rule that pendpost ships.
- English only.
- The brand name is always lowercase `pendpost`, even at the start of a sentence where possible. Never `PendPost` or `Pendpost`.

## Brand-lint rules

The brand-lint rule set lives in `rules.json`. To add a rule, append an object with an `id`, a `severity` (`error` blocks publish, `warn` is advisory), a `matcher` (a regex `{ "regex": ..., "flags": ... }` or a platform-aware built-in like `captionLength`, `hashtagCount`, `allCaps`, `brokenLink`), and a `hint`. To disable a rule, delete its object (or flip its severity to `warn`). A `rules.json` at the workspace root overrides the shipped default at the install root.

## Maintainer response time

pendpost is maintained part-time by a small team. We do read every issue and pull request, but please expect that reviews and replies can take a while. Clear reproduction steps and small, focused pull requests get merged fastest. For where to get help, see [SUPPORT.md](SUPPORT.md); for how the project is governed and how decisions are made, see [GOVERNANCE.md](GOVERNANCE.md).

## The one hard line

Never add code that posts without the approval gate. Publishing is fail-closed by design: a post with no approval must not publish, and the actor who created a post must not be able to approve it. Any change that weakens or bypasses the approval gate will be rejected.
