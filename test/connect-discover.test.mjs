// connect-discover.test.mjs - connected-account discovery (spec 22, Pattern P3/P4/P9)
// run end-to-end through the REAL engine entrypoints, credential-free.
//
// Proofs per lane, no network:
//   1. mock `discover` returns the normalized row { platform, action:'discover',
//      ok:true, identity:{id,handle,name}, assets:[…], selected:{…} } - the one shape
//      every discover-capable lane shares.
//   2. an identifier-bearing lane's selected maps its config key -> the picked id, and
//      exactly one asset is current:true.
//   3. an ungranted lane degrades to a { ok:false, error:'needs_scope', scope } ROW
//      via the mock ungranted signal (P9) - the top envelope stays ok:true (no throw).
//   4. the LIVE path with NO credentials degrades to an ok:false needs_scope row too -
//      a genuine degrade proof that still touches no network (readEnv, not requireEnv,
//      so nothing process.exit-s past the --json envelope).
//
// Also asserts the shared lib faces: the lib connectDiscover() maps the engine row to
// the read shape, and an unsupported platform is a clean invalid_input.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DISCOVER_LANES, DISCOVER_SCRIPT, DISCOVER_IDENTIFIER, markCurrent, discoverNeedsScope } from '../lib/discovery.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-discover-'));

function runEngine(lane, extraEnv = {}) {
  const out = execFileSync(process.execPath, [path.join(REPO, DISCOVER_SCRIPT[lane]), 'discover', '--json'], {
    cwd: REPO,
    env: { ...process.env, PENDPOST_ROOT: WS, ...extraEnv },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop());
}

// The discover ROW carried on RUN.results (the single account-discovery row).
function discoverRow(envelope) {
  return Array.isArray(envelope.results) ? envelope.results.find((r) => r && r.action === 'discover') : null;
}
function isIdentity(id) {
  return id && typeof id === 'object'
    && typeof id.id === 'string'
    && (id.handle === null || typeof id.handle === 'string')
    && typeof id.name === 'string' && id.name.length > 0;
}
function isAsset(a) {
  return a && typeof a === 'object'
    && typeof a.kind === 'string' && a.kind
    && typeof a.id === 'string' && a.id
    && typeof a.name === 'string'
    && typeof a.current === 'boolean';
}

try {
  ok(DISCOVER_LANES.length === 8, `eight discover-capable lanes registered (got ${DISCOVER_LANES.length})`);

  // markCurrent decides which asset is "current" purely by id-equality with the sealed
  // identifier - the core compliance behavior. Lock it directly (never mutates input).
  const mcInput = [{ kind: 'board', id: 'a', name: 'A' }, { kind: 'board', id: 'b', name: 'B' }];
  const mcOut = markCurrent(mcInput, 'b');
  ok(mcOut[0].current === false && mcOut[1].current === true, 'markCurrent flips ONLY the id-matching asset to current:true');
  ok(markCurrent(mcInput, null).every((a) => a.current === false), 'markCurrent(_, null) marks NOTHING current');
  ok(mcInput.every((a) => !('current' in a)), 'markCurrent returns a fresh array and never mutates its input');

  // discoverNeedsScope carries an OPTIONAL identity (spec §2: identity still shows on
  // scope-not-granted - the LinkedIn userinfo-then-ACLs path relies on this).
  const nsBare = discoverNeedsScope('linkedin');
  ok(nsBare.ok === false && nsBare.error === 'needs_scope' && !('identity' in nsBare), 'discoverNeedsScope without identity omits the identity field');
  const nsId = discoverNeedsScope('linkedin', null, { id: 'urn:li:person:1', handle: null, name: 'Jane Doe' });
  ok(nsId.identity && nsId.identity.name === 'Jane Doe', 'discoverNeedsScope carries identity when the lane read WHO before the scope 403 (spec §2)');

  for (const lane of DISCOVER_LANES) {
    // 1. mock discover -> a normalized ok:true row
    const env = runEngine(lane, { PENDPOST_MODE: 'mock' });
    ok(env.ok === true, `${lane}: engine envelope ok:true (never a throw past the envelope)`);
    const row = discoverRow(env);
    ok(row && row.ok === true && row.platform === lane, `${lane}: mock discover returns an ok:true discover row for the lane`);
    ok(row && isIdentity(row.identity), `${lane}: row carries identity { id, handle, name }`);
    ok(row && Array.isArray(row.assets) && row.assets.length > 0 && row.assets.every(isAsset), `${lane}: row carries normalized assets [{ kind, id, name, current }]`);
    ok(row && row.selected && typeof row.selected === 'object', `${lane}: row carries a selected map`);

    // 2. exactly one asset is current; an identifier lane maps its config key -> picked id
    const currents = (row.assets || []).filter((a) => a.current);
    ok(currents.length === 1, `${lane}: exactly one asset is current:true`);
    const idKey = DISCOVER_IDENTIFIER[lane];
    if (idKey) {
      ok(Object.prototype.hasOwnProperty.call(row.selected, idKey) && row.selected[idKey] === currents[0].id,
        `${lane}: selected.${idKey} equals the current asset id (the pick target)`);
    } else {
      ok(Object.keys(row.selected).length === 0, `${lane}: single-identity lane sends an empty selected (no pickable identifier)`);
    }

    // 3. ungranted (mock signal) -> needs_scope ROW, top envelope still ok:true
    const ung = runEngine(lane, { PENDPOST_MODE: 'mock', PENDPOST_MOCK_UNGRANTED: lane });
    ok(ung.ok === true, `${lane}: ungranted top envelope stays ok:true (degrade, never throw)`);
    const ungRow = discoverRow(ung);
    ok(ungRow && ungRow.ok === false && ungRow.error === 'needs_scope' && typeof ungRow.scope === 'string',
      `${lane}: ungranted discover degrades to a needs_scope row (P9)`);

    // 4. LIVE with NO creds -> ok:false needs_scope row, no network, no process.exit
    const live = runEngine(lane);
    ok(live.ok === true, `${lane}: LIVE-no-creds top envelope stays ok:true (readEnv, not requireEnv)`);
    const liveRow = discoverRow(live);
    ok(liveRow && liveRow.ok === false && typeof liveRow.error === 'string',
      `${lane}: LIVE discover with no creds yields an ok:false row (never a throw past the envelope)`);
  }

  // The lib face (connectDiscover) maps the engine row to the read shape + rejects an
  // unsupported platform. Run under PENDPOST_MODE=mock so the spawned engine mocks.
  process.env.PENDPOST_ROOT = WS;
  process.env.PENDPOST_MODE = 'mock';
  const { connectDiscover } = await import('../lib/writes.mjs');
  const yt = await connectDiscover({ platform: 'youtube' });
  ok(yt.ok === true && yt.connected === true && isIdentity(yt.identity) && yt.assets.length > 0,
    'connectDiscover(youtube) maps the engine row to { ok, connected, identity, assets, selected }');
  ok(yt.selected && yt.selected.ytChannelId, 'connectDiscover(youtube) surfaces the pickable identifier in selected');
  const bad = await connectDiscover({ platform: 'meta' });
  ok(bad.ok === false && bad.code === 'invalid_input', 'connectDiscover(meta) is a clean invalid_input (not a discover lane)');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[connect-discover] OK - connected-account discovery reads a normalized identity+assets and degrades cleanly across all eight lanes (${pass} assertions).`);
} catch (err) {
  console.error(`[connect-discover] FAIL - ${err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
