# Changelog

All notable changes to pendpost are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and pendpost adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.4.0] - 2026-07-08

### Added
- Backstop publish-claim gate for always-on. The cloud worker and the local overdue-backstop are two independent firers of the same job; both now assert one shared atomic publish-claim lease before firing, so a double-post is structurally impossible even when the machine wakes mid-fire. It fails open when the cloud is unreachable, so a self-hosted install behaves exactly as before.
- Read-only cloud observability over MCP. Four new read-only tools — `cloud_status`, `cloud_capabilities`, `cloud_clients`, and `cloud_subscription` — mirror the `GET /api/cloud*` routes so an agent can inspect cloud state with no secret and no confirm gate (API-key presence only, never the key itself).
- Single edit surface for a post. The post detail is now the one place a post is edited; a single-lane post (X, Mastodon, or Nostr only) shows one "Post text" field instead of a caption/override split, and the sidebar's next-post pill shows the platform glyph, the day and time, and a one-line content preview.

### Fixed
- X thread replies now thread correctly when fired as separate jobs. A reply job resolved its parent against a plan snapshot frozen before the parent tweet existed, so it fail-closed with an empty envelope. The parent id is now resolved at fire time, and an unresolvable parent emits a structured `parent_unpublished` (deferred, retryable) or `parent_missing` (terminal) result instead of a silent skip.
- UX-audit pass across 15 screens: collapsed status a11y and summary copy (Setup), a NaN guard and subtitle gating (Cloud), a single schedule control and auto-growing text areas (post detail, composer, thread composer), an exceptions-only health cell (Clients), timezone auto-save (Settings), and header and empty-state polish (Insights, Assets, Activity, Published, Planner).
- The planner readiness checklist no longer leaks raw shell commands into its blocker rows; the rows still deep-link to Setup, which is the actual next step.
- Honest, cloud-scoped delivery labels: the planner banner and the cloud popover no longer share one "undelivered" label for two different counts, and the duplicate active-client chip and reused labels across post detail, clients, and cloud are disambiguated.

## [1.3.0] - 2026-07-07

### Added
- Thread composer for X. Plan a whole X thread as one artifact — draft every reply in a single editor, reorder the tweets, and schedule the chain as one unit instead of stitching separate `xReplyTo` posts by hand.
- Platform-aware post detail. The detail dialog now shows only the fields each network actually publishes — no more editing a caption a platform will never use. It opens as a centered two-column layout with state-aware actions and keyboard triage, supports inline caption editing, and surfaces platform specifics like a YouTube first comment and the LinkedIn card description.
- Redesigned accounts sidebar. A compact logo cluster with a clean per-account status list replaces the old chip list; the sidebar is a static full-height rail that stays in view while the whole content column scrolls.
- Fail-closed approval trust gate. Editing a post after it was approved now revokes the approval instead of silently keeping the green light, so an approved-then-changed post can never ship un-reviewed.
- Server-side video cover JPEGs. The asset scan generates video cover thumbnails on the server, so the dashboard always has a real cover — `CoverThumb` no longer flashes an empty grey square, and cover generation stays binary-free in mock mode.
- Archived projects sink to the bottom of the clients list, greyed, with one-click restore.
- One-click "Fix in Setup" on actionable activity errors, deep-linking straight to the relevant Setup card.

### Fixed
- Link/article preview is now a contained, expandable card with a slim dialog scrollbar, instead of overflowing the composer.
- The composer hides the "Vorschau" label and toggle when a text-only post has nothing to preview.
- The delivery line reads as one honest, cloud-aware sentence with the repeats stripped.
- 35 missing composer and article-card keys are now translated for de-CH.

## [1.2.1] - 2026-07-06

