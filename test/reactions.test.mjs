#!/usr/bin/env node
// test/reactions.test.mjs - react as the brand (spec 24, Pattern P3 engine verb + P4
// parity pair + P9 mock-first). Proves, credential-free, no network:
//
//   ENGINE (mock, per lane):
//     1. every reaction in a lane's COMMENT_CAPABILITIES.react array returns
//        { ok:true, id } + a { action:'react', reaction, removed:false } row (no offered
//        reaction is unsupported - the table can never over-promise the verb).
//     2. a repeat same reaction is IDEMPOTENT (same end state); --remove un-reacts
//        (removed:true) where the lane supports it.
//     3. a reaction the lane does NOT support returns { ok:false, error:'unsupported_reaction' }.
//     4. an ungranted token (PENDPOST_MOCK_UNGRANTED) degrades to needs_scope (never a throw).
//
//   CONSISTENCY (the four faces cannot drift):
//     5. REACT_ACTIONS == the UNION of every lane's react array.
//     6. the react_to_post tool's reaction enum == REACT_ACTIONS; it is a WRITE tool with
//        clientId + actor, idempotent + open-world + NOT destructive; reddit is trimmed to
//        [] (ToS-safe only) and offers NO react anywhere.
//
//   TOOL (handleMcp, Pattern P4):
//     7. a supported reaction returns ok:true; a repeat is idempotent; remove un-reacts.
//     8. an unsupported reaction surfaces error:'unsupported_reaction'; an ungranted scope
//        surfaces not_configured; requireActor rejects 'unknown'.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

// A throwaway root, set BEFORE importing lib (WORKSPACE_ROOT binds at import).
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-reactions-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

// The five react-capable lanes (spec 24) + a sample comment/mention id. The emoji lanes
// carry a glyph so the --emoji path is exercised too.
const ENGINES = {
  linkedin: { script: 'scripts/linkedin-social.mjs', cid: 'urn:li:comment:1' },
  mastodon: { script: 'scripts/mastodon-social.mjs', cid: 'st_1' },
  nostr: { script: 'scripts/nostr-social.mjs', cid: 'ev_1' },
  telegram: { script: 'scripts/telegram-social.mjs', cid: '123', emoji: '👍' },
  discord: { script: 'scripts/discord-social.mjs', cid: 'dc_1', emoji: '🎉' },
};

function runEngine(script, args, extraEnv = {}) {
  const out = execFileSync(process.execPath, [path.join(REPO, script), ...args], {
    cwd: REPO, env: { ...process.env, PENDPOST_ROOT: WS, PENDPOST_MODE: 'mock', ...extraEnv }, encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop());
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function rpc(handleMcp, msg) {
  const req = Readable.from([Buffer.from(JSON.stringify(msg), 'utf8')]);
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json' };
  const chunks = [];
  const res = new Writable({ write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); } });
  res.writeHead = () => {};
  await handleMcp(req, res);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : null;
}
let nextId = 200;
async function call(handleMcp, name, args) {
  const reply = await rpc(handleMcp, { jsonrpc: '2.0', id: (nextId += 1), method: 'tools/call', params: { name, arguments: args } });
  const result = reply && reply.result;
  const payload = result && result.content && result.content[0] ? JSON.parse(result.content[0].text) : null;
  return { isError: Boolean(result && result.isError), payload };
}

