// radar-replay.test.mjs - the replay eval (ops/radar-replay.mjs, Radar 2.0 step 2, spec 53).
//
// Proofs:
//   (a) the fixture is well formed: 60-120 labelled items, both labels present, every item names a
//       client and a search the fixture carries, no private client name, no em dash in the labels;
//   (b) the scorer: with a STUBBED judge (no network, no spawn) precision and recall come out of
//       the engine rule exactly: only keep + seeker + replyable + a real intent counts as surfaced,
//       a kept vendor or a kept non-replyable seeker does not;
//   (c) the replay never leaks the label into the judge prompt.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Private client names as sha256 hashes, the same list and matcher test/supply-chain.test.mjs
// uses: this file ships in the public repo, so a guard that spelled the name out would be the leak.
const PRIVATE_NAME_HASHES = [
  { len: 8, sha256: '6d5f5d25ce12a4105a3d5de560a9506144ce0406247cfa4052db4c545630500d' },
];
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const isPrivate = (token) => {
  const t = token.toLowerCase();
  return PRIVATE_NAME_HASHES.some((h) => t.length >= h.len && sha(t.slice(0, h.len)) === h.sha256);
};
const namesPrivate = (text) => text.split(/[^A-Za-z0-9]+/)
  .flatMap((w) => w.split(/(?<=[a-z0-9])(?=[A-Z])/))
  .some(isPrivate);

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

process.env.PENDPOST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-replay-'));
process.env.PENDPOST_MODE = 'mock';

try {
  const dir = new URL('./fixtures/radar-replay/', import.meta.url);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  ok(files.length >= 1, `a replay fixture exists (${files.join(', ')})`);
  const raw = fs.readFileSync(new URL(files[0], dir), 'utf8');
  const fx = JSON.parse(raw);
  const items = fx.items || [];
  ok(items.length >= 60 && items.length <= 120, `60-120 labelled items (${items.length})`);
  ok(items.some((i) => i.label === 'good') && items.some((i) => i.label === 'bad') && items.every((i) => i.label === 'good' || i.label === 'bad'), 'every item is labelled good or bad, and both occur');
  ok(items.every((i) => fx.clients[i.client] && (fx.clients[i.client].queries || []).some((q) => q.id === i.queryId)), 'every item names a client and a search the fixture carries');
  ok(new Set(items.map((i) => i.id)).size === items.length, 'item ids are unique');
  ok(!namesPrivate(raw), 'no private client name in the fixture');
  ok(items.every((i) => typeof i.why === 'string' && i.why && !i.why.includes(String.fromCharCode(0x2014))), 'every label carries a reason, without em dashes');

  // The public mirror ships no ops/ (ops/publish-oss.mjs DENY), so there only the fixture
  // proofs above run; the scorer proofs need the private eval script.
  if (!fs.existsSync(new URL('../ops/radar-replay.mjs', import.meta.url))) {
    console.log('  skip - ops/radar-replay.mjs is not in this checkout (the public repo ships no ops/)');
  } else {
    const { replay, summarize } = await import('../ops/radar-replay.mjs');
    // A stub judge: reads the candidate lines and answers by a marker in the text.
    const prompts = [];
    const stub = async ({ prompt }) => {
      prompts.push(prompt);
      const lines = prompt.split('\n').filter((l) => l.startsWith('{"id":"c')).map((l) => JSON.parse(l));
      const verdicts = lines.map((c) => {
        if (/ASK/.test(c.text)) return { id: c.id, keep: true, score: 80, intent: 'ask_reco', authorRole: 'seeker', replyable: true, timing: 'fresh', reason: 'asks' };
        if (/SELLER/.test(c.text)) return { id: c.id, keep: true, score: 50, intent: 'none', authorRole: 'vendor', replyable: true, timing: 'fresh', reason: 'sells' };
        if (/LAUNCH/.test(c.text)) return { id: c.id, keep: true, score: 70, intent: 'ask_reco', authorRole: 'seeker', replyable: false, timing: 'fresh', reason: 'under a launch' };
        return { id: c.id, keep: false, score: 5, intent: 'none', authorRole: 'peer', replyable: false, timing: 'fresh', reason: 'no', reasonCode: 'off-topic' };
      });
      return { ok: true, stdout: JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify({ verdicts }), total_cost_usd: 0.001 }) };
    };
    const mini = {
      clients: { a: { brand: { facts: 'A scheduler.' }, queries: [{ id: 'q', label: 'seekers', brief: 'people asking' }] } },
      items: [
        { id: 'i1', client: 'a', queryId: 'q', source: 'reddit', externalId: '1', url: 'https://x/1', author: 'u1', ts: '2026-01-01T00:00:00Z', text: 'ASK which tool', label: 'good', why: 'asks' },
        { id: 'i2', client: 'a', queryId: 'q', source: 'reddit', externalId: '2', url: 'https://x/2', author: 'u2', ts: null, text: 'ASK for a tool, second one', label: 'bad', why: 'secret-reason-fp' },
        { id: 'i3', client: 'a', queryId: 'q', source: 'reddit', externalId: '3', url: 'https://x/3', author: 'u3', ts: null, text: 'SELLER pitch', label: 'bad', why: 'vendor' },
        { id: 'i4', client: 'a', queryId: 'q', source: 'reddit', externalId: '4', url: 'https://x/4', author: 'u4', ts: null, text: 'LAUNCH comment', label: 'good', why: 'test fn' },
        { id: 'i5', client: 'a', queryId: 'q', source: 'reddit', externalId: '5', url: 'https://x/5', author: 'u5', ts: null, text: 'birds', label: 'bad', why: 'off-topic' },
      ],
    };
    const out = await replay(mini, { provider: 'claude-code', run: stub, now: Date.parse('2026-10-29T12:00:00Z') });
    const s = out.summary.overall;
    ok(s.items === 5 && s.judged === 5 && s.surfaced === 2 && s.truePositives === 1, `surfaced = keep + seeker + replyable + intent (${JSON.stringify(s)})`);
    ok(s.precision === 50 && s.recall === 50, `precision 50%, recall 50% (${s.precision}/${s.recall})`);
    ok(!out.results.find((r) => r.id === 'i3').surfaced, 'a kept vendor is not surfaced');
    ok(!out.results.find((r) => r.id === 'i4').surfaced, 'a kept seeker in a non-replyable place is not surfaced');
    ok(prompts.length === 1 && !/secret-reason-fp|test fn|"label"|"why"/.test(prompts[0]), 'the label and its reason never reach the judge prompt');
    ok(/"age":"6h"/.test(prompts[0]), 'a dated item is replayed as found 6 hours ago');
    ok(summarize([]).overall.precision === null, 'nothing surfaced reads as n/a, not 0% or 100%');
  }
} catch (err) {
  failures += 1;
  console.error(`  FAIL - threw: ${err && err.stack}`);
}
console.log(`\n${pass} passed, ${failures} failed`);
if (failures) { console.error(`[radar-replay] FAIL - ${failures} assertion(s) failed`); process.exit(1); }
