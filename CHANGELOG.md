# Changelog

All notable changes to pendpost are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and pendpost adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.2.0] - 2026-08-24

This release closes the loop on X. pendpost now sees the mentions, replies, likes, follows, and direct messages your posts draw, gathers them into one inbound inbox, and lets you answer without leaving the app. In the same breath it stops the quiet money leak that a metered X account could spring: a lane that runs out of credits now says so honestly instead of pretending to publish, and the daily reading that used to drain those credits is off by default.

### Added
- The inbound X Activity engine. pendpost watches what happens to your X posts, mentions, replies, likes, follows, and direct messages, and shows them in one inbound inbox you can act on. You can reply to a mention or a reply straight from that inbox, and an agent can do the same through the `reply_to_inbound_event` tool with a REST twin. The always-on cloud runtime carries the same stream so the inbox stays current even while your machine is asleep.
- Honest recovery when an X lane runs out of credits. X bills per call, and a depleted account used to look like a post that quietly failed. Now the lane halts with a plain reason, the post keeps an honest Failed pill instead of a misleading Retrying one, and both the app and the `resume_lane` tool can re-check credits and pick the work back up. The credits panel links straight to the X top-up portal.
- Cost-aware Insights. Reading performance from a metered lane costs money, so the daily refresh now runs the free lanes on its own and leaves X as an explicit opt-in. This closes the case where a background read sweep drained X credits even though the balance looked fine. The Reddit and Mastodon sweeps are bounded the same way.
- A rebuilt Radar worklist. Radar opens on the work that is still open, hides the signals you have already handled, and marks a thread read in one click. The open and answered views are now separate filters with a three way sort, the nav shows a live count of new signals, and one hung source can no longer burn the whole scan because each source runs on its own. A partial or retrying scan reads as amber rather than a dead end, and once a signal is answered its card can never link back to the question again.
- An all-projects overview. When you run more than one brand, Activity, Insights, and the Radar comment inbox each have a combined view across every project, with weighted-average rates where an average makes sense, and both Approvals and the Planner can work in cross-project mode. Every card carries a clear project badge so you always know whose post you are looking at.
- Media upload in the editor. You can now upload or drag and drop a photo or video straight into the composer and the post detail, not only through the asset library.
- Covers that match the grid. A reel cover is shown the way each platform's profile grid will actually crop it, Instagram gets a grid-safe cover delivered without any extra dependency, and pendpost measures the rendition Instagram served after publishing so a cover surprise is caught. Video assets and cards carry an HD-quality badge.
- Connect ceremonies that ask for what they need. A hand-run command-line connect step now prompts for a missing credential instead of failing with an error, for both the OAuth and the static-token lanes, and the Setup page tells you the command will ask for the values.
- Smaller additions: auto-approve now only offers the lanes you have actually connected; a shared field primitive gives every labelled input the same shape; the Planner gained instant reschedule, a compact week view, and month drag and drop; deleting a post always works because the engine cancels the native platform object itself, in one confirm with an instant close; and the capability-drift gate now runs inside the OSS publish pipeline with a matching capability catalog on the website.

### Changed
- The website drops the managed-offering waitlist and goes self-serve.
- pendpost adopts the server's posting language when your machine has no local preference yet, so a fresh install speaks the right language.
- Every command-line engine verb now honours an explicit brand target, so a stray command cannot touch the wrong account.
- Radar's daily-run controls moved into Radar settings, and the reconcile now aligns to the daily run time.

### Fixed
- Native delete and unschedule are now idempotent across Ghost, WordPress, Mastodon, Facebook, and YouTube: removing a post that is already gone on the platform counts as success instead of an error.
- Intermittent Meta hiccups no longer park a healthy post; pendpost rides them out and lets the post go when the platform recovers.
- The cover that shows in the app is the cover that publishes, after a client-root path fix with a sibling fallback and an Instagram first-frame default.
- Mock mode is fenced and honestly bannered so a test run can never reach a live account, and a reverted YouTube handoff heals itself and ships the overdue posts.
- Cloud delivery: a rescheduled post clears its stale cloud markers so a retry drops the phantom failure, the health-dot popover copy matches the control it explains, and every red health state routes to the Planner.
- A broad accessibility pass clears Tier-1 contrast failures and meets WCAG AA across the comment inbox, the sidebar primaries, and the amber and zinc state colours, and the served dashboard now ships a robots.txt so it can be indexed.

