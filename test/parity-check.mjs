#!/usr/bin/env node
// test/parity-check.mjs - enforces pendpost's parity RULE: every capability
// ships its UI/API face and its MCP face together.
//
// Checks (static analysis, zero-dep):
//   1. Every non-GET route in lib/api.mjs declares an mcpTool that exists in
//      lib/mcp.mjs TOOLS (or is listed in the contract's parity exemptions).
//   2. Every MCP tool is reachable from the API face: it appears as some
//      route's mcpTool, or is exempted in API-CONTRACT.md.
//   3. THE THIRD FACE: every mcpTool-bearing route is reachable from the GUI -
//      its path appears somewhere under app/src - or is declared `agentOnly`
//      WITH a written rationale in API-CONTRACT.md.
//
// Why check 3 exists: checks 1 and 2 prove the API and MCP faces agree with each
// other, and a capability can satisfy both while being completely unreachable in
// the Studio. That is not hypothetical - it is the G1 bug class (a subsystem
// fully wired and MCP-reachable, with no way for the operator to get to it), and
// it was found by hand-tracing rather than by a check. The template has demanded
// three faces from day one ("Every ACTION must map to an engine verb, an MCP tool
// + API route pair, AND a GUI touch-point. No orphan actions." - _TEMPLATE.md),
// but only two of the three were ever enforced.
//
// Check 3 is deliberately a REACHABILITY check, not a proof of use: a string
// match shows the route is referenced in the UI, not that a rendered control
// reaches it. The runtime half of that question is answered by
// `routesHit` in .claude/ui-tests (observed from the browser during a walk).
// Between them: static says "a path exists", runtime says "a human clicking got
// there". Neither alone is the third face.
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
// `agentOnly` is an OBJECT (route -> rationale), not an array, on purpose: a bare
// list of paths accretes silently and stops meaning anything, which is exactly
// how exemption lists rot. Requiring prose per entry makes each one argue for
// itself, and the empty-rationale check below refuses a placeholder.
let exemptions = { routes: [], tools: [], uiOnly: [], agentOnly: {} };
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

