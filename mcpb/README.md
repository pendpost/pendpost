# pendpost for Claude Desktop

pendpost is a free, MIT-licensed, local-first social media planner. Claude drafts and
schedules your posts through pendpost's MCP tools, and nothing publishes until you approve
it. An agent can never approve its own post.

This bundle is a thin launcher. It runs the published npm package over stdio
(`npx -y pendpost --stdio`), which speaks MCP to Claude and serves the local approval
dashboard at http://127.0.0.1:8090 from the same process.

## Setup

1. Install the bundle in Claude Desktop. Node.js 20 or newer must be on your machine.
2. Optional: pick a workspace folder. It holds your `.env` (platform credentials) and
   `data/` (plans, drafts, media). Leave it blank to use the default location.
3. Open http://127.0.0.1:8090 and connect the platforms you want on the Setup page. Until
   you do, pendpost runs in mock mode with example content and publishes nothing.

Try asking Claude: "Draft three LinkedIn posts about our launch and schedule them for next
week", "What is waiting for my approval?", or "Show me last week's post performance".

## Privacy Policy

pendpost runs on your own machine and sends nothing to us (Nomadik GmbH).

- **What it collects:** only what you give it. Plans, drafts, media and activity history
  stay in its local `data/` folder, and your platform credentials stay in your own `.env`.
- **How it uses and stores data:** everything stays on your machine. Content goes out
  only to the social platforms you connect, to publish the posts you approve.
- **Third parties:** Claude, and the AI model behind it, see whatever the agent reads
  through pendpost's tools, under your own Anthropic account and its terms. Radar reads
  public posts from the sources you turn on.
- **Retention:** your data stays until you delete the folder; we hold no copy.
- **Contact:** hello@pendpost.com

Full policy: https://pendpost.com/privacy

## Support

Issues: https://github.com/pendpost/pendpost/issues · Docs: https://docs.pendpost.com

## Build (maintainers)

```bash
npm install -g @anthropic-ai/mcpb
mcpb validate mcpb/manifest.json
mcpb pack mcpb pendpost.mcpb
```

`.github/workflows/mcpb-release.yml` builds the bundle and attaches it to each GitHub
Release. Before a release, re-check every tool's `readOnlyHint` / `destructiveHint` in
`lib/mcp.mjs`; a wrong annotation is the most common extension-review rejection.
