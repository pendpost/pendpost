#!/usr/bin/env node
// test/comment-watch-config.test.mjs - the posting.commentWatch subtree (own-post
// comment monitoring). A top-level posting sibling (like digest/review/relationshipMemory),
// NOT nested under radar: the code keeps own-post comments distinct from radar's external
// signals (lib/comments.mjs boundary), so its config is a sibling, not a radar rider.
//
// Pins: full-shape default re-merge (fail-closed enabled:false), the validator (interval /
// window bounds + per-lane opt-out shape + unknown-key refusal), and that it is
// agent-writable (a read sweep + manual reply surface, not autonomy - so NOT owner-only).
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ok - ${m}`); } else { failures += 1; console.error(`  FAIL - ${m}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-cw-cfg-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

try {
  const { getConfig, setConfig } = await import('../lib/config.mjs');
  const cw = () => getConfig().posting.commentWatch;
  const write = (v, actor = 'agent:claude') => setConfig({ ifRev: getConfig().rev, actor, set: { posting: { commentWatch: v } } });

  // 1. Full-shape default, fail-closed.
  const d = cw();
  ok(d && typeof d === 'object', 'commentWatch is always present as an object');
  ok(d.enabled === false, 'enabled defaults false (fail-closed beta gate)');
  ok(d.intervalHours === 4, 'intervalHours defaults 4');
  ok(d.windowDays === 14, 'windowDays defaults 14');
  ok(d.lanes && typeof d.lanes === 'object' && !Array.isArray(d.lanes), 'lanes defaults to an object');

  // 2. Agent-writable (NOT owner-only): an agent may turn monitoring on.
  const r1 = write({ enabled: true, intervalHours: 6 });
  ok(r1 && r1.ok !== false, 'an agent actor may write commentWatch (not owner-only)');
  ok(cw().enabled === true && cw().intervalHours === 6, 'the write persists');

  // 3. Partial persist re-merges to full shape (a caller never sees a missing key).
  ok(cw().windowDays === 14, 'a partial write keeps the other keys at their default');

  // 4. Per-lane opt-out shape: { [lane]: { watch: boolean } }.
  const r2 = write({ lanes: { youtube: { watch: false } } });
  ok(r2 && r2.ok !== false, 'a per-lane opt-out is accepted');
  ok(cw().lanes.youtube.watch === false, 'the per-lane opt-out persists');

  // 5b. A LATER partial write shallow-merges onto the stored subtree (like radar/review):
  //     turning monitoring on, then changing ONLY the window, must not silently disable it.
  write({ enabled: true, intervalHours: 6 });
  write({ windowDays: 30 });
  ok(cw().enabled === true, 'a later partial write (windowDays) preserves the stored enabled:true');
  ok(cw().intervalHours === 6, 'a later partial write preserves the stored custom intervalHours');
  ok(cw().windowDays === 30, 'the later partial write applied its own key');

  // 6. Validator refusals (errorBody returns { code:'invalid_input', message } - no ok field).
  const refused = (v) => write(v).code === 'invalid_input';
  ok(refused({ intervalHours: 0 }), 'intervalHours below 1 is refused');
  ok(refused({ intervalHours: 999 }), 'an out-of-bounds intervalHours is refused');
  ok(refused({ windowDays: 0 }), 'windowDays below 1 is refused');
  ok(refused({ enabled: 'yes' }), 'a non-boolean enabled is refused');
  ok(refused({ lanes: { notalane: { watch: true } } }), 'a lane that is not comment-capable is refused');
  ok(refused({ bogus: 1 }), 'an unknown key is refused');
} catch (err) {
  failures += 1;
  console.error('  FAIL - threw:', (err && err.stack) || err);
}

fs.rmSync(WS, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
