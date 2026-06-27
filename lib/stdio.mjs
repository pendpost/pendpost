// stdio.mjs - native MCP stdio transport. Reads newline-delimited JSON-RPC from
// stdin, dispatches through the SAME handleRpc the HTTP face (POST /mcp) uses, and
// writes responses to stdout. This is the one-click Claude Desktop / .mcpb path.
//
// stdout is the protocol channel: callers MUST keep every log on stderr
// (bin/pendpost.mjs redirects console.* in --stdio mode). MCP stdio framing is
// newline-delimited JSON; JSON.stringify emits no raw newlines, so one reply is
// one line.
import { handleRpc } from './mcp.mjs';

// Dispatch one parsed JSON-RPC message, never throwing. A thrown handler becomes
// a -32603 for requests and is swallowed for notifications (no id), mirroring the
// per-message isolation in lib/mcp.mjs handleMcp.
async function safe(msg) {
  try {
    return await handleRpc(msg);
  } catch (err) {
    return msg && typeof msg === 'object' && msg.id !== undefined && msg.id !== null
      ? { jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `internal error: ${err.message}` } }
      : null;
  }
}

// Process one input line -> array of reply objects to write (zero or more).
// Handles JSON parse errors and JSON-RPC batches independently. Exported so
// test/stdio-parity.test.mjs can exercise framing without spawning a process.
export async function processLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return [{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }];
  }
  if (Array.isArray(msg)) {
    return (await Promise.all(msg.map(safe))).filter(Boolean);
  }
  const reply = await safe(msg);
  return reply ? [reply] : [];
}

// Wire stdin -> handleRpc -> stdout. Non-blocking: attaches listeners and returns.
// Responses are id-tagged, so out-of-order completion is fine (JSON-RPC allows it).
export function runStdio() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      processLine(line).then((replies) => {
        for (const r of replies) process.stdout.write(`${JSON.stringify(r)}\n`);
      });
    }
  });
  // When the client closes stdin, shut down (this also stops the dashboard server,
  // tying pendpost's lifecycle to the MCP client that launched it).
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
}
