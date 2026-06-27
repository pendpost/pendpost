# Claude Desktop bundle (.mcpb)

This directory builds the one-click Claude Desktop bundle for pendpost. The bundle is
a thin launcher: it runs the published npm package over native stdio
(`npx -y pendpost --stdio`), which speaks MCP on stdout and boots the local approval
dashboard at http://127.0.0.1:8090 in the same process. No `mcp-remote` bridge, no
"start the server first" step.

## Build

```bash
npm install -g @anthropic-ai/mcpb
mcpb validate mcpb/manifest.json
mcpb pack mcpb pendpost-1.0.0.mcpb
```

`.github/workflows/mcpb-release.yml` does this automatically and attaches the `.mcpb`
to each GitHub Release. As of mid-2026 there is no public Anthropic `.mcpb` directory,
the GitHub Release asset (linked from the README and docs.pendpost.com) is the
distribution channel.

## Notes

- The bundle launches the package from npm, so `pendpost` must be published first
  (the registry/D2 step). It is not a self-contained bundle of the app source.
- If `mcpb validate` requires an `entry_point` for the node server type, add a tiny
  `server/index.mjs` launcher that imports `pendpost/lib/stdio.mjs` and calls
  `runStdio()`, and point `server.entry_point` at it. The `mcp_config.command` path
  above is what actually runs.
- `user_config.workspace` maps to `PENDPOST_ROOT` (the folder holding the user's
  `.env` and `data/`). Empty falls back to the install default; mock mode needs no
  workspace at all.
- Before submitting/releasing, re-verify every tool's `readOnlyHint`/`destructiveHint`
  in `lib/mcp.mjs` (mis-annotation is the top extension-review rejection cause).