// --- check 3: the third face - is the capability reachable from the GUI? ----
// FAIL-CLOSED: if app/src cannot be walked, we do not know, and "we do not know"
// must never render as "fine".
function collectSources(dir) {
  const out = [];
  const walk = (p) => {
    let entries;
    try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) {
        if (e.name === '__tests__' || e.name === 'node_modules') continue;
        walk(full);
      } else if (/\.(js|jsx|mjs|ts|tsx)$/.test(e.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

const APP_SRC = path.join(ROOT, 'app', 'src');
const uiFiles = collectSources(APP_SRC);
if (!uiFiles.length) {
  console.error(`[parity] could not read any UI sources under ${APP_SRC} - cannot prove the GUI face; refusing to pass.`);
  process.exit(1);
}
const uiHaystack = uiFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

const routePaths = new Set(routes.map((r) => r.route));
for (const [route, why] of Object.entries(exemptions.agentOnly)) {
  if (typeof why !== 'string' || why.trim().length < 15) {
    failures.push(`agentOnly exemption for '${route}' has no real rationale - say WHY no GUI surface should reach it, or remove the exemption`);
  }
  // A dead exemption is how an exemption list rots: the route goes away, the
  // carve-out lingers, and the next reader inherits a rule for nothing.
  if (!routePaths.has(route)) {
    failures.push(`agentOnly exemption for '${route}' matches no route in lib/api.mjs - the route is gone, so delete the exemption`);
  }
}

for (const r of routes) {
  if (!r.mcpTool) continue;                       // no MCP face, not this check's business
  if (r.route in exemptions.agentOnly) continue;  // declared agent-only, with a reason
  if (uiHaystack.includes(r.route)) continue;     // referenced somewhere in the Studio
  failures.push(`route ${r.method} ${r.route} (mcpTool '${r.mcpTool}') is never referenced under app/src - an agent can do this but the operator cannot. Add the GUI touch-point, or declare it in the agentOnly exemptions with a rationale.`);
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
  'generate_digest', 'config_get', 'health_recheck', 'agent_recheck', 'client_list', 'clients_overview',
  'cloud_status', 'cloud_capabilities', 'cloud_clients', 'cloud_subscription',
  // The webhook/realtime ingestion seam READ (spec 23); no paired write tool (it only
  // changes what TRIGGERS specs 02/06/24's existing reply/moderate/react writes).
  'list_inbound_events',
  // The inbox seam READ (spec 02); reply_to_comment is the paired WRITE (clientId-checked).
  'list_comments',
  // Connected-account discovery READ (spec 22); its GET twin carries no mcpTool, so
  // connect_discover is exempted from the tool->route map in API-CONTRACT.md.
  'connect_discover',
  // Pre-submit validation reads READ (spec 09); its GET twin names mcpTool:'presubmit_check'
  // directly (like platform_validate), so no API-CONTRACT.md exemption is needed.
  'presubmit_check',
  // YouTube playlists READ (spec 15); its GET twin names mcpTool:'youtube_playlists_list'
  // directly, so no API-CONTRACT.md exemption is needed.
  'youtube_playlists_list',
  // Reddit flairs READ (spec 16); its GET twin names mcpTool:'reddit_list_flairs'
  // directly, so no API-CONTRACT.md exemption is needed.
  'reddit_list_flairs',
  // GBP reviews READ (spec 03); its GET twin names mcpTool:'list_reviews' directly, so
  // no API-CONTRACT.md exemption is needed. reply_to_review is the paired WRITE.
  'list_reviews',
  // Pinterest board sections READ (spec 17); its GET twin names
  // mcpTool:'pinterest_list_board_sections' directly, so no API-CONTRACT.md
  // exemption is needed.
  'pinterest_list_board_sections',
  // GBP location media + attributes READ (spec 19); their GET twins name
  // mcpTool:'gbp_media_list'/'gbp_attributes_get' directly, so no API-CONTRACT.md
  // exemption is needed. gbp_media_add + gbp_attributes_set are the paired WRITEs.
  'gbp_media_list', 'gbp_attributes_get',
  // Pinterest boards READ (spec 29); its GET twin names mcpTool:'pinterest_boards_list'
  // directly, so no API-CONTRACT.md exemption is needed. pinterest_board_create/
  // update + pinterest_board_section_create/update are the paired WRITEs.
  'pinterest_boards_list',
  // Ghost members + newsletters READ (spec 30); their GET twins name
  // mcpTool:'ghost_members'/'ghost_newsletters' directly, so no API-CONTRACT.md
  // exemption is needed. ghost_member_create/ghost_members_import/
  // ghost_newsletter_create/ghost_newsletter_update are the paired WRITEs.
  'ghost_members', 'ghost_newsletters',
  // Social-graph & list actions READ (spec 31); their GET twins name
  // mcpTool:'nostr_relay_list_get'/'nostr_list_get' directly, so no
  // API-CONTRACT.md exemption is needed. mastodon_pin/mastodon_follow/
  // nostr_relay_list_set/nostr_list_set are the paired WRITEs.
  'nostr_relay_list_get', 'nostr_list_get',
  // Radar (beta) listening seam READ (spec 32); their GET twins name
  // mcpTool:'radar_scan'/'radar_list' directly, so no API-CONTRACT.md exemption is
  // needed. Enabling Radar / editing queries reuses the existing config_set write
  // (set.posting.radar) - there is no bespoke Radar write tool in this spec.
  'radar_scan', 'radar_list',
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
const withTool = routes.filter((r) => r.mcpTool).length;
console.log(`[parity] OK - ${routes.length} routes, ${toolNames.length} tools (${READ_ONLY_TOOLS.size} read-only), ${exemptions.uiOnly.length} documented UI-only capabilities, ${withTool} routes with an MCP face of which ${Object.keys(exemptions.agentOnly).length} are declared agent-only.`);