## [2.1.0] - 2026-08-12

This release turns pendpost outward. It now watches the comments on your own posts, lets a client sign off on work through a link of their own, remembers the people who engage with you across lanes, and hardens the moment a post publishes so a broken one is caught before it ships rather than after.

### Added
- A comment inbox for your own posts. pendpost watches the comments on the posts it published and gathers them into an inbox on Radar, where you can like a comment or open it on the platform without leaving the app. The sweep rides the same scheduler tick as everything else, hides your own replies so the list stays about your audience, sorts newest first, tints anything you have not seen, and marks a thread done once you have dealt with it. A lane that cannot actually read comments, such as LinkedIn on the Community Management API, says so plainly instead of showing a false empty state.
- A client review link. You can invite a client or a teammate to sign off on posts through a dedicated review page that never exposes the rest of the app and fails closed. Reviewers get a shareable link, a post waits on a sign-off fence before it publishes, and both the approvals list and the post detail show whether a post is awaiting review or already signed. Reviewer management has full MCP and REST twins.
- Relationship memory. pendpost remembers the people who engage with you across lanes and shows how many times you have gone back and forth with each one, so a reply can acknowledge a returning voice instead of treating every exchange as the first. The store is local and can forget a person on request.
- An enforced pre-flight readiness gate. A post proves it is ready at three points: when you approve it, at the publish path itself, and when the cloud accepts it for always-on delivery. A lane that is not ready is refused rather than shipped broken, and you can force past the gate when you know better. The delivery envelope carries the verdict so the cloud and the local backstop agree on it.
- A fresh-bytes backstop on every video lane. Before a video goes out, pendpost re-checks that the caption is present and that audio and video stay in sync, on Instagram, Facebook, YouTube, Mastodon, TikTok, Reddit, and the cloud lanes (LinkedIn, X, Telegram, Discord), so a desynced reel is caught here instead of being rejected by the platform.
- A per-brand fact sheet for Radar. Each brand carries its own description that drives both what Radar scans for and how it drafts replies, editable from a Setup card with a live preview. An owner-only reset can prune a tenant's polluted AI-visibility state.
- An autonomy ledger. The scattered auto-approve and auto-reply controls now live in one place that shows exactly what pendpost is allowed to do on its own, with a dry-run view and a one-press revoke sweep.
- Performance memory in Insights. pendpost stores the metrics it reads, leads with what is working, flags breakout and slump outliers, and can recycle an evergreen post that earned it. Every lane that can measure now does, including X, Reddit, and Mastodon, and an MCP tool exposes the stored metrics to an agent.
- Brand-mention listening. Radar can watch for mentions of your brand as a first-class query, with a chip and a pill in the app and a count line in the daily digest.
- A closed loop on AI visibility (GEO). Radar bridges what it finds in AI answers into a backlog you can act on or decline, reads share-of-voice from the server, discloses the evidence behind each check, and labels which assistant it asked.
- Reply to a reply. When the author of a post you replied to answers back, the badge is now actionable and pendpost can thread a reply onto their follow-up.
- A feedback and suggestions pipeline. Feedback has three on-ramps that all land in GitHub without the app ever phoning home: an in-app Share feedback link that opens a prefilled, secret-safe GitHub page, a feedback issue form, and an optional form on pendpost.com for people without a GitHub account. Deeper proposals get an RFC track under `docs/rfcs/`, and issue triage is automated (auto-labelling, first-timer welcome, a needs-info stale policy, and RFC labelling). The full design is in `docs/specs/feedback-pipeline.md`.
- Real product documentation. The Mintlify starter template is replaced with pendpost's actual docs, published through a mirror pipeline.
- Smaller additions: a publish-failure hold across all thirteen engines that caps local retries at three and mirrors the cloud re-fire cap; approval-expiry and slot-slip sweeps in the publishing automation card; a digest that reports delivery, autonomy, GEO trend, and calendar gaps; a humanizer receipt that shows what the gate changed; the Nostr NIP-96 media upload path; splitting an over-cap X caption into an approvable thread; a today marker in the Week and Month planner; and one-decision project creation.

### Changed
- A hand-run command-line social ceremony now requires an explicit brand target or refuses, so a stray command can never post to the wrong account.
- The shared scheduler tick honours each brand's own enabled flag, so a brand switched off no longer rides along on another brand's timer.
- `config_set` can now write the Reddit subreddit and the Pinterest board id.

