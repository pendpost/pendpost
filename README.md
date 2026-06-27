# pendpost

**Agent-operated social media with a human approval gate.**

[![CI](https://github.com/pendpost/pendpost/actions/workflows/ci.yml/badge.svg)](https://github.com/pendpost/pendpost/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![MCP native](https://img.shields.io/badge/MCP-native-7c3aed.svg)](https://modelcontextprotocol.io)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

<p align="center">
  <img src="brand/github/readme-hero-preview.png" alt="pendpost: an AI agent drafts and schedules posts; a human approval gate decides what publishes" width="820">
</p>

pendpost is a free, open-source (MIT), local-first social media planner where an AI agent drafts and schedules posts across Instagram, Facebook, LinkedIn, YouTube, and X behind a human approval gate you control. It is MCP-native: AI agents draft, lint, schedule, and queue your posts, but nothing goes live until a human approves it. It is built for developers, agencies, and technical solopreneurs who want agents to do the work without handing them the keys, and without getting accounts flagged.

## Why pendpost is different (not just a scheduler)

Most "AI social" tools are schedulers with an agent bolted on. pendpost is the opposite. It is an operations layer designed around the agent-plus-human workflow, and these are the parts a scheduler does not give you:

<p align="center">
  <img src="brand/github/approval-gate-diagram-preview.png" alt="The approval gate: an agent drafts, but cannot approve its own draft; a human approves; only then does it publish" width="820">
</p>

- **Human approval gate.** Every post carries an approval state (`draft`, `approved`, `rejected`) and is fail-closed: a post with no approval will not publish. `plan_create_post` always creates a draft, and only `approve_post` or `reject_post` can flip it. There is no self-approval, so the actor who created a post can never approve it (an agent cannot bless its own draft); the owner is exempt.
- **Anti-ban circuit breakers.** A Meta error 368 (an action block) trips a breaker that halts the Meta lane and never auto-resumes, because 368 carries no machine-readable clear time. Health probes send zero Graph traffic while blocked. A cadence cap defers bursts rather than dropping them, and a lane pause kill switch is always available.
- **Humanizer brand-lint.** Captions are checked before publish against editable rules in `rules.json`. The humanizer layer flags English AI-writing tells. Errors block publish; warnings are advisory.
- **Honest native scheduling.** Where a platform supports it (Facebook scheduled posts, YouTube `publishAt`), pendpost uses native scheduling, so those posts fire even when your computer is off. Instagram, LinkedIn, and X have no native scheduling, so pendpost must be running to publish them; run it on an [always-on host](https://docs.pendpost.com/always-on) to cover those too. It stays honest about which cover/thumbnail mechanics actually apply per platform.
- **Dual interface.** A web dashboard and any MCP client drive the same contract. A parity test enforces that every capability ships on both faces.
- **German and Swiss localization.** Run the dashboard, digest, and notifications in English or real Swiss German (`de-CH`, with proper umlauts and 24-hour Swiss dates); set the language in Settings. See the [localization docs](https://docs.pendpost.com/localization).

## Quickstart

One line, no setup:

```bash
npx pendpost
# then open http://127.0.0.1:8090
```

No account, no signup - pendpost runs locally and starts immediately. You can draft, approve, and schedule a full campaign right away; the first run ships an example "Acme Launch" campaign in `data/plans`, so you see real content at once. Connect a platform in **Setup** when you are ready to publish - until then a lane is live-but-unauthenticated, so publishing simply waits for the connection rather than faking it.

Prefer git or docker?

```bash
# git
git clone https://github.com/pendpost/pendpost pendpost
cd pendpost
npm start            # or: node bin/pendpost.mjs (builds the dashboard on first run)
# then open http://127.0.0.1:8090
```

```bash
# docker
docker compose up
# then open http://127.0.0.1:8090
```

## The dashboard

The planner and the approval queue are the two screens you live in: draft and schedule on the left, approve or reject on the right. Nothing on the right can approve itself.

| Planner | Approval queue |
| --- | --- |
| ![The pendpost planner: a calendar of drafted and scheduled posts](brand/screenshots/dashboard-planner.png) | ![The pendpost approval queue: posts waiting for a human decision](brand/screenshots/dashboard-approvals.png) |

## MCP clients

The easiest path self-boots: pendpost speaks MCP over native stdio, so the client launches the server for you - nothing to start first.

Claude Desktop (one-click): install the pendpost `.mcpb` bundle attached to each [GitHub release](https://github.com/pendpost/pendpost/releases). It self-boots `npx -y pendpost --stdio` and opens the approval dashboard in the same process.

Any stdio MCP client:

```json
{
  "mcpServers": {
    "pendpost": { "command": "npx", "args": ["-y", "pendpost", "--stdio"] }
  }
}
```

Advanced / dev (HTTP transport): pendpost also serves MCP over streamable-HTTP at `/mcp`. This needs the server already running via `npx pendpost`:

```bash
claude mcp add --transport http pendpost http://127.0.0.1:8090/mcp
```

### AI-assisted setup (Claude for Chrome)

Going live on a real platform means creating a developer app in each vendor's portal and running one OAuth ceremony. pendpost makes that agent-drivable: on each incomplete card in the dashboard's **Setup** page, a **Copy AI prompt** button copies a ready-to-paste, secret-safe prompt for Claude for Chrome that drives the portal for that one platform. You authenticate at every login/consent gate, and the credential is minted locally by the CLI - it never passes through the agent or the chat. The same setup contract is documented for any agent in [`AGENTS.md`](AGENTS.md).

## What the MCP tools do

Every capability is an MCP tool, and the dashboard mirrors it. Read-only tools can never publish; write tools create drafts and are gated by the approval rules above. Grouped by what they do:

- **Read and inspect:** `plan_list`, `plan_get`, `account_status`, `assets_list`, `activity_log`, `validate_media`, `platform_validate`, `pendpost_health`, `publish_preview`, `brand_lint`, `generate_digest`, `config_get`, `clients_overview`.
- **Compose:** `plan_create_post`, `plan_update_post`, `plan_delete_post`, `campaign_create`, `campaign_set_active`.
- **Approve (the human gate):** `approve_post`, `reject_post`. An agent can never approve its own draft.
- **Schedule and publish:** `scheduler_set`, `publish_due_run`, `reschedule`, `unschedule`, `mark_posted`, `verify_post`.
- **Covers and assets:** `set_cover`, `clear_cover`, `asset_upload`, `rename_asset`, `delete_asset`.
- **Insights and safety:** `fetch_insights`, `token_refresh`, `pendpost_record_block`, `health_recheck`, `meta_lane_set`.
- **Config and clients:** `config_set`, `client_create`, `client_update`, `client_archive`, `client_list`, `client_set_active`.

The authoritative count and the read/write split are derived from `lib/mcp.mjs` and verified by `test/parity-check.mjs` (see the [MCP docs](https://docs.pendpost.com/mcp)). Each tool also carries `readOnlyHint`/`destructiveHint`/`title` annotations in `tools/list`.

## Going live

When you are ready to publish, connect each platform in **Setup** (or copy `.env.example` to `.env` and fill in only the platforms you use). A platform publishes once its credential is present; until then it is live-but-unauthenticated and publishing waits for the connection. (`PENDPOST_MODE=mock` exists only as a test/demo fixture that routes every lane through the credential-free mock driver.)

Each platform has an interactive setup ceremony that writes to `.env`:

```bash
# Meta (Facebook + Instagram). A System User token is preferred for automation.
node scripts/meta-social.mjs setup-system-user \
  --system-user-token <T> --page-id <ID> --app-id <ID> --app-secret <S>
# (or `node scripts/meta-social.mjs setup` for a long-lived Page token)

# LinkedIn (after creating an OAuth app)
node scripts/linkedin-social.mjs auth

# YouTube (after creating an OAuth client)
node scripts/yt-social.mjs auth

# X (Twitter), OAuth 2.0 PKCE (browser). OAuth 1.0a needs no command - see below.
node scripts/x-social.mjs auth
```

**X (Twitter)** supports two auth paths; **OAuth 1.0a is recommended** because it needs no browser and sidesteps the `ERR_TOO_MANY_REDIRECTS` that some apps hit on X's OAuth 2.0 consent screen.

- **OAuth 1.0a (recommended, zero browser).** In the X developer portal: (1) set the app's **User authentication settings to Read and Write FIRST**; (2) then under **Keys and tokens**, generate/regenerate **both** the API Key/Secret **and** the Access Token/Secret; (3) paste all four into `.env` as `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET`. The lane goes live the moment `X_ACCESS_TOKEN_SECRET` is set - no `auth` command. Verify with `node scripts/x-social.mjs probe` (prints `connected as @handle`). Gotchas, in order:
  - All four values must come from the **same app** and the **same generation**.
  - Regenerating the API Key/Secret **invalidates the Access Token/Secret** - so always regenerate the Access Token/Secret **after** the API Key/Secret, never before.
  - One wrong character yields `401 "Could not authenticate you"` (code 32), which masquerades as an access-token problem. **Copy the values from the portal; do not hand-type them.**
- **OAuth 2.0 PKCE (browser).** Create an OAuth 2.0 confidential client with callback `http://localhost:8087/callback` and scopes `tweet.read tweet.write users.read media.write offline.access`, then run `node scripts/x-social.mjs auth`. The access token lasts ~2h and the refresh token rotates; pendpost refreshes both automatically before each run.

See `.env.example` for the full list of environment variables per platform.

## Brand-lint + humanizer

Captions run through a brand-lint pass before they can publish. The rule set lives in `rules.json`, which you edit directly. Each rule is an object with an `id`, a `severity` (`error` blocks, `warn` is advisory), a `matcher` (a regex or a platform-aware built-in like `captionLength`, `hashtagCount`, `allCaps`, `brokenLink`), and a `hint`. The shipped default also includes humanizer rules that flag English AI-writing tells (AI vocabulary, em dashes, negative parallelism, reflexive rule-of-three padding, filler and hedging, promotional puffery). To disable a rule, delete its object; to add one, append an object. A `rules.json` at your workspace root overrides the shipped default. `brand_lint` is both an MCP tool and the dashboard composer's lint panel.

## Architecture

pendpost is one zero-dependency Node process (`server.mjs`) with four faces: a REST API at `/api`, an MCP server at `/mcp` (streamable-HTTP, JSON-RPC 2.0, 43 tools), a `/media` face that range-streams local files under `data/`, and `/`, which serves the built React dashboard from `app/dist`. Backend logic lives in `lib/*.mjs`. There are four publish engines in `scripts/`: `meta-social.mjs` (Facebook and Instagram), `linkedin-social.mjs`, `x-social.mjs`, and `yt-social.mjs`, each spawned as a subprocess on a scheduler tick or on demand and each emitting a JSON envelope. Plans and state are local JSON. The workspace root holding `.env`, `config.json`, `state.json`, and `data/` is overridable via `PENDPOST_ROOT` (default: the install dir).

## Platforms

Facebook, Instagram, LinkedIn, X, YouTube. Each engine handles its own auth, publishing, native scheduling, cover/thumbnail mechanics, and read-only insights. X has no native scheduling, so due tweets are published by the scheduler at their scheduled time (like Instagram and LinkedIn).

## Security + privacy

pendpost binds `127.0.0.1` (loopback) by default, never phones home, and keeps secrets only in your own `.env` (which is gitignored). See [SECURITY.md](SECURITY.md) for the full posture and how to report a vulnerability.

## Status

pendpost is maintained part-time by a small team and is early. Expect rough edges, and set your response-time expectations accordingly.

## Docs

The full reference lives at **[docs.pendpost.com](https://docs.pendpost.com)** (source in `site-docs/`). Marketing, pricing, and every [download option](https://pendpost.com/download) live at **[pendpost.com](https://pendpost.com)**.

## License

MIT, Copyright 2026 Nomadik GmbH. See [LICENSE](LICENSE). Please also read [DISCLAIMER.md](DISCLAIMER.md) for the responsible-use posture and [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
