// Spec 40 6.3: the one-time step that turns "pendpost has an MCP server" into "my agent
// is holding it". This is the whole ceremony for the agent-native path: connect once,
// and the agent can read the Radar queries and ingest what it finds - keyless, on the
// user's own subscription.
//
// These commands are ALSO in scripts/gen-agents.mjs ("Connecting as an agent"), which
// generates AGENTS.md. The app bundle cannot import the core (same reason format.js
// restates NATIVE_SCHEDULING_PLATFORMS), so they are restated here and pinned by
// test/agent-connect-parity.test.mjs, which fails the moment the two disagree. Change
// one, change both.
export const AGENT_CONNECT = {
  // Claude Code over HTTP. The server must already be running (`npx pendpost`).
  http: 'claude mcp add --transport http pendpost http://127.0.0.1:8090/mcp',
  // Any stdio MCP client. Self-booting, so there is no separate server to start.
  stdio: 'npx -y pendpost --stdio',
};

// The generic stdio config for an MCP client that is configured by file rather than by
// CLI (OpenAI, Gemini, Cursor, Claude Desktop without the bundle). Same stdio entry
// point as AGENT_CONNECT.stdio, expressed as the config block those clients paste.
export const AGENT_CONNECT_JSON = JSON.stringify(
  { mcpServers: { pendpost: { command: 'npx', args: ['-y', 'pendpost', '--stdio'] } } },
  null,
  2,
);