### Fixed
- A broad UX-audit sweep across the app: honest empty, error, and refused states; contrast and label fixes that meet WCAG AA; archive safety that surfaces in-flight work before you archive; a composer guard against losing edits on a project switch; a held post whose primary action clears the hold and refires; a delete gate that refuses to delete a natively scheduled post; and an auto-approve rule that matches nothing when its platform list is empty.
- Radar legibility: a grouped signal is one card that states how many places it appeared, source status reads as a glyph per state rather than colour alone, a limit failure explains itself and offers a rescan, the AI-visibility gauge says exactly what it counts, a limit-refused scan no longer spends the daily budget, and zero-count chips are hidden.
- Cloud delivery hardening: a cloud media-fetch fault fires the local backstop right away instead of after twenty minutes, and toggling a brand always-on seals its own tokens first, fail-closed.
- Dependency and security updates: the marketing site moves to Astro 7.2.0 to clear the Astro and sharp advisories, and lockfile bumps resolve the remaining npm-audit high and moderate advisories.

## [2.0.1] - 2026-07-29

Switching cloud always-on off now actually goes quiet. It always stopped the cloud from publishing, but the local daemon kept talking to it on every tick, and the app kept showing a green "on" pill while nothing was firing.

### Fixed
- A brand switched off no longer keeps the cloud awake. Stale in-flight markers (a push ack for a post the local backstop had already published) held the poll gate open forever, and the gate's second leg was not due-gated, so any approved future post kept it open too. Relic markers are pruned each tick, the gate reads the due time, and the off-flag re-assert is rate-limited instead of running every minute. Measured on a live install: roughly 2,880 cloud writes a day, down to none while nothing changes.
- The cloud result feed is a history, not a delta, so replayed old failures were written back on every poll and re-created the very relics that had just been pruned. A failure is now only recorded while its post is still approved and unposted.
- The 24/7 state pill said "on" whenever an account was linked, even with every project switched off. It now reflects whether the cloud is publishing anything, and the plan meter says plainly that the base fee keeps running, with the subscription portal one click away instead of buried in the account menu.

### Changed
- Turning a project off withdraws the jobs it had already pushed to the cloud, instead of leaving them queued to be refused one by one at their due time.
- A billing alert only claims a recovery after a real past-due period, and never claims publishing has resumed while no project is switched on.

## [2.0.0] - 2026-07-26

The largest release since 1.0: a full Radar listening-and-reply engine, native carousel/album publishing across every capable lane, and per-brand token sealing that hardens always-on delivery. Roughly forty capability specs landed since 1.4.0. Major version because Radar and multi-slide albums reshape the product surface, not because of a breaking API change.

### Added
- Radar: a listening-and-reply engine. pendpost scans where your buyers ask questions (Reddit, Mastodon, Bluesky, Hacker News, X, YouTube, Nostr), scores each signal for buying/service-seeking intent in EN and de/de-CH, and drafts a product-aware reply behind a human approval fence. Scanning runs on your own agent, so you can watch the child's transcript stream onto the job, and daily research arms itself from a chosen cadence, off by default and budgeted. Score-gated auto-reply, a warmth/karma builder for Reddit, author-reply read-back, and a GEO (AI-visibility) layer round it out.
- Carousel and album publishing end to end. A native multi-image / multi-slide post type flows through the composer, validation, the full-screen viewer, and delivery, with real albums on Mastodon and Instagram, image-carousel children on Instagram, carousel pins on Pinterest, and a public media-mirror seam for lanes that need per-slide URLs.
- Per-brand token sealing. Credentials are now sealed and resolved by brand and carry their destination in the delivery envelope, so an always-on job publishes to the account it was approved for. The cloud worker and local backstop share one atomic publish-claim lease, making a double-post structurally impossible.
- New and extended platform lanes and verbs: native polls; Ghost members + newsletter management; Pinterest board/board-section CRUD and native video pins; GBP reviews, media library and attributes; Nostr NIP-23 long-form, NIP-96/98 media upload, and zaps; Discord forum/thread targeting and scheduled events; cross-lane profile editing; edit-after-publish for YouTube/Telegram/Discord; universal self first-comment; cross-lane image alt-text; YouTube playlist management; richer own-account insights (reach, engagement, watch-time, audience demographics).
- Inbox: read and reply to inbound comments, moderate comments, and react as the brand (like/favourite/boost/emoji), with a webhook/realtime ingestion seam.
- An always-on humanizer gate on every outbound-text seam, and multi-select asset attach replacing the one-at-a-time flow.

