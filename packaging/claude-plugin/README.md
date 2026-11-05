# pendpost plugin for Claude

pendpost is a free, MIT-licensed, local-first social media planner. With this plugin, Claude
can draft, lint and schedule posts for Instagram, Facebook, LinkedIn, YouTube, X, Telegram,
Discord, Mastodon, Nostr, WordPress and Ghost (Reddit, Pinterest, TikTok and Google Business
Profile in beta). Nothing publishes until you approve it, and an agent can never approve a
post it created itself.

## What the plugin runs

One local MCP server over stdio: `npx -y pendpost@<version> --stdio`, pinned to an exact
release. It downloads the `pendpost` package from npm on first start and runs it on your
machine. The same process serves the approval dashboard at http://127.0.0.1:8090, bound to
loopback only. Its workspace (plans, drafts, media, activity log and your platform
credentials in `.env`) lives in the plugin's own data folder (`PENDPOST_ROOT` is set to
`${CLAUDE_PLUGIN_DATA}`).

## What it sends and fetches

- Nothing goes to Nomadik GmbH or any pendpost server. There is no telemetry.
- When you connect a platform and approve a post, pendpost calls that platform's own API to
  publish it and to read its insights.
- If you turn on Radar, it reads public posts from the sources you enable.
- npm is contacted once to download the pinned package.

Every tool carries a `title` plus `readOnlyHint` or `destructiveHint`. Read-only tools can
never publish. `publish_due_run` publishes for real and needs `confirm: true`.

## Getting started

Ask Claude to call `pendpost_health`. Its `setup` field lists each platform and the steps to
connect it. Secrets (tokens, keys) are entered by you in a local command or the dashboard,
never by Claude. Docs: https://docs.pendpost.com/mcp-server

## Privacy Policy

pendpost runs on your machine and sends nothing to us.

- **What it collects:** only what you give it. Plans, drafts, media and history stay in the
  local workspace; platform credentials stay in your own `.env`.
- **How data is used:** content goes out only to the platforms you connect, to publish posts
  you approve.
- **Third parties:** Claude and its model provider see what Claude reads through pendpost's
  tools, under your account and Anthropic's terms. Each connected platform receives the posts
  you publish there.
- **Retention:** your data stays until you delete it; we hold no copy.
- **Contact:** hello@pendpost.com

Full policy: https://pendpost.com/privacy

## License

MIT, Copyright 2026 Nomadik GmbH. Source: https://github.com/pendpost/pendpost
