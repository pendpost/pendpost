#!/usr/bin/env node
// test/insights-mode.test.mjs - A6 (US-INS-05, US-MCP-30): the insights + digest
// read envelopes carry the SAME resolved mock|live mode the engines use
// (resolveMode, lib/mode.mjs), so the dashboard can mark fabricated mock numbers
// honestly and the digest text names which lanes are mock.
//
// Mirrors test/account-mode.test.mjs:
//   PENDPOST_MODE unset (AUTO) -> every lane live (real instances never auto-mock),
//     so the digest discloses NO mock lane.
//   PENDPOST_MODE=mock -> every lane mock; the digest names the mock lanes.
// Platform->lane: stored insights items use platform values instagram/facebook/
//   youtube/linkedin; instagram AND facebook both map to the 'meta' lane.
// Secret-safety: mode is a plain 'mock'|'live' string, never the seeded token.
//
// Zero-dep node:assert. A fresh temp PENDPOST_ROOT is set BEFORE importing lib
// (util binds WORKSPACE_ROOT at import; no clients.json so activeRoot()===WS).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-insmode-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;

// Seed a YouTube credential purely for the secret-safety check below: the token
// value must never appear in the insights/digest envelopes that report mode.
const YT_TOKEN = 'SENTINEL_FULL_ytrefreshtoken_insights_mode_7777_ZXCV';
fs.writeFileSync(path.join(WS, '.env'), `YT_REFRESH_TOKEN=${YT_TOKEN}\n`, { mode: 0o600 });

// An empty active-plans manifest so generateDigest()'s loadPlanStore() never
// returns manifest_error (getInsights() tolerates an unreadable plan store, but
// the digest path needs a valid manifest). No posts -> postMeta is empty, items
// fall back to ids, which is fine for the mode assertions.
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

// Seed stored insights metrics directly in state.json (activeRoot()===WS): an
// Instagram row AND a Facebook row (both meta lane), a LinkedIn row, a YouTube
// row. getInsights() reads state.insights.data verbatim, so no engine spawn is
// needed. loadState caches per-root, so all rows are seeded up front in one
// state.json and never rewritten mid-run.
const now = '2026-06-16T08:00:00.000Z';
fs.writeFileSync(path.join(WS, 'state.json'), JSON.stringify({
  insights: {
    lastFetch: now,
    data: {
      'acme/p1/instagram': { campaign: 'acme', postId: 'p1', platform: 'instagram', metrics: { likes: 12 }, fetchedAt: now, history: [] },
      'acme/p2/facebook': { campaign: 'acme', postId: 'p2', platform: 'facebook', metrics: { likes: 5 }, fetchedAt: now, history: [] },
      'acme/p3/linkedin': { campaign: 'acme', postId: 'p3', platform: 'linkedin', metrics: { likes: 3 }, fetchedAt: now, history: [] },
      'acme/p4/youtube': { campaign: 'acme', postId: 'p4', platform: 'youtube', metrics: { views: 99 }, fetchedAt: now, history: [] },
    },
  },
}, null, 2));

const { getInsights, generateDigest } = await import('../lib/insights.mjs');

try {
  // ---- AUTO (PENDPOST_MODE unset): real instances are always live ------------
  delete process.env.PENDPOST_MODE;
  const auto = getInsights();
  ok(auto.ok, 'getInsights() returns ok');
  ok(auto.mode && typeof auto.mode === 'object', 'getInsights() carries a per-lane resolved mode map (additive field)');
  ok(auto.mode.youtube === 'live' && auto.mode.meta === 'live' && auto.mode.linkedin === 'live',
    'AUTO: every lane resolves to live regardless of credential presence (no auto-mock)');

  // existing consumers untouched: the original envelope fields still present.
  ok(Array.isArray(auto.items) && auto.items.length === 4, 'getInsights() keeps its items array (backward compatible)');
  ok(auto.metricLabels && typeof auto.metricLabels === 'object', 'getInsights() keeps metricLabels (backward compatible)');

  // ---- per-item mode mapped from platform (instagram/facebook -> meta) -------
  const ig = auto.items.find((it) => it.platform === 'instagram');
  const fb = auto.items.find((it) => it.platform === 'facebook');
  const li = auto.items.find((it) => it.platform === 'linkedin');
  const yt = auto.items.find((it) => it.platform === 'youtube');
  ok(ig && ig.mode === 'live', 'AUTO: an instagram item maps to the meta lane and resolves live');
  ok(fb && fb.mode === 'live', 'AUTO: a facebook item ALSO maps to the meta lane and resolves live');
  ok(li && li.mode === 'live', 'AUTO: a linkedin item resolves live');
  ok(yt && yt.mode === 'live', 'AUTO: a youtube item resolves live');

  // ---- PENDPOST_MODE=mock: every lane mock in BOTH envelopes -----------------
  process.env.PENDPOST_MODE = 'mock';
  const forced = getInsights();
  ok(forced.mode.meta === 'mock' && forced.mode.linkedin === 'mock' && forced.mode.youtube === 'mock',
    'PENDPOST_MODE=mock forces every lane to mock in getInsights()');

  // ---- secret-safety: serialized envelope never contains the seeded token ----
  delete process.env.PENDPOST_MODE;
  const insightsJson = JSON.stringify(getInsights());
  ok(!insightsJson.includes(YT_TOKEN), 'getInsights() never leaks the credential value while reporting mode');
  for (const lane of ['meta', 'linkedin', 'youtube']) {
    const m = getInsights().mode[lane];
    ok(m === 'mock' || m === 'live', `getInsights().mode.${lane} is exactly 'mock' or 'live' (got ${m})`);
  }

  // ---- generateDigest(): under AUTO every lane is live, so NO mock disclosure -
  const digest = generateDigest();
  ok(digest.ok && typeof digest.digest === 'string', 'generateDigest() returns a digest string');
  ok(digest.mode && typeof digest.mode === 'object', 'generateDigest() carries a per-lane resolved mode map (additive field)');
  ok(digest.mode.meta === 'live' && digest.mode.linkedin === 'live' && digest.mode.youtube === 'live',
    'AUTO: generateDigest() resolves every lane live');
  ok(!/mock/i.test(digest.digest), 'AUTO: generateDigest() text discloses NO mock lane (real instances never auto-mock)');

  const digestJson = JSON.stringify(generateDigest());
  ok(!digestJson.includes(YT_TOKEN), 'generateDigest() never leaks the credential value');

  // PENDPOST_MODE=mock -> the digest names every lane mock.
  process.env.PENDPOST_MODE = 'mock';
  const digestMock = generateDigest();
  ok(digestMock.mode.meta === 'mock' && digestMock.mode.linkedin === 'mock' && digestMock.mode.youtube === 'mock',
    'PENDPOST_MODE=mock forces every lane to mock in generateDigest()');
  ok(/mock/i.test(digestMock.digest), 'generateDigest() text discloses mock when every lane is mock');
  delete process.env.PENDPOST_MODE;

  console.log(`[insights-mode] OK - live by default on getInsights()/generateDigest(), platform->lane (ig/fb->meta), forced mock disclosed + honoured, no secret leak (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