### Added
- Six new publishing lanes. Mastodon, WordPress, Ghost, and Nostr each get a first-class publish engine wired through every seam (connect, validate, schedule, publish), plus Google Business Profile as a beta lane. The connect panel, sidebar account chips, and setup cards surface all of them.
- Native platform scheduling for Mastodon, WordPress, and Ghost: like YouTube, an approved post is handed to the platform's own scheduler instead of waiting on the local clock, so it fires even when the app is closed.
- Content-type-aware composer. WordPress and Ghost posts get a long-form article editor (title + body); Mastodon and Nostr get a note override; Google Business Profile gets its own post fields. The composer adapts to the platforms a post targets rather than showing one flat text box.
- Capability badges before you pay. Each lane is tagged by how it runs — cloud 24/7, native platform scheduling, or local-only — driven by the cloud's live capability map, so the trade-off is visible on the Cloud page before a plan is chosen.
- Cloud always-on now covers Telegram, Discord, and Nostr for managed brands, on top of the existing Meta / LinkedIn / X / Bluesky lanes.
- X reply-chain threading. A post can reference an earlier X post (`xReplyTo`) to publish as a threaded reply; the dashboard surfaces the chain and the composer has a set/clear affordance for it.
- Per-platform model overrides for the Telegram, Discord, TikTok, Reddit, and Pinterest lanes, matching the override support the other lanes already had.

### Fixed
- `platform_validate` now catches half-configured Mastodon and Nostr identifiers (and the other wave-2 lanes) instead of letting an incomplete setup reach publish time.
- Cloud hand-off is scoped to the lanes the cloud actually fires: local-only lanes are no longer pushed to the cloud, and Bluesky — which has no publish engine anywhere yet — was dropped from the cloud lane set so a deferred post can no longer land nowhere.

## [1.2.0] - 2026-07-04

### Added
- Cloud sync guarantee status: `GET /api/cloud` now returns a `sync` roll-up (`green` — every approved cloud-lane post is confirmed accepted by the cloud; `yellow` — a push is still pending; `red` — the guarantee is broken: cloud unreachable, an approved post overdue-unpublished, a failed cloud publish, or sync stopped). The header cloud icon surfaces it as a green/amber/red dot with a localized reason line (en + de-CH).
- Push acknowledgements, the last successful cloud contact, and the subscription view are now persisted per client (`state.cloudAccepted` / `state.cloudContact` / `state.cloudSubView`), so the status is computable offline and survives restarts.

### Fixed
- Cloud-managed brands never silently miss a post again. The scheduler no longer hands off blindly to the cloud: lanes the managed cloud does not fire (YouTube incl. the release-recovery lane, Telegram, Discord, Reddit, Pinterest, TikTok) always run on the normal local schedule, and cloud lanes (Meta, LinkedIn, X, Bluesky) get a 20-minute liveness backstop — a post the cloud provably has not fired past that grace publishes locally, with a `cloud-backstop` activity entry. Reconcile runs first each tick and the cloud worker's claim guard holds, so the backstop cannot double-post.
- A brand the cloud wrongly reports as paused while it is on locally now re-asserts its always-on flag every tick (the mirror of the existing off-flag self-heal).
- A stale cached cloud-failure entry for a post that has since published no longer holds the sync status red.

## [1.1.1] - 2026-06-28

### Fixed
- Docker/container startup: the one-time multi-client boot migration no longer crashes with `EXDEV: cross-device link not permitted` when `data/` is baked into a read-only image layer (e.g. running `pendpost --stdio` inside a container, the form MCP registries use to introspect the server). The migration now falls back to a copy + delete across the mount boundary, keeping its zero-loss, crash-safe re-entry behavior.

## [1.1.0] - 2026-06-28

### Added
- Connect panel: set up Instagram, Facebook, LinkedIn, YouTube, and X from inside the app. Credentials go into collapsible per-platform cards that save as you type — no Save button — and never leave your machine.
- Disconnect: clear a platform's stored credentials straight from its card, for rotating keys or stepping away from a shared machine.
- YouTube setup guidance: Production-first connect steps and plain-language reassurance for Google's "this app isn't verified" consent screen, so the one-time warning doesn't read as a dead end.
- `pendpost connect`: a CLI entry point for the same operator-only connect flow.

### Fixed
- The OAuth connect ceremony now reports progress and completion instead of leaving you on a dead-end screen.
- macOS approval notifications now show the pendpost icon.

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
