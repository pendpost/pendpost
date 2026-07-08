#!/usr/bin/env node
// test/parity-check.mjs - enforces pendpost's parity RULE: every capability
// ships its UI/API face and its MCP face together.
//
// Checks (static analysis, zero-dep):
//   1. Every non-GET route in lib/api.mjs declares an mcpTool that exists in
//      lib/mcp.mjs TOOLS (or is listed in the contract's parity exemptions).
//   2. Every MCP tool is reachable from the API face: it appears as some
//      route's mcpTool, or is exempted in API-CONTRACT.md.
//
// The exemption list lives in docs/plans/platform/API-CONTRACT.md inside
// the fenced ```json block under the "Parity exemptions" heading, so the
// N/A-by-design claims stay auditable next to the contract itself.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// The contract lives INSIDE the repo (a standalone checkout has no parent
// monorepo to reach into); see docs/plans/platform/API-CONTRACT.md.
const CONTRACT = path.join(ROOT, 'docs', 'plans', 'platform', 'API-CONTRACT.md');

const apiSrc = fs.readFileSync(path.join(ROOT, 'lib', 'api.mjs'), 'utf8');
const mcpSrc = fs.readFileSync(path.join(ROOT, 'lib', 'mcp.mjs'), 'utf8');

// --- parse ROUTES entries: method, path|prefix, mcpTool -------------------
// FAIL-CLOSED parsing: an entry that omits the mcpTool key (the violation
// this check exists to catch) must FAIL, not silently vanish. So we first
// count every `method:` declaration and then require each one to parse fully.
const methodCount = (apiSrc.match(/method:\s*'[A-Z]+'/g) || []).length;
const routeRe = /method:\s*'([A-Z]+)',\s*(?:path|prefix):\s*'([^']+)',\s*mcpTool:\s*(?:'([^']+)'|null)/g;
const routes = [];
for (let m; (m = routeRe.exec(apiSrc)); ) {
  routes.push({ method: m[1], route: m[2], mcpTool: m[3] || null });
}
if (!routes.length) {
  console.error('[parity] could not parse any ROUTES entries from lib/api.mjs - the table format changed; update this check.');
  process.exit(1);
}
if (routes.length !== methodCount) {
  console.error(`[parity] FAIL: lib/api.mjs declares ${methodCount} routes but only ${routes.length} parse with an mcpTool key.`);
  console.error('  Every ROUTES entry must be written as { method, path|prefix, mcpTool, handler } - mcpTool may be null for GET routes but the key is mandatory.');
  process.exit(1);
}

// --- parse TOOLS names -----------------------------------------------------
const toolNames = [...mcpSrc.matchAll(/^\s*name:\s*'([a-z0-9_]+)',$/gm)].map((m) => m[1]);
if (!toolNames.length) {
  console.error('[parity] could not parse any TOOLS names from lib/mcp.mjs - the array format changed; update this check.');
  process.exit(1);
}

// --- parse exemptions from the contract ------------------------------------
let exemptions = { routes: [], tools: [], uiOnly: [] };
try {
  const contract = fs.readFileSync(CONTRACT, 'utf8');
  const section = contract.split(/##\s*Parity exemptions/i)[1] || '';
  const block = section.match(/```json\n([\s\S]*?)\n```/);
  if (block) exemptions = { ...exemptions, ...JSON.parse(block[1]) };
} catch (err) {
  console.error(`[parity] cannot read exemptions from ${CONTRACT}: ${err.message}`);
  process.exit(1);
}

const failures = [];

for (const r of routes) {
  if (r.method === 'GET') continue;
  if (exemptions.routes.includes(r.route)) continue;
  if (!r.mcpTool) {
    failures.push(`write route ${r.method} ${r.route} has no mcpTool - the MCP face is missing`);
  } else if (!toolNames.includes(r.mcpTool)) {
    failures.push(`write route ${r.method} ${r.route} names mcpTool '${r.mcpTool}' which does not exist in lib/mcp.mjs`);
  }
}

const mappedTools = new Set(routes.map((r) => r.mcpTool).filter(Boolean));
for (const tool of toolNames) {
  if (mappedTools.has(tool)) continue;
  if (exemptions.tools.includes(tool)) continue;
  failures.push(`MCP tool '${tool}' has no API route counterpart (add mcpTool mapping or exempt it in API-CONTRACT.md)`);
}

// --- multi-client: every WRITE tool accepts an optional clientId -----------
// Per-call client scoping must be available on every write so an agent can
// target a specific client without switching the active one. The read-only set
// is enumerated explicitly; every other tool is a write tool and MUST declare a
// clientId property in its inputSchema. We import TOOLS (not regex the source)
// so the schema is checked structurally.
const READ_ONLY_TOOLS = new Set([
  'plan_list', 'plan_get', 'account_status', 'assets_list', 'activity_log',
  'validate_media', 'platform_validate', 'pendpost_health', 'publish_preview', 'brand_lint',
  'generate_digest', 'config_get', 'health_recheck', 'client_list', 'clients_overview',
  'cloud_status', 'cloud_capabilities', 'cloud_clients', 'cloud_subscription',
]);
const { TOOLS } = await import(path.join(ROOT, 'lib', 'mcp.mjs'));
for (const tool of TOOLS) {
  if (READ_ONLY_TOOLS.has(tool.name)) continue;
  const props = tool.inputSchema && tool.inputSchema.properties;
  if (!props || typeof props !== 'object' || !('clientId' in props)) {
    failures.push(`write tool '${tool.name}' has no optional clientId property in its inputSchema - per-call client scoping is required`);
  }
}

if (failures.length) {
  console.error('[parity] FAIL');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`[parity] OK - ${routes.length} routes, ${toolNames.length} tools (${READ_ONLY_TOOLS.size} read-only), ${exemptions.uiOnly.length} documented UI-only capabilities.`);
