# Installing pendpost (instructions for an AI agent)

pendpost is a local-first social media MCP server. An agent drafts and schedules posts;
nothing publishes until a human approves it. It runs on the user's own machine and needs no
account and no API key to start.

## Requirements

- Node.js 22 or newer (`node --version`). If it is missing or older, ask the user to install
  Node.js 22+ from https://nodejs.org before you continue.
- No API key, no environment variable and no sign-up are needed to install.

## 1. Pick a workspace folder

pendpost keeps its data (plans, drafts, media, the activity log) and the user's platform
credentials (`.env`) in one workspace folder. Set it with `PENDPOST_ROOT`, as an absolute
path. Without it, an `npx` install keeps the data inside the npm cache, where a cache clean
would delete it.

Suggest `~/pendpost` written out in full, for example `/Users/<name>/pendpost` on macOS,
`/home/<name>/pendpost` on Linux or `C:\Users\<name>\pendpost` on Windows. Create the
folder if it does not exist.

## 2. Add the server to the MCP settings

pendpost speaks MCP over stdio. Add this entry to the client's MCP settings file
(for Cline: `cline_mcp_settings.json`), with the absolute workspace path from step 1:

```json
{
  "mcpServers": {
    "pendpost": {
      "command": "npx",
      "args": ["-y", "pendpost", "--stdio"],
      "env": { "PENDPOST_ROOT": "/absolute/path/to/pendpost-workspace" }
    }
  }
}
```

On Windows, if `npx` is not found, use `"command": "cmd"` with
`"args": ["/c", "npx", "-y", "pendpost", "--stdio"]`.

The first start downloads the package and can take up to a minute. The same process also
serves the approval dashboard at http://127.0.0.1:8090 (loopback only).

## 3. Check that it works

1. Call the `pendpost_health` tool. A working install answers with `ready`, `blockers` and a
   `setup` field that lists every platform with its status. `ready: false` is normal before
   any platform is connected; the call answering at all means the install worked.
2. Tell the user to open http://127.0.0.1:8090. That dashboard is where they approve posts.

To try it without touching real accounts, add `"PENDPOST_MODE": "mock"` to `env` and remove
`PENDPOST_ROOT`. Mock mode runs in a demo workspace in the temp folder with an example
campaign, and every publish goes to a fake driver.

## 4. Connecting a platform (optional, user-driven)

Publishing to a real platform needs that platform's credential. Read `setup` from
`pendpost_health` and follow `setup.<platform>.playbook` step by step. Rules:

- You may write non-secret identifiers (a page id, an organization URN) with `config_set`.
- You never read, type, paste or store a token or secret. Give the user the exact
  `connectAction` command from the playbook; they run it and it writes `.env` locally.
- After the user connects a platform, call `health_recheck` with that platform to confirm.

## The approval gate

`plan_create_post` always creates a draft. Only a human approves (`approve_post`), and the
actor that created a post can never approve it. Do not approve posts unless the user tells you
to, post by post. `publish_due_run` publishes for real and needs `confirm: true`; call it only
when the user asks.

## Links

- Docs: https://docs.pendpost.com/mcp-server
- Source: https://github.com/pendpost/pendpost
- Privacy: https://pendpost.com/privacy
