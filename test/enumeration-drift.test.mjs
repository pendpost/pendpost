#!/usr/bin/env node
// test/enumeration-drift.test.mjs - the spec 39 §7a guard over two hand-duplicated
// tables that must agree but cannot share code (the app cannot import server
// modules, and the scheduler deliberately inlines its media predicate):
//
//   1. lib/carousel.mjs CAROUSEL_LANE_LIMITS (server: the validator + engines +
//      mock driver) vs app/src/components/Composer.jsx CAROUSEL_LANE_MAX (client:
//      the slide-count affordance). Drift means the Composer either offers a
//      slide count Pruefen rejects, or blocks a lawful one.
//   2. lib/plans.mjs postNeedsMedia (the media-less TYPE exclusion list) vs the
//      literally-duplicated copy inside lib/scheduler.mjs eligibleDuePosts
//      (flagged by the comment beside postNeedsMedia). Drift strands or empties
//      posts of a new TYPE (the §99 hotspot-table risk).
//
// Shape: regex-read the duplicated literals out of the source files and fail on
// disagreement - the repo's established cheap-CI-guard discipline
// (test/supply-chain.test.mjs, test/i18n-pack.test.mjs read source the same way).
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAROUSEL_LANE_LIMITS } from '../lib/carousel.mjs';
import { postNeedsMedia } from '../lib/plans.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

// ===== 1. carousel lane caps: server table vs Composer literal =====
{
  const composerSrc = fs.readFileSync(path.join(REPO, 'app', 'src', 'components', 'Composer.jsx'), 'utf8');
  const m = composerSrc.match(/const CAROUSEL_LANE_MAX = \{([^}]*)\}/);
  ok(m, 'Composer.jsx declares the CAROUSEL_LANE_MAX literal (the client half of the duplicated table)');
  const client = {};
  for (const pair of m[1].split(',')) {
    const kv = pair.match(/\s*(\w+):\s*(\d+)/);
    if (kv) client[kv[1]] = Number(kv[2]);
  }
  const serverLanes = Object.keys(CAROUSEL_LANE_LIMITS).sort();
  const clientLanes = Object.keys(client).sort();
  ok(serverLanes.join(',') === clientLanes.join(','),
    `carousel lanes agree server<->client (server: ${serverLanes.join(',')} / client: ${clientLanes.join(',')})`);
  for (const lane of serverLanes) {
    ok(CAROUSEL_LANE_LIMITS[lane].maxItems === client[lane],
      `carousel cap for ${lane} agrees (server ${CAROUSEL_LANE_LIMITS[lane].maxItems} == client ${client[lane]})`);
  }

  // H4: the noMix rule is the SECOND hand-copy of the same server table, and it is
  // guarded on arrival rather than after the second miss. The Composer disables an
  // image option once a video slide is picked (and the reverse) on a noMix lane; if the
  // two tables drifted, it would either allow a mix Pruefen rejects, or block a lawful
  // pick with a reason that is not true.
  const nm = composerSrc.match(/const CAROUSEL_LANE_NOMIX = \{([^}]*)\}/);
  ok(nm, 'Composer.jsx declares the CAROUSEL_LANE_NOMIX literal (the client half of the mix rule)');
  const clientNoMix = {};
  for (const pair of nm[1].split(',')) {
    const kv = pair.match(/\s*(\w+):\s*(true|false)/);
    if (kv) clientNoMix[kv[1]] = kv[2] === 'true';
  }
  const serverNoMix = serverLanes.filter((l) => CAROUSEL_LANE_LIMITS[l].noMix === true).sort();
  const clientNoMixLanes = Object.keys(clientNoMix).filter((l) => clientNoMix[l]).sort();
  ok(serverNoMix.join(',') === clientNoMixLanes.join(','),
    `carousel noMix lanes agree server<->client (server: ${serverNoMix.join(',') || 'none'} / client: ${clientNoMixLanes.join(',') || 'none'})`);
  for (const lane of Object.keys(clientNoMix)) {
    ok(serverLanes.includes(lane), `noMix lane ${lane} is a real carousel lane on the server`);
  }
}

// ===== 1b. the TYPES enum: THREE hand copies, membership AND order =====
// P2. TYPES is copied verbatim into lib/writes.mjs (the save validator), lib/mcp.mjs
// (the agent-facing tool schema enum) and app/src/lib/format.js (the Composer's format
// menu). Nothing guarded them, and this plan pivots on type identity in three separate
// places. ORDER matters as much as membership: format.js's copy is the MENU order the
// operator sees, so a reordered copy silently reshuffles the picker.
{
  const read = (file, re) => {
    const src = fs.readFileSync(path.join(REPO, file), 'utf8');
    const m = src.match(re);
    ok(m, `${file} declares its TYPES literal where the guard can read it`);
    return m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
  };
  const writesTypes = read('lib/writes.mjs', /const TYPES = \[([^\]]*)\]/);
  const mcpTypes = read('lib/mcp.mjs', /type: \{ type: 'string', enum: \[([^\]]*)\]/);
  const appTypes = read(path.join('app', 'src', 'lib', 'format.js'), /export const TYPES = \[([^\]]*)\]/);

  ok(writesTypes.length > 0, `writes.mjs TYPES is non-empty (${writesTypes.length} types)`);
  ok(writesTypes.join(',') === mcpTypes.join(','),
    `TYPES agree writes<->mcp in membership AND order (writes: ${writesTypes.join(',')} / mcp: ${mcpTypes.join(',')})`);
  ok(writesTypes.join(',') === appTypes.join(','),
    `TYPES agree writes<->app in membership AND order - order IS the Composer menu order (app: ${appTypes.join(',')})`);
}

// ===== 2. the media-less TYPE predicate: plans.mjs vs the scheduler inline copy =====
{
  const schedulerSrc = fs.readFileSync(path.join(REPO, 'lib', 'scheduler.mjs'), 'utf8');
  // The scheduler's inline copy is a chain of `post.type !== '<t>'` guards before
  // the media.exists gate - extract every excluded type from that one line.
  const line = schedulerSrc.split('\n').find((l) => /post\.type !== '/.test(l) && /media\.exists/.test(l));
  ok(line, 'scheduler.mjs carries the inline media-predicate line (post.type !== ... && !post.media.exists)');
  const schedTypes = [...line.matchAll(/post\.type !== '([^']+)'/g)].map((x) => x[1]).sort();
  // The canonical list, derived by probing postNeedsMedia itself (no regex on plans.mjs
  // needed - the exported function IS the source of truth).
  const ALL_TYPES = ['reel', 'story', 'video', 'text', 'youtube-short', 'youtube-longform', 'poll', 'carousel', 'image', 'nostr-longform'];
  const mediaLess = ALL_TYPES.filter((t) => !postNeedsMedia({ type: t })).sort();
  ok(schedTypes.join(',') === mediaLess.join(','),
    `media-less TYPE exclusions agree plans<->scheduler (plans: ${mediaLess.join(',')} / scheduler: ${schedTypes.join(',')})`);
}

console.log(`\n[enumeration-drift] OK - the two hand-duplicated tables agree (${pass} assertions).`);