### Changed
- Setup was rebuilt into a prompt-first, master-detail page: a grouped rail with one open lane, platform and Radar toggles living on each card, connected-account discovery, and one-press credential adopt to reuse another client's agent. The old Settings grid is retired.
- Freigaben/Approvals now say where each post publishes and prove it after the fact, sort newest-first with a per-tab control, can revive a rejected post to draft, and guard bulk-approve when offline.
- App polish throughout: Radar feed at scale with duplicate grouping, insights that lead with primary metrics, an activity feed that leads with content over bookkeeping, a resizable sidebar rail, and "don't show again" opt-outs across recurring confirm/prompt gates.
- The web marketing site gained an outcome-led hero with a full-loop approval demo, scannable pricing, and a consistent CTA.

### Fixed
- Cloud delivery hardening: failed and already-posted jobs stop being re-fired forever, a half-written connection heals instead of reading disconnected, stale cloud-failures clear on reconcile, and reconcile failures log their real HTTP status.
- Carousel correctness: albums render instead of erroring, derive their frame and ratio from the real slides, no longer strand slides as unused files, and speak de-CH in every blocker.
- A broad correctness sweep across Radar, planner, composer, inbox, insights and the setup flow, including honest empty/refused states and a11y fixes.

## [1.4.0] - 2026-07-08

### Added
- Backstop publish-claim gate for always-on. The cloud worker and the local overdue-backstop are two independent firers of the same job; both now assert one shared atomic publish-claim lease before firing, so a double-post is structurally impossible even when the machine wakes mid-fire. It fails open when the cloud is unreachable, so a self-hosted install behaves exactly as before.
- Read-only cloud observability over MCP. Four new read-only tools (`cloud_status`, `cloud_capabilities`, `cloud_clients`, and `cloud_subscription`) mirror the `GET /api/cloud*` routes so an agent can inspect cloud state with no secret and no confirm gate (API-key presence only, never the key itself).
- Single edit surface for a post. The post detail is now the one place a post is edited; a single-lane post (X, Mastodon, or Nostr only) shows one "Post text" field instead of a caption/override split, and the sidebar's next-post pill shows the platform glyph, the day and time, and a one-line content preview.

### Fixed
- X thread replies now thread correctly when fired as separate jobs. A reply job resolved its parent against a plan snapshot frozen before the parent tweet existed, so it fail-closed with an empty envelope. The parent id is now resolved at fire time, and an unresolvable parent emits a structured `parent_unpublished` (deferred, retryable) or `parent_missing` (terminal) result instead of a silent skip.
- UX-audit pass across 15 screens: collapsed status a11y and summary copy (Setup), a NaN guard and subtitle gating (Cloud), a single schedule control and auto-growing text areas (post detail, composer, thread composer), an exceptions-only health cell (Clients), timezone auto-save (Settings), and header and empty-state polish (Insights, Assets, Activity, Published, Planner).
- The planner readiness checklist no longer leaks raw shell commands into its blocker rows; the rows still deep-link to Setup, which is the actual next step.
- Honest, cloud-scoped delivery labels: the planner banner and the cloud popover no longer share one "undelivered" label for two different counts, and the duplicate active-client chip and reused labels across post detail, clients, and cloud are disambiguated.

## [1.3.0] - 2026-07-07

### Added
- Thread composer for X. Plan a whole X thread as one artifact. Draft every reply in a single editor, reorder the tweets, and schedule the chain as one unit instead of stitching separate `xReplyTo` posts by hand.
- Platform-aware post detail. The detail dialog now shows only the fields each network actually publishes, so you never edit a caption a platform will never use. It opens as a centered two-column layout with state-aware actions and keyboard triage, supports inline caption editing, and surfaces platform specifics like a YouTube first comment and the LinkedIn card description.
- Redesigned accounts sidebar. A compact logo cluster with a clean per-account status list replaces the old chip list; the sidebar is a static full-height rail that stays in view while the whole content column scrolls.
- Fail-closed approval trust gate. Editing a post after it was approved now revokes the approval instead of silently keeping the green light, so an approved-then-changed post can never ship un-reviewed.
- Server-side video cover JPEGs. The asset scan generates video cover thumbnails on the server, so the dashboard always has a real cover, `CoverThumb` no longer flashes an empty grey square, and cover generation stays binary-free in mock mode.
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
- Capability badges before you pay. Each lane is tagged by how it runs (cloud 24/7, native platform scheduling, or local-only), driven by the cloud's live capability map, so the trade-off is visible on the Cloud page before a plan is chosen.
- Cloud always-on now covers Telegram, Discord, and Nostr for managed brands, on top of the existing Meta / LinkedIn / X / Bluesky lanes.
- X reply-chain threading. A post can reference an earlier X post (`xReplyTo`) to publish as a threaded reply; the dashboard surfaces the chain and the composer has a set/clear affordance for it.
- Per-platform model overrides for the Telegram, Discord, TikTok, Reddit, and Pinterest lanes, matching the override support the other lanes already had.

