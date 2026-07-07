#!/usr/bin/env node
// test/campaign-internal.test.mjs - setCampaignInternal flags a campaign as
// operator-internal (hidden from Published/Planner/Approvals) WITHOUT touching
// its active/schedulable state. Verifies: the flag defaults false, the manifest
// round-trip preserves the sibling `active` key (a slice-write would drop it),
// the plans reader surfaces `internal`, and a non-boolean is rejected. Mock mode;
// mirrors test/deactivate-parks-posts.test.mjs setup.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-internal-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

const { createCampaign, setCampaignInternal } = await import('../lib/writes.mjs');
const { loadPlanStore } = await import('../lib/plans.mjs');

const CAMP = 'cloud-lane-validation';
const manPath = path.join(WS, 'data', 'plans', 'active-plans.json');
const readCamp = () => loadPlanStore().campaigns.find((c) => c.id === CAMP);
const manEntry = () => JSON.parse(fs.readFileSync(manPath, 'utf8')).plans.find((p) => p.id === CAMP);

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

try {
  await createCampaign({ id: CAMP, note: 'e2e validation', timezone: 'UTC', actor: 'owner' });
  ok(readCamp().internal === false, 'a fresh campaign reads internal=false (absent key defaults false)');
  ok(readCamp().active === true, 'a fresh campaign is active');

  const hide = await setCampaignInternal({ id: CAMP, internal: true, actor: 'owner' });
  ok(hide.ok && hide.campaign.internal === true, 'setCampaignInternal(true) returns ok + internal=true');
  ok(readCamp().internal === true, 'plans reader now surfaces internal=true');
  ok(manEntry().active === true, 'the manifest round-trip preserved the sibling active flag');
  ok(readCamp().active === true, 'the campaign stays active/schedulable while internal');

  const show = await setCampaignInternal({ id: CAMP, internal: false, actor: 'owner' });
  ok(show.ok && readCamp().internal === false, 'setCampaignInternal(false) clears the flag');

  const bad = await setCampaignInternal({ id: CAMP, internal: 'yes', actor: 'owner' });
  ok(!bad.ok && bad.code === 'invalid_input', 'a non-boolean internal is rejected (invalid_input)');

  const missing = await setCampaignInternal({ id: 'nope', internal: true, actor: 'owner' });
  ok(!missing.ok && missing.code === 'unknown_campaign', 'an unknown campaign is rejected');

  console.log(`[campaign-internal] OK - internal flag round-trips and never touches active (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
