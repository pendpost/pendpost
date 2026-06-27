# Changelog

All notable changes to pendpost are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and pendpost adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.1] - 2026-06-27

### Added
- 24/7 Cloud-Service in-app purchase: compare plans, review the order, open secure checkout, and return to an active plan without leaving the app, with graceful cancel handling. The website deep-links a chosen plan straight into the app (`/download?plan=<tier>`).
- A cloud account menu on the real account identity: manage billing (Stripe portal), manage account (Clerk), a lightweight reversible sign-out/switch, and an explicit sign-in entry — with the heavier "eject to self-host" kept separate.

### Added (always-on foundation)
- Always-on self-host: deploy templates for Fly.io, Railway, and Render (`deploy/`) and an always-on self-host guide, so Instagram, LinkedIn, and X publish on schedule even when your computer is off.
- An optional in-server bearer-token auth gate that activates only when `PENDPOST_HOST` is non-loopback and `PENDPOST_AUTH_TOKEN` is set; the loopback default stays no-auth and unchanged. `PENDPOST_PUBLIC_HOST` extends the host allowlist for a public deployment, and `GET /api/health` is exempt so platform health checks work.
- A cloud-ready publish-job seam: `lib/publish-job.mjs` builds a versioned, approval-proof publish-job envelope that a separate always-on runtime can consume, with a second approval fence that refuses unapproved or self-approved posts. The contract is documented in `docs/specs/cloud-integration-contract.md`.
- More ways to install: a published container image on GHCR (`docker run -p 8090:8090 ghcr.io/pendpost/pendpost`, no clone needed) and a Homebrew tap (`brew install pendpost/tap/pendpost`). Release automation publishes the npm package with provenance and the image when a GitHub release is cut (`.github/workflows/release-npm.yml`, `release-image.yml`).

### Changed
- The dashboard and marketing copy now make the per-platform power-off truth explicit: Facebook and YouTube schedule natively and fire even when your computer is off, while Instagram, LinkedIn, and X need pendpost running. The post detail shows a per-platform delivery hint and the schedule badges carry a one-line tooltip.
- The publish scheduler now dispatches through the publish-job envelope. Publish behavior is byte-identical (covered by the existing mock-loop and concurrency tests).

## [1.0.0] - 2026-06-19

The first public-ready release. pendpost is a local-first, MCP-native social planner: an agent drafts, schedules, and publishes for Facebook, Instagram, LinkedIn, YouTube, and X, and runs the loop autonomously once you trust it, with a human approval gate and anti-ban brakes you control.

### Added

- X (Twitter) as a first-class publishing lane: OAuth 1.0a request signing (verified offline against X's documented signature example) and OAuth 2.0 token refresh on both the dashboard and the MCP face.
- Guarded client-lifecycle MCP tools (`client_create`, `client_update`, `client_archive`, `client_set_active`), fail-closed behind `actor:"owner"` + `confirm:true` and never touching a credential value, so client administration is agent-operable without widening the credential boundary.
- A header language toggle (English / Swiss German) that switches the UI live, and a Settings time-format preference (automatic / 24-hour / 12-hour); Swiss German always renders 24-hour.
- Creating your first real client now promotes it to the active workspace and retires the empty starter default, so posts never land on the wrong project.
- A repo-root `AGENTS.md`, generated from the per-platform onboarding playbooks (`lib/playbooks.mjs`) and guarded by a freshness check in `npm run check`, so an agent can drive per-platform setup from the file alone.
- A per-platform **Copy AI prompt** action on the Setup page that copies a self-contained, secret-safe Claude-for-Chrome prompt for connecting that platform.

### Changed

- Accessibility and design coherence: a shared Tab focus trap on the slide-over and confirm/prompt dialogs (safe alongside nested Radix popovers), status and approval pills that lead with an icon so meaning never rests on color alone, and full-width data-dense tabs.
- The Clients page collapses its duplicated overview and admin table into one row per client (identity, status, health, and actions together).
- Marketing site: an autonomy-forward hero and a three-load-bearing-differentiators hierarchy (the gate, the brakes, the editor) set apart from the two supporting ones.
- Upstream references removed from the shipped surface toward the open-source release; the runtime is unchanged (account identifiers resolve from per-client `.env`).

## [0.4.0] - 2026-06-16

### Added

- Local multi-client / multi-workspace management. One pendpost instance manages several clients, each owning its own credentials, plans, brand rules, schedule, circuit-breaker state, insights, and activity log. A first-class `Client` entity (a `data/clients.json` registry plus `data/clients/<id>/` subtrees), an idempotent zero-loss boot migration of an existing single-workspace install into a `default` client, a `client_list` MCP read tool, a sidebar client switcher with an unmistakable active-client indicator, and Clients admin plus per-client Keys pages in the dashboard. Per-client theming via a CSS-variable accent layer.
- Per-client isolation guarantee: no client's keys, plans, breaker state, or activity can leak into another. Every MCP tool accepts an optional `clientId`; client lifecycle and active-context switching are operator-only dashboard actions, recorded as documented parity exemptions so they are never agent-accessible.
- Founder dashboard requests: color-coded scheduled-time chips (approved / needs-approval / halted, paired with an icon and an accessible name, never color alone), tooltips on every icon-only control, stories preview parity with reels, and interactive story elements (poll, question, link, mention, location, hashtag, music stickers) plus per-post hashtag overrides.
- Extensibility seams: an optional `drivers/registry.json` to add a platform driver without forking, a `PENDPOST_<LANE>_ENGINE` override for a custom publish engine, and per-client brand-rule profiles.
- i18n readiness: a locale-pack seam (a `t()` lookup, an English baseline catalog, and a `de-CH` example pack with fallback to English), wired through the multi-client UI.
- A frontend test suite (Vitest, React Testing Library, jest-axe) and expanded backend coverage (security, audit, anti-ban circuit breakers, supply-chain, and the pre-publish brand-lint gate).

### Changed

- The MCP surface grows to 32 tools (adds `client_list`); the parity check now also asserts that every write tool accepts an optional `clientId`.
- The publish path enforces the brand-lint error gate before every publish (an error-severity caption is blocked fail-closed; warnings stay advisory).
- The lane-pause kill switch now yields a clean no-op in mock mode as well as live.

## [0.3.0] - 2026-06-15

### Added

- Human approval gate. Every post carries an approval state and is fail-closed: a post with no approval never publishes. There is no self-approval, so the actor who created a post cannot approve it; the owner is exempt.
- Anti-ban circuit breakers: a Meta error 368 breaker that halts the Meta lane and never auto-resumes, a cadence cap that defers bursts rather than dropping them, and a lane pause kill switch.
- Humanizer brand-lint. Captions are checked before publish against editable rules in `rules.json`, which flag English AI-writing tells. Errors block publish; warnings are advisory.
- Native scheduling where the platform supports it.
- Dual interface: a web dashboard and an MCP server (31 tools), with a parity test that enforces every capability ships on both the `/api` and `/mcp` faces.
- Mock mode. The full `draft -> approve -> schedule -> publish -> insights` loop runs with zero credentials.
- Publish engines for Facebook, Instagram, LinkedIn, and YouTube.
- Docker support.

[Unreleased]: https://github.com/pendpost/pendpost/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/pendpost/pendpost/compare/v0.4.0...v1.0.0
[0.4.0]: https://github.com/pendpost/pendpost/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/pendpost/pendpost/releases/tag/v0.3.0