try {
  const { COMMENT_CAPABILITIES, REACT_ACTIONS } = await import('../lib/comments.mjs');

  // ===== (1-4) ENGINE per-lane matrix (mock) =====
  for (const [lane, def] of Object.entries(ENGINES)) {
    const supported = COMMENT_CAPABILITIES[lane].react;
    ok(supported.length > 0, `${lane}: has a non-empty react set`);
    const emojiArgs = def.emoji ? ['--emoji', def.emoji] : [];
    for (const reaction of supported) {
      // (1) every offered reaction is implemented (GUI honesty - no unsupported).
      const env = runEngine(def.script, ['react', '--comment-id', def.cid, '--reaction', reaction, ...emojiArgs, '--json', '--actor', 'owner']);
      const row = (env.results || []).find((r) => r.action === 'react');
      ok(env.ok === true && typeof env.id === 'string' && env.id, `${lane}/${reaction}: mock react returns { ok:true, id }`);
      ok(row && row.ok === true && row.reaction === reaction && row.removed === false && row.platform === lane, `${lane}/${reaction}: row carries { action:'react', reaction, removed:false, platform }`);
      // (2) a repeat same reaction is idempotent (identical end state).
      const again = runEngine(def.script, ['react', '--comment-id', def.cid, '--reaction', reaction, ...emojiArgs, '--json', '--actor', 'owner']);
      ok(eq(env, again), `${lane}/${reaction}: a repeat react is idempotent (same end state)`);
      // (2) --remove un-reacts (removed:true).
      const removed = runEngine(def.script, ['react', '--comment-id', def.cid, '--reaction', reaction, ...emojiArgs, '--remove', '--json', '--actor', 'owner']);
      const remRow = (removed.results || []).find((r) => r.action === 'react');
      ok(removed.ok === true && remRow && remRow.removed === true, `${lane}/${reaction}: --remove un-reacts (removed:true)`);
    }
    // (3) a reaction outside the lane's set is a structured unsupported_reaction.
    const unsupported = REACT_ACTIONS.find((a) => !supported.includes(a));
    const uns = runEngine(def.script, ['react', '--comment-id', def.cid, '--reaction', unsupported, ...emojiArgs, '--json', '--actor', 'owner']);
    ok(uns.ok === false && uns.error === 'unsupported_reaction' && uns.lane === lane, `${lane}: an unsupported reaction (${unsupported}) returns { ok:false, error:'unsupported_reaction', lane }`);
    // (4) an ungranted token degrades to needs_scope on the mock signal (P9).
    const ung = runEngine(def.script, ['react', '--comment-id', def.cid, '--reaction', supported[0], ...emojiArgs, '--json', '--actor', 'owner'], { PENDPOST_MOCK_UNGRANTED: lane });
    ok(ung.ok === false && ung.error === 'needs_scope' && typeof ung.scope === 'string', `${lane}: an ungranted token degrades to needs_scope (P9)`);
  }

  // A LIVE path (no mode) with NO credentials returns a REAL needs_scope (no network).
  const liveMastodon = runEngine('scripts/mastodon-social.mjs', ['react', '--comment-id', 'st_1', '--reaction', 'favourite', '--json', '--actor', 'owner'], { PENDPOST_MODE: '' });
  ok(liveMastodon.ok === false && liveMastodon.error === 'needs_scope', 'mastodon: LIVE react with no creds degrades to needs_scope (no network)');

  // ===== (5-6) CONSISTENCY: table <-> verb <-> tool cannot drift =====
  const union = [...new Set(Object.values(COMMENT_CAPABILITIES).flatMap((c) => c.react))];
  ok(eq([...REACT_ACTIONS], union), `REACT_ACTIONS is the UNION of every lane's react array: ${union.join(',')}`);
  // reddit is TRIMMED to [] (ToS-safe only): programmatic voting is prohibited, so reddit
  // offers NO react in the table, the verb, or (transitively) the GUI/mock.
  ok(COMMENT_CAPABILITIES.reddit.react.length === 0, 'reddit react is trimmed to [] (ToS-safe program - no vote manipulation)');
  // The react-capable lanes are EXACTLY linkedin/mastodon/nostr/telegram/discord.
  const capable = Object.entries(COMMENT_CAPABILITIES).filter(([, c]) => c.react.length > 0).map(([l]) => l).sort();
  ok(eq(capable, ['discord', 'linkedin', 'mastodon', 'nostr', 'telegram']), `the react-capable lanes are exactly linkedin/mastodon/nostr/telegram/discord (got ${capable.join(',')})`);

  const { TOOLS, handleMcp } = await import('../lib/mcp.mjs');
  const tool = TOOLS.find((t) => t.name === 'react_to_post');
  ok(tool, 'react_to_post is registered in TOOLS');
  ok(eq(tool.inputSchema.properties.reaction.enum, [...REACT_ACTIONS]), 'the react_to_post tool reaction enum == REACT_ACTIONS (one source, no drift)');
  const props = tool.inputSchema.properties;
  ok('clientId' in props && 'actor' in props && 'remove' in props && 'emoji' in props, 'react_to_post schema has clientId + actor + remove + emoji');
  ok(['actor', 'campaign', 'postId', 'commentId', 'reaction'].every((k) => tool.inputSchema.required.includes(k)), 'react_to_post requires actor + campaign + postId + commentId + reaction');
  ok(!('confirm' in props), 'react_to_post is NOT confirm-gated (react is not destructive)');

  // The tools/list annotations: idempotent + open-world, NOT destructive, NOT read-only.
  await rpc(handleMcp, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  const listed = await rpc(handleMcp, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const listedTool = (listed?.result?.tools || []).find((t) => t.name === 'react_to_post');
  ok(listedTool && listedTool.annotations, 'react_to_post is served with annotations');
  ok(listedTool.annotations.idempotentHint === true, 'react_to_post is idempotentHint:true');
  ok(listedTool.annotations.openWorldHint === true, 'react_to_post is openWorldHint:true');
  ok(listedTool.annotations.destructiveHint === false, 'react_to_post is NOT destructive (destructiveHint:false)');
  ok(listedTool.annotations.readOnlyHint === false, 'react_to_post is a WRITE tool (readOnlyHint:false)');

  // ===== (7-8) TOOL: happy path + idempotent + un-react + honest failures, via handleMcp =====
  const { initMultiClient, clientRoot } = await import('../lib/multi-client.mjs');
  initMultiClient();
  const plansDir = path.join(clientRoot('default'), 'data', 'plans');
  fs.mkdirSync(path.join(plansDir, 'c'), { recursive: true });
  fs.writeFileSync(path.join(plansDir, 'active-plans.json'), JSON.stringify({ plans: [{ id: 'c', path: 'data/plans/c/post-plan.json', active: true }] }, null, 2));
  fs.writeFileSync(path.join(plansDir, 'c', 'post-plan.json'), JSON.stringify({
    campaign: 'c', timezone: 'UTC',
    posts: [{ id: 'p1', platforms: ['mastodon'], status: 'posted', mastodonStatusId: 'ST1', approval: 'approved', scheduledAt: '2020-01-01T00:00:00Z' }],
  }, null, 2));

  // (7) a supported reaction returns ok:true.
  const fav = await call(handleMcp, 'react_to_post', { campaign: 'c', postId: 'p1', commentId: 'st_1', reaction: 'favourite', actor: 'owner' });
  ok(!fav.isError && fav.payload.ok === true && fav.payload.reaction === 'favourite' && fav.payload.platform === 'mastodon' && fav.payload.removed === false, 'react_to_post favourite on a mastodon post returns { ok:true, reaction:"favourite", removed:false }');
  // idempotent: a repeat same reaction is ok:true (same end state).
  const favAgain = await call(handleMcp, 'react_to_post', { campaign: 'c', postId: 'p1', commentId: 'st_1', reaction: 'favourite', actor: 'owner' });
  ok(!favAgain.isError && favAgain.payload.ok === true && favAgain.payload.reaction === 'favourite', 'react_to_post is idempotent (a repeat favourite is ok:true, same end state)');
  // remove un-reacts.
  const unfav = await call(handleMcp, 'react_to_post', { campaign: 'c', postId: 'p1', commentId: 'st_1', reaction: 'favourite', actor: 'owner', remove: true });
  ok(!unfav.isError && unfav.payload.ok === true && unfav.payload.removed === true, 'react_to_post remove:true un-reacts (removed:true)');

  // requireActor rejects empty/unknown.
  const noActor = await call(handleMcp, 'react_to_post', { campaign: 'c', postId: 'p1', commentId: 'st_1', reaction: 'favourite', actor: 'unknown' });
  ok(noActor.isError && noActor.payload.code === 'invalid_input', 'react_to_post rejects actor "unknown" (requireActor)');

  // (8) an unsupported reaction for the lane is rejected. 'like' is a valid enum member
  // (linkedin/nostr) but mastodon does not support it -> the lib pre-guard rejects it
  // WITHOUT spawning an engine (GUI honesty). Over MCP (the generic WRITE_TOOLS dispatch)
  // it surfaces as code:invalid_input + an honest "does not support" message; the
  // structured error:'unsupported_reaction' is asserted on the lib/REST face below.
  const unsupportedTool = await call(handleMcp, 'react_to_post', { campaign: 'c', postId: 'p1', commentId: 'st_1', reaction: 'like', actor: 'owner' });
  ok(unsupportedTool.isError && unsupportedTool.payload.code === 'invalid_input' && /does not support/.test(unsupportedTool.payload.message || ''), 'react_to_post like on a mastodon post is rejected (invalid_input, "does not support") - GUI honesty');

  // an ungranted scope surfaces not_configured (the lib maps the engine needs_scope).
  process.env.PENDPOST_MOCK_UNGRANTED = 'mastodon';
  const ungrantedTool = await call(handleMcp, 'react_to_post', { campaign: 'c', postId: 'p1', commentId: 'st_1', reaction: 'favourite', actor: 'owner' });
  ok(ungrantedTool.isError && ungrantedTool.payload.code === 'not_configured', 'an ungranted scope surfaces not_configured (authorize prompt)');
  delete process.env.PENDPOST_MOCK_UNGRANTED;

  // ===== (9) LIB FACE: reactToPost direct (no-network mock) =====
  const { reactToPost } = await import('../lib/writes.mjs');
  const libReact = await reactToPost({ campaign: 'c', postId: 'p1', commentId: 'st_1', reaction: 'boost', actor: 'owner' });
  ok(libReact.ok === true && libReact.reaction === 'boost' && libReact.platform === 'mastodon', 'reactToPost (lib face) boost returns { ok:true, reaction:"boost", platform:"mastodon" }');
  // an unknown campaign fails cleanly (never throws).
  const libBad = await reactToPost({ campaign: 'nope', postId: 'p1', commentId: 'x', reaction: 'favourite', actor: 'owner' });
  ok(libBad.ok !== true && libBad.code === 'unknown_campaign', 'reactToPost on an unknown campaign returns { ok:false, code:"unknown_campaign" }');
  // an unsupported reaction carries the structured error:'unsupported_reaction' + lane on
  // the lib/REST face (what the Studio panel and a /api/comments/react curl see).
  const libUnsupported = await reactToPost({ campaign: 'c', postId: 'p1', commentId: 'st_1', reaction: 'like', actor: 'owner' });
  ok(libUnsupported.ok !== true && libUnsupported.error === 'unsupported_reaction' && libUnsupported.lane === 'mastodon', 'reactToPost surfaces error:"unsupported_reaction" + lane on the lib/REST face (GUI honesty)');

  // ===== (10) REACT SCOPE table: react has its OWN tier, distinct from the read scope (review #4) =====
  const { LANE_REACT_SCOPE, runLaneReact } = await import('../lib/comments.mjs');
  const { envPath } = await import('../lib/util.mjs');
  ok(LANE_REACT_SCOPE.linkedin === 'w_organization_social_feed', 'linkedin react scope is w_organization_social_feed (NOT the read w_organization_social)');
  ok(!('nostr' in LANE_REACT_SCOPE), 'nostr has NO react scope (client-signed, engine-side - a nostr react never returns needs_scope from the lib)');

  // A LIVE linkedin react with NO creds degrades to needs_scope carrying the REACT tier (not
  // the comment scope) - no network (it fails closed before any fetch).
  fs.writeFileSync(envPath(), '');
  const liveLinkedin = await runLaneReact('linkedin', { 'comment-id': 'urn:li:comment:1', reaction: 'like' });
  ok(liveLinkedin.ok === false && liveLinkedin.error === 'needs_scope' && liveLinkedin.scope === 'w_organization_social_feed', 'linkedin LIVE react with no creds -> needs_scope carrying w_organization_social_feed');

  // ===== (11) nostr react builds a SIGNED NIP-25 kind-7 with e + p tags (engine-side, no relay) =====
  const { keysFromSecret, buildReactionEvent, schnorrVerify } = await import('../scripts/nostr-social.mjs');
  const nkeys = keysFromSecret('0000000000000000000000000000000000000000000000000000000000000003'); // seckey 3 (BIP340 vector)
  const authorPub = 'a'.repeat(64);
  const likeEv = buildReactionEvent(nkeys, 'ev_abc', authorPub, 'like', '');
  ok(likeEv.kind === 7, 'nostr react is a NIP-25 kind-7 event');
  ok(likeEv.content === '+', 'nostr like reaction content is "+"');
  ok(likeEv.tags.some((tt) => tt[0] === 'e' && tt[1] === 'ev_abc'), 'nostr react carries an ["e",<event-id>] tag');
  ok(likeEv.tags.some((tt) => tt[0] === 'p' && tt[1] === authorPub), 'nostr react carries a ["p",<author-pubkey>] tag (routes to the author)');
  const emojiEv = buildReactionEvent(nkeys, 'ev_abc', authorPub, 'emoji', '🎉');
  ok(emojiEv.kind === 7 && emojiEv.content === '🎉', 'nostr emoji reaction content is the glyph');
  // It is GENUINELY signed: the Schnorr sig verifies against the reactor pubkey over the event id.
  ok(schnorrVerify(Buffer.from(likeEv.id, 'hex'), Buffer.from(nkeys.pubHex, 'hex'), Buffer.from(likeEv.sig, 'hex')), 'nostr react event is signed (BIP340 sig verifies)');

  // ===== (12) LinkedIn un-react ENCODES the URN parens/commas; 409 on create is idempotent =====
  // Write live linkedin+mastodon creds so the react REST path runs; stub global fetch (no network).
  fs.writeFileSync(envPath(), [
    'LINKEDIN_ACCESS_TOKEN=tok', 'LINKEDIN_ORG_URN=urn:li:organization:99',
    'MASTODON_INSTANCE_URL=https://m.example', 'MASTODON_ACCESS_TOKEN=tok', '',
  ].join('\n'));
  const origFetch = global.fetch;
  try {
    const commentUrn = 'urn:li:comment:(urn:li:activity:123,456)';
    // Un-react DELETE: capture the URL and assert the entity URN's parens/comma are escaped.
    const calls = [];
    global.fetch = async (url, init = {}) => { calls.push({ url: String(url), method: init.method || 'GET' }); return { ok: true, status: 200, async text() { return '{}'; } }; };
    const un = await runLaneReact('linkedin', { 'comment-id': commentUrn, reaction: 'like', remove: 'true' });
    const del = calls.find((cc) => cc.method === 'DELETE');
    ok(un.ok === true && (un.results || [])[0]?.removed === true, 'linkedin un-react returns ok:true (removed:true)');
    ok(Boolean(del) && del.url.includes('%28') && del.url.includes('%29'), 'linkedin un-react percent-encodes the URN parens (%28/%29) in the Rest.li complex key');
    ok(Boolean(del) && del.url.includes('%2C'), 'linkedin un-react percent-encodes the URN comma (%2C) in the Rest.li complex key');

    // A 409 on CREATE (a reaction already exists) is absorbed as idempotent success (review #3).
    global.fetch = async (url, init = {}) => {
      const method = init.method || 'GET';
      if (method === 'POST') return { ok: false, status: 409, async text() { return '{"message":"reaction exists"}'; } };
      return { ok: true, status: 200, async text() { return '{}'; } }; // the delete-then-recreate DELETE
    };
    const create409 = await runLaneReact('linkedin', { 'comment-id': commentUrn, reaction: 'like' });
    ok(create409.ok === true, 'linkedin 409 on create is idempotent success (ok:true) - the idempotentHint contract holds');

    // ===== (13) mastodon 403 (token lacks the write) -> needs_scope authorize affordance (review #5) =====
    global.fetch = async () => ({ ok: false, status: 403, async text() { return '{"error":"forbidden"}'; } });
    const mast403 = await runLaneReact('mastodon', { 'comment-id': 'st_1', reaction: 'favourite' });
    ok(mast403.ok === false && mast403.error === 'needs_scope' && typeof mast403.scope === 'string', 'mastodon 403 on react degrades to needs_scope (authorize affordance, not a dead-end error)');
  } finally {
    global.fetch = origFetch;
  }

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[reactions] OK - the react verb + tool: per-lane reactions, idempotent + un-react, unsupported/needs_scope degrade, reddit trimmed, table<->verb<->tool consistent (${pass} assertions).`);
} catch (err) {
  console.error(`[reactions] FAIL - ${err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