### Fixed
- `platform_validate` now catches half-configured Mastodon and Nostr identifiers (and the other wave-2 lanes) instead of letting an incomplete setup reach publish time.
- Cloud hand-off is scoped to the lanes the cloud actually fires: local-only lanes are no longer pushed to the cloud, and Bluesky (which has no publish engine anywhere yet) was dropped from the cloud lane set so a deferred post can no longer land nowhere.

## [1.2.0] - 2026-07-04

### Added
- Cloud sync guarantee status: `GET /api/cloud` now returns a `sync` roll-up (`green` - every approved cloud-lane post is confirmed accepted by the cloud; `yellow` - a push is still pending; `red` - the guarantee is broken: cloud unreachable, an approved post overdue-unpublished, a failed cloud publish, or sync stopped). The header cloud icon surfaces it as a green/amber/red dot with a localized reason line (en + de-CH).
- Push acknowledgements, the last successful cloud contact, and the subscription view are now persisted per client (`state.cloudAccepted` / `state.cloudContact` / `state.cloudSubView`), so the status is computable offline and survives restarts.

### Fixed
- Cloud-managed brands never silently miss a post again. The scheduler no longer hands off blindly to the cloud: lanes the managed cloud does not fire (YouTube incl. the release-recovery lane, Telegram, Discord, Reddit, Pinterest, TikTok) always run on the normal local schedule, and cloud lanes (Meta, LinkedIn, X, Bluesky) get a 20-minute liveness backstop: a post the cloud provably has not fired past that grace publishes locally, with a `cloud-backstop` activity entry. Reconcile runs first each tick and the cloud worker's claim guard holds, so the backstop cannot double-post.
- A brand the cloud wrongly reports as paused while it is on locally now re-asserts its always-on flag every tick (the mirror of the existing off-flag self-heal).
- A stale cached cloud-failure entry for a post that has since published no longer holds the sync status red.

## [1.1.1] - 2026-06-28

### Fixed
- Docker/container startup: the one-time multi-client boot migration no longer crashes with `EXDEV: cross-device link not permitted` when `data/` is baked into a read-only image layer (e.g. running `pendpost --stdio` inside a container, the form MCP registries use to introspect the server). The migration now falls back to a copy + delete across the mount boundary, keeping its zero-loss, crash-safe re-entry behavior.

## [1.1.0] - 2026-06-28

### Added
- Connect panel: set up Instagram, Facebook, LinkedIn, YouTube, and X from inside the app. Credentials go into collapsible per-platform cards that save as you type (no Save button) and never leave your machine.
- Disconnect: clear a platform's stored credentials straight from its card, for rotating keys or stepping away from a shared machine.
- YouTube setup guidance: Production-first connect steps and plain-language reassurance for Google's "this app isn't verified" consent screen, so the one-time warning doesn't read as a dead end.
- `pendpost connect`: a CLI entry point for the same operator-only connect flow.

### Fixed
- The OAuth connect ceremony now reports progress and completion instead of leaving you on a dead-end screen.
- macOS approval notifications now show the pendpost icon.

## [1.0.1] - 2026-06-27

### Added
- 24/7 Cloud-Service in-app purchase: compare plans, review the order, open secure checkout, and return to an active plan without leaving the app, with graceful cancel handling. The website deep-links a chosen plan straight into the app (`/download?plan=<tier>`).
- A cloud account menu on the real account identity: manage billing (Stripe portal), manage account (Clerk), a lightweight reversible sign-out/switch, and an explicit sign-in entry, with the heavier "eject to self-host" kept separate.

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
