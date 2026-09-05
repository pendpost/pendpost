// test/radar-timezone.test.mjs - L5 (audit 2026-08-31): the Radar daily clock must run in
// the CLIENT'S timezone, not posting.defaultTimezone. The client registry (data/clients.json)
// carries the real operator timezone ("Europe/Zurich"); posting.defaultTimezone often stays
// at its "UTC" default - resolving dailyAt against it made a configured 09:00 fire at 11:00
// local. radarTimezone() is the ONE resolver every gate and the nextScan derivation use:
// client registry timezone first, then posting.defaultTimezone, then UTC.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-tz-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data'), { recursive: true });

try {
  const { radarTimezone, dueDailyAt } = await import('../lib/radar-sweep.mjs');
  const { getPosting } = await import('../lib/config.mjs');
  const { withClient, invalidateRegistryCache } = await import('../lib/context.mjs');
  const { clientRoot } = await import('../lib/multi-client.mjs');

  // ---- un-migrated workspace (no clients.json): fall back to posting.defaultTimezone ----
  ok(radarTimezone({ defaultTimezone: 'Europe/Berlin' }) === 'Europe/Berlin',
    'no client registry => posting.defaultTimezone wins');
  ok(radarTimezone({}) === 'UTC', 'no registry, no defaultTimezone => UTC');
  ok(radarTimezone() === getPosting().defaultTimezone || radarTimezone() === 'UTC',
    'posting argument is optional (defaults to getPosting())');

  // ---- migrated workspace: the client registry timezone WINS over defaultTimezone ----
  fs.writeFileSync(path.join(WS, 'data', 'clients.json'), JSON.stringify({
    activeClientId: 'acme',
    clients: [
      { id: 'acme', displayName: 'Acme', status: 'active', timezone: 'Europe/Zurich' },
      { id: 'other', displayName: 'Other', status: 'active' },
    ],
  }));
  invalidateRegistryCache();
  fs.mkdirSync(clientRoot('acme'), { recursive: true });

  ok(radarTimezone({ defaultTimezone: 'UTC' }) === 'Europe/Zurich',
    'L5 regression: client registry timezone (Europe/Zurich) beats posting.defaultTimezone (UTC)');

  // A bound client without a registry timezone falls back to posting.defaultTimezone.
  fs.mkdirSync(clientRoot('other'), { recursive: true });
  const tzOther = withClient(clientRoot('other'), () => radarTimezone({ defaultTimezone: 'America/New_York' }));
  ok(tzOther === 'America/New_York', 'a client with NO registry timezone falls back to defaultTimezone');

  // ---- the observed live defect, end to end through the real gate ----
  // Owner configures dailyAt 09:00; client tz Europe/Zurich; defaultTimezone UTC.
  // At 07:30Z (= 09:30 Zurich, summer) the gate must be OPEN in the client's timezone -
  // the old defaultTimezone resolution kept it closed until 09:00Z (11:00 local).
  const NOW = Date.parse('2026-07-21T07:30:00Z');
  const tz = radarTimezone({ defaultTimezone: 'UTC' });
  ok(dueDailyAt(null, '09:00', tz, NOW) === true,
    'dailyAt 09:00 + client tz Europe/Zurich => due at 09:30 Zurich time (07:30Z)');
  ok(dueDailyAt(null, '09:00', 'UTC', NOW) === false,
    '(control) the old UTC resolution would still be holding - the bug this test pins');

  assert.ok(failures === 0, `${failures} assertion(s) failed`);
  console.log(`[radar-timezone] OK - client registry timezone first, then posting.defaultTimezone, then UTC (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-timezone] FAIL - ${err.stack || err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
