# Roadmap

This roadmap is aspirational. Everything below is a direction, not a commitment, and there are no dates. pendpost is maintained part-time by a small team, so priorities shift.

## Recently shipped

- **Always-on self-host.** Deploy templates (Fly.io, Railway, Render) plus a Docker image and a docs guide for running pendpost on a host that never sleeps, so Instagram, LinkedIn, X, Telegram, Discord, and Nostr publish on schedule even when your computer is off. The server stays loopback-only with no auth by default; an optional bearer-token gate activates only when you bind it to a non-loopback host and set a token. Facebook and YouTube already survive power-off via native scheduling.
- **More platforms.** Six new lanes, each through the same approval-gated, parity-checked contract: Telegram, Discord, and Nostr now fire from the managed cloud for always-on brands; Mastodon, WordPress, and Ghost get native platform scheduling, so an approved post is handed to the platform's own scheduler instead of waiting on the local clock; Google Business Profile ships as a beta lane.

## Near-term (aspirational)

- **Richer humanizer rules.** Expand the brand-lint and humanizer rule set in `rules.json`, sharpen the existing matchers, and reduce false positives on the AI-writing tells.
- **Docs polish.** Improve the docs site, the per-platform setup walkthroughs, and the in-product guidance.

## Future (aspirational)

- **Commercial cloud layer for agencies (separate, not in this MIT repo).** A hosted, always-on runtime and an approval-gated MCP endpoint, aimed at agencies running AI-assisted social for multiple client brands. It would publish on schedule without the user keeping a machine on, enforce the same human approval gate server-side (it fires only already-approved posts and never lets a creator approve their own), keep tokens encrypted, scoped, and revocable, and offer an eject-to-self-host path. This would be a separate proprietary product and would not live in this MIT-licensed repository. The local-first, zero-telemetry core stays exactly as it is.

Nothing here is promised, scheduled, or guaranteed. Treat it as a sketch of where pendpost might go.
