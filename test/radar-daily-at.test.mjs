// test/radar-daily-at.test.mjs - dueDailyAt (owner round 3, point 1): the ONE daily clock
// for both Radar sweeps. Replaces the pure 24h-elapsed gate with "fire on the first tick
// at/after posting.radar.dailyAt if not already run that LOCAL calendar day". Pure
// function, injectable `now`, zero deps - so this suite is wall-clock independent.
import { dueDailyAt } from '../lib/radar-sweep.mjs';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

// Fixed reference: 2026-07-21T10:30:00Z is 12:30 in Europe/Zurich (UTC+2, summer).
const NOW = Date.parse('2026-07-21T10:30:00Z');
const TZ = 'Europe/Zurich';

ok(dueDailyAt(null, '09:00', TZ, NOW) === true, 'past dailyAt and never run => due');
ok(dueDailyAt(null, '14:00', TZ, NOW) === false, 'before dailyAt (local wall clock) => holds');
ok(dueDailyAt('2026-07-21T07:05:00Z', '09:00', TZ, NOW) === false, 'already ran this local day => holds (no second fire)');
ok(dueDailyAt('2026-07-20T07:05:00Z', '09:00', TZ, NOW) === true, 'ran yesterday => due again today');
ok(dueDailyAt(null, '08:00', TZ, NOW) === true, 'missed-today catch-up: dailyAt already past when armed => fires now');
ok(dueDailyAt('2026-07-21T03:00:00Z', '09:00', TZ, NOW) === false, 'upgrade day: a legacy 24h-clock stamp from earlier today suppresses (no double fire)');

// Local-day boundary differs from UTC day. Kiritimati is UTC+14: 2026-07-21T10:30Z is
// already 2026-07-22 00:30 local, so a run stamped 2026-07-21T09:00Z (23:00 local) was
// YESTERDAY local => due again, even though under 24h elapsed and the same UTC day.
ok(dueDailyAt('2026-07-21T09:00:00Z', '00:00', 'Pacific/Kiritimati', NOW) === true, 'local calendar day governs, not UTC and not 24h-elapsed');
ok(dueDailyAt('2026-07-21T09:00:00Z', '00:00', 'UTC', NOW) === false, 'the same stamp in UTC is the same UTC day => holds');

// Fallbacks: invalid tz => UTC, invalid time => 09:00. Never throws, never bricks the tick.
ok(dueDailyAt(null, 'not-a-time', 'Not/AZone', NOW) === true, 'invalid tz/time fall back (UTC, 09:00) => 10:30Z is due');
ok(dueDailyAt('2026-07-21T09:10:00Z', '25:99', 'Not/AZone', NOW) === false, 'fallback clock still suppresses a same-day rerun');
ok(dueDailyAt('garbage', '09:00', TZ, NOW) === true, 'an unparsable last stamp counts as never run');

if (failures) {
  console.error(`[radar-daily-at] ${failures} FAILED (${pass} ok)`);
  process.exit(1);
}
console.log(`[radar-daily-at] OK - the local-day dailyAt clock: fire-at-time, one per local day, catch-up, tz + fallback edges (${pass} assertions).`);
