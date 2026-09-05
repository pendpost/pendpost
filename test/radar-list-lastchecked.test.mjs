#!/usr/bin/env node
// test/radar-list-lastchecked.test.mjs - the ADDITIVE lastCheckedTs join (S1 glyph state 3).
//
// The follow-up check's "we looked, nothing new" outcome lives in the engine-owned
// radarFollowup.lastCheckedTs stamp on the reply post (and, for hand-posted copy drafts,
// on the copyPosted ledger marker). The feed's follow-up glyph must be able to say
// "Zuletzt geprüft {time}" - so listRadar's S3(b) join carries the stamp to the client:
//   - a POSTED reply's signal -> replied.lastCheckedTs (null when never checked)
//   - a copy-posted marker's signal -> copyPosted.lastCheckedTs (null when never checked)
// Purely additive: every existing replied/copyPosted field is untouched.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-list-lastchecked-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

try {
  const { getConfig, setConfig } = await import('../lib/config.mjs');
  const { createCampaign, listRadar, radarIngest, markCopyPosted } = await import('../lib/writes.mjs');
  const { loadState, saveState } = await import('../lib/state.mjs');

  setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { radar: { enabled: true, queries: [{ id: 'q1', label: 'q', keywords: ['schedule'] }] } } } });
  await createCampaign({ id: 'c1', displayName: 'C', timezone: 'UTC', actor: 'owner' });

  const CHECKED_AT = '2026-08-17T09:30:00.000Z';

  // Three cached signals: one with a CHECKED posted reply, one with a NEVER-checked
  // posted reply, one answered via the copy path (ledger marker).
  await radarIngest({
    queryId: 'q1',
    signals: [
      { source: 'reddit', ts: new Date().toISOString(), externalId: 'r1', url: 'https://reddit.com/r/x/1', author: 'a1', text: 'any scheduler?' },
      { source: 'mastodon', ts: new Date().toISOString(), externalId: 'm1', url: 'https://mastodon.example/@a2/2', author: 'a2', text: 'buffer alternative?' },
      { source: 'x', ts: new Date().toISOString(), externalId: 'tw1', url: 'https://x.com/a3/status/3', author: 'a3', text: 'tools for this?' },
    ],
    actor: 'agent:claude',
  });
  await markCopyPosted({ source: 'x', externalId: 'tw1', postedUrl: 'https://x.com/us/status/9', actor: 'owner' });

  // The reply posts + the engine-owned radarFollowup stamp, written the way the daemon
  // owns them (the STAMPING itself is pinned in radar-followup-report/engine-owned tests;
  // this test pins the JOIN).
  const planPath = path.join(WS, 'data', 'plans', 'c1', 'post-plan.json');
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  plan.posts = [
    {
      id: 'rr1', type: 'text', platforms: ['reddit'], caption: 'our reply',
      status: 'posted', postedAt: '2026-08-16T10:00:00.000Z', publishedVia: 'manual',
      externalUrl: 'https://reddit.com/r/x/1/our-reply',
      radarReplyTo: { url: 'https://reddit.com/r/x/1', source: 'reddit', externalId: 'r1' },
      radarFollowup: { lastCheckedTs: CHECKED_AT },
    },
    {
      id: 'rm1', type: 'text', platforms: ['mastodon'], caption: 'our other reply',
      status: 'posted', postedAt: '2026-08-16T11:00:00.000Z', publishedVia: 'manual',
      externalUrl: 'https://mastodon.example/@us/9',
      radarReplyTo: { url: 'https://mastodon.example/@a2/2', source: 'mastodon', externalId: 'm1' },
    },
  ];
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));

  // The copy marker's sweep stamp (same engine-owned shape on the ledger entry).
  {
    const st = loadState();
    const entry = (st.radar.copyPosted || []).find((e) => e.source === 'x' && e.externalId === 'tw1');
    assert.ok(entry, 'seeded copy marker exists');
    entry.radarFollowup = { lastCheckedTs: CHECKED_AT };
    saveState();
  }

  const { items } = await listRadar({});
  const bySig = (src, ext) => items.find((s) => s.source === src && s.externalId === ext);

  const checked = bySig('reddit', 'r1');
  ok(checked && checked.replied && checked.replied.lastCheckedTs === CHECKED_AT,
    'a posted reply with a radarFollowup stamp joins replied.lastCheckedTs (the glyph can say "Zuletzt geprüft")');
  ok(checked.replied.url === 'https://reddit.com/r/x/1/our-reply' && checked.replied.via === 'external' && checked.replied.postId === 'rr1',
    'the existing replied contract {url, via, postId} is untouched - the field is additive');

  const unchecked = bySig('mastodon', 'm1');
  ok(unchecked && unchecked.replied && unchecked.replied.lastCheckedTs === null,
    'a posted reply never checked joins lastCheckedTs:null - the glyph keeps its idle tooltip, no fabricated clock');

  const copy = bySig('x', 'tw1');
  ok(copy && copy.copyPosted && copy.copyPosted.lastCheckedTs === CHECKED_AT,
    'a copy-posted marker with a sweep stamp joins copyPosted.lastCheckedTs identically');
  ok(copy.copyPosted.postedUrl === 'https://x.com/us/status/9',
    'the existing copyPosted contract {postedUrl, at} is untouched');

  console.log(`\nradar-list-lastchecked: ${pass} checks passed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
