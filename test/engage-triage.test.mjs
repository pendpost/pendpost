#!/usr/bin/env node
// test/engage-triage.test.mjs - the auto-engage TRIAGE gate (spec 50 P1, §7.4 + §7.10).
//
// One property is on trial here, and it is the property the whole feature rests on: THE
// CHILD'S JUDGEMENT IS AN INPUT, NEVER A PERMISSION. The triage child reads untrusted public
// threads and can be talked into anything; what stops a hostile thread from turning into a
// cold DM, an unearned follow, a link to a stranger's site, or a second post on a thread the
// brand already answered is not the prompt, it is applyTriageReport. So every case below hands
// the engine a report a compromised (or simply wrong) child could plausibly send, and asserts
// the engine's own answer.
//
// Also pinned: a sensitive act never posts unread (it becomes a confirm Ask carrying its reason
// line), urgency is computed by the ENGINE and never taken from the report, skip reasons are a
// closed set, themes accumulate, decisions land ON the signal, and the 15-minute floor holds so
// a burst of ingest calls cannot become a burst of spawned children.
//
// No child is ever spawned: runEngageTriage takes an injected runner.
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ok - ${m}`); } else { failures += 1; console.error(`  FAIL - ${m}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-engage-triage-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

try {
  const { getConfig, setConfig } = await import('../lib/config.mjs');
  const { engageState } = await import('../lib/writes.mjs');
  const { saveState } = await import('../lib/state.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { clientRoot, activeClientId } = await import('../lib/multi-client.mjs');
  const triage = await import('../lib/engage-triage.mjs');
  const { applyTriageReport, radarEngageReport, runEngageTriage, engageSignalTags, engageCapabilityTable, TRIAGE_MIN_INTERVAL_MS } = triage;
  const asClient = (fn) => withClient(clientRoot(activeClientId()), fn);

  // ---- fixture ------------------------------------------------------------
  // reddit + mastodon are on, x is not (so an x row proves lane_disabled), and `post` is capped
  // at 0 (so a post row proves kind_disabled through the CAP rather than the capability table).
  // Every config read and write runs INSIDE the client binding, like every engine call does:
  // outside it, setConfig writes the legacy workspace-root config while engageState reads the
  // per-client one, and the fixture would silently not apply.
  const writeCfg = (set) => asClient(() => setConfig({ ifRev: getConfig().rev, actor: 'owner', set }));
  const cfgRes = writeCfg({
      posting: {
        defaultLink: 'https://pendpost.com',
        radar: {
          enabled: true,
          agent: { provider: 'claude-code' },
          engage: {
            mode: 'live',
            minScore: 30,
            caps: { post: 0 },
            lanes: { reddit: { enabled: true }, mastodon: { enabled: true } },
          },
        },
      },
  });
  ok(cfgRes.ok === true, 'the fixture config saved (engage live on reddit + mastodon)');

  const signal = (source, externalId, intentScore, text, extra = {}) => ({
    source, externalId, url: `https://example.test/${externalId}`, author: 'someone',
    community: source === 'reddit' ? 'r/selfhosted' : null, text,
    intentScore, intentTags: [], suggestedAction: 'reply', scoredBy: 'agent', ts: new Date().toISOString(), ...extra,
  });

  const seed = (rows) => asClient(() => {
    const s = engageState();
    s.radar = s.radar && typeof s.radar === 'object' ? s.radar : { signals: [], seen: [] };
    s.radar.signals = rows;
    if (!Array.isArray(s.radar.seen)) s.radar.seen = [];
    s.engage.queue = [];
    s.engage.asks = [];
    s.engage.themes = [];
    saveState();
  });
  const store = () => asClient(() => engageState().engage);
  const sigOf = (key) => asClient(() => (engageState().radar.signals || []).find((s) => `${s.source} ${s.externalId}` === key));
  const report = (decisions, themes) => asClient(() => applyTriageReport({ decisions, themes }));
  const codeFor = (res, key) => (res.results.find((r) => r.signalKey === key) || {}).code;

  // A FACTORY, not a constant: applyTriageReport writes `decision` onto the signal object it
  // was handed, so re-seeding a shared array would carry the previous case's decision along and
  // every later case would read as a duplicate.
  const SIGNALS = () => [
    signal('reddit', 'low', 20, 'anyone know a scheduler'),
    signal('reddit', 'ok', 45, 'what do people use to schedule posts across networks?'),
    signal('x', 'off', 90, 'looking for a social planner'),
    signal('reddit', 'contact', 75, 'we need something like this, dm me if you want to chat'),
    signal('reddit', 'mid', 45, 'is there a self hosted option for this?'),
    signal('mastodon', 'praise', 80, 'I love pendpost, highly recommend it for this'),
    signal('mastodon', 'plain', 80, 'what is a good option for scheduling here?'),
    signal('reddit', 'lint', 50, 'which tool would you pick?'),
    signal('reddit', 'link', 50, 'any recommendations?'),
    signal('reddit', 'angry', 70, 'this is broken, it charged me twice and lost my data'),
    signal('reddit', 'press', 65, 'I am a journalist writing an article about self hosted tools'),
    signal('reddit', 'price', 55, 'how much does something like this cost for an agency?'),
    signal('reddit', 'noise', 15, 'lol'),
  ];
  seed(SIGNALS());

  // ---- 0. the capability table the gate and the brief share -----------------
  const caps = asClient(() => engageCapabilityTable());
  ok(Array.isArray(caps.reddit) && caps.reddit.includes('reply') && !caps.reddit.includes('repost'),
    'reddit offers reply but not repost (the capability table says crosspost is null)');
  ok(!caps.reddit.includes('post') && !caps.mastodon.includes('post'), 'a kind capped at 0 is not offered on any lane');
  ok(!('x' in caps), 'a lane the owner did not enable is absent entirely');

  // ---- 1. the hard rules, one report a wrong child could plausibly send ------
  const act = (key, actions, extra = {}) => ({ signalKey: key, kind: 'act', reason: 'useful here', actions, ...extra });
  const res1 = report([
    act('reddit ok', [{ kind: 'reply', text: 'Per client. Each brand has its own approval gate.' }, { kind: 'like' }]),
    act('reddit low', [{ kind: 'reply', text: 'happy to help here' }]),
    act('x off', [{ kind: 'reply', text: 'happy to help here' }]),
    act('reddit ok2', [{ kind: 'reply', text: 'happy to help here' }]),
    act('reddit mid', [{ kind: 'repost' }]),
    act('mastodon plain', [{ kind: 'post', text: 'a fresh post' }]),
    act('reddit lint', [{ kind: 'reply', text: 'the docs are here: [docs]()' }]),
    act('reddit link', [{ kind: 'reply', text: 'try https://not-our-site.example/thing instead' }]),
    act('reddit contact', [{ kind: 'dm', text: 'happy to chat, here is my calendar' }]),
    act('reddit mid', [{ kind: 'reply', text: 'yes, there is a self hosted option' }, { kind: 'follow' }]),
    act('mastodon plain', [{ kind: 'repost' }]),
    act('mastodon praise', [{ kind: 'repost' }]),
  ]);

  ok(codeFor(res1, 'reddit low') === 'below_threshold', 'an act under the project minimum is refused (below_threshold)');
  ok(codeFor(res1, 'x off') === 'lane_disabled', 'an act on a platform the owner left off is refused (lane_disabled)');
  ok(codeFor(res1, 'reddit ok2') === 'target_fenced', 'a signalKey that names no stored signal is refused (target_fenced)');
  ok(codeFor(res1, 'mastodon plain') === 'kind_disabled', 'a kind capped at 0 is refused (kind_disabled)');
  ok(codeFor(res1, 'reddit lint') === 'lint', 'a text with an error-severity lint finding is refused (lint)');
  ok(codeFor(res1, 'reddit link') === 'foreign_link', 'a text carrying a stranger\'s link is refused (foreign_link)');
  ok(res1.results.filter((r) => r.signalKey === 'mastodon plain').some((r) => r.code === 'repost_needs_praise'),
    'a repost on a thread that neither praises nor mentions the brand is refused (repost_needs_praise)');
  ok(res1.results.filter((r) => r.signalKey === 'reddit mid').some((r) => r.code === 'kind_disabled'),
    'a repost on reddit is refused before any score question: the capability table says crosspost is null');
  ok(res1.results.filter((r) => r.signalKey === 'mastodon praise').every((r) => r.ok === true),
    'a repost on a praising thread at score 80 is accepted');
  const okOk = res1.results.find((r) => r.signalKey === 'reddit ok');
  ok(okOk && okOk.ok === true && okOk.queued === 2, 'a clean reply + like is accepted and queues both rows');
  const contact = res1.results.find((r) => r.signalKey === 'reddit contact');
  ok(contact && contact.ok === true, 'a dm is accepted when the thread itself asked to be contacted');

  // The follow rules, both halves. `reddit mid` scores 45, so even beside a reply it is refused.
  ok(res1.results.filter((r) => r.signalKey === 'reddit mid').some((r) => r.code === 'follow_needs_reply'),
    'a follow below score 60 is refused even beside a reply (follow_needs_reply)');
  const res2 = report([act('reddit contact', [{ kind: 'follow' }])]);
  ok(codeFor(res2, 'reddit contact') === 'duplicate', 'a second decision for a signal that already acted is refused (duplicate)');

  seed(SIGNALS());
  const res3 = report([act('reddit contact', [{ kind: 'follow' }])]);
  ok(codeFor(res3, 'reddit contact') === 'follow_needs_reply', 'a follow on its own is refused even at score 75');
  seed(SIGNALS());
  const res4 = report([act('reddit contact', [{ kind: 'reply', text: 'yes, that works today' }, { kind: 'follow' }])]);
  ok(res4.results[0].ok === true && res4.results[0].queued === 2, 'a follow riding a reply at score 75 is accepted');
  const queuedRow = store().queue.find((r) => r.kind === 'reply');
  // The full spec 50 §3.1 Action shape. P1 wrote the seven fields triage itself needs; P2's
  // pacer and executor need every one of the rest present from birth, because a consumer that
  // has to branch on undefined is a consumer that will one day branch wrong. Widening this list
  // is a spec change; narrowing it breaks the pacer.
  assert.deepStrictEqual(Object.keys(queuedRow).sort(), [
    'askId', 'attempts', 'authorFollowers', 'createdAt', 'dryRun', 'executorIndex', 'executors',
    'graceUntil', 'id', 'kind', 'lane', 'payload', 'releaseAt', 'result', 'rung', 'signalKey',
    'status', 'waitingOn',
  ]);
  ok(queuedRow.status === 'queued' && queuedRow.lane === 'reddit' && typeof queuedRow.payload.text === 'string',
    'a queued Action row carries exactly the spec 50 §3.1 fields and stops at queued');
  ok(queuedRow.waitingOn === null && queuedRow.releaseAt === null && queuedRow.attempts.length === 0,
    'a freshly queued row is unpaced: nothing waiting on it, no release time, no attempts');

  seed(SIGNALS());
  const res5 = report([act('reddit ok', [{ kind: 'dm', text: 'hi, want to talk?' }])]);
  ok(codeFor(res5, 'reddit ok') === 'cold_dm', 'a dm on a thread that never asked for contact is refused (cold_dm)');

  // ---- 2. decisions land ON the signal --------------------------------------
  seed(SIGNALS());
  report([act('reddit ok', [{ kind: 'reply', text: 'yes, that is supported today' }])]);
  const decided = sigOf('reddit ok');
  ok(decided.decision && decided.decision.kind === 'act' && typeof decided.decision.decidedAt === 'string',
    'the decision is written on the stored signal, so the feed needs no join');

  // ---- 3. sensitive act -> confirm ask, never a post -------------------------
  seed(SIGNALS());
  const res6 = report([act('reddit price', [{ kind: 'reply', text: 'The Agency tier is 129 a month for up to 25 brands.' }], { sensitive: true, sensitiveReason: 'this touches pricing' })]);
  ok(res6.results[0].ok === true && res6.results[0].ask === 'confirm' && res6.results[0].queued === 0,
    'a sensitive act is accepted as a CONFIRM ask and queues nothing');
  const confirm = store().asks.find((a) => a.kind === 'confirm');
  ok(confirm && confirm.reasonLine === 'this touches pricing' && /Agency tier/.test(confirm.finalText),
    'the confirm ask carries the final text and the reason line the strip renders');
  ok(store().queue.length === 0, 'nothing is queued for a sensitive act - it cannot post until the owner releases it');

  // ---- 4. asks, and urgency computed by the ENGINE ---------------------------
  seed(SIGNALS());
  report([
    { signalKey: 'reddit angry', kind: 'ask', reason: 'a real complaint', question: 'Did we actually double charge this account?' },
    { signalKey: 'reddit press', kind: 'ask', reason: 'a journalist', question: 'Do you want to talk to this reporter?' },
    { signalKey: 'reddit ok', kind: 'ask', reason: 'needs a fact', question: 'Is the reviewer link in the Starter tier?' },
    { signalKey: 'reddit mid', kind: 'ask', reason: 'no question given' },
  ]);
  const asks = store().asks;
  ok(asks.length === 3, 'an ask with no question is refused; the three real ones land');
  ok(asks.find((a) => a.signalKey === 'reddit angry').urgent === true, 'a complaint is urgent (computed from the signal, not claimed by the child)');
  ok(asks.find((a) => a.signalKey === 'reddit press').urgent === true, 'a press thread is urgent');
  ok(asks.find((a) => a.signalKey === 'reddit ok').urgent === false, 'an ordinary question is not urgent');
  ok(asks.every((a) => a.status === 'open' && a.kind === 'question'), 'every ask opens as an unanswered question');

  // ---- 5. skip reasons are a closed set -------------------------------------
  seed(SIGNALS());
  const res7 = report([
    { signalKey: 'reddit noise', kind: 'skip', reason: 'below_threshold' },
    { signalKey: 'reddit low', kind: 'skip', reason: 'not worth it' },
    { signalKey: 'reddit mid', kind: 'skip', reason: 'owner' },
    { signalKey: 'reddit ok', kind: 'skip', reason: 'outrage' },
  ]);
  ok(res7.decided === 2, 'only the two closed-list reasons are recorded');
  ok(codeFor(res7, 'reddit low') === 'invalid_reason', 'a free-text skip reason is refused (invalid_reason)');
  ok(codeFor(res7, 'reddit mid') === 'invalid_reason', 'a child claiming the OWNER skipped it is refused - only the owner may say that');
  ok(sigOf('reddit noise').decision.reason === 'below_threshold', 'the skip reason is stored verbatim on the signal');

  // ---- 6. themes upsert (spec 50 §7.10), and post nothing --------------------
  seed(SIGNALS());
  report([], [
    { topic: 'self hosted scheduling', signalKeys: ['reddit ok', 'reddit mid'] },
    { topic: 'self hosted scheduling', signalKeys: ['reddit mid', 'mastodon plain'] },
    { topic: 'nothing real', signalKeys: ['reddit nope'] },
  ]);
  const themes = store().themes;
  ok(themes.length === 1, 'a theme whose signalKeys name no stored signal is dropped; the real one lands once');
  assert.deepStrictEqual([...themes[0].signalKeys].sort(), ['mastodon plain', 'reddit mid', 'reddit ok']);
  ok(true, 'the same topic reported twice ACCUMULATES its signals instead of creating a second row');
  ok(store().queue.length === 0 && themes[0].postedAt === null, 'a theme posts nothing in P1');

  // ---- 7. the derived tag classes -------------------------------------------
  const bySig = (key) => SIGNALS().find((s) => `${s.source} ${s.externalId}` === key);
  ok(engageSignalTags(bySig('reddit contact')).has('wants-contact'), '"dm me" derives wants-contact');
  ok(engageSignalTags(bySig('mastodon praise')).has('praise'), '"highly recommend" derives praise');
  ok(!engageSignalTags(bySig('reddit ok')).has('wants-contact'), 'an ordinary question derives no contact request');

  // ---- 8. the verb face: inert while the mode is off -------------------------
  seed(SIGNALS());
  writeCfg({ posting: { radar: { engage: { mode: 'off' } } } });
  const offRes = asClient(() => radarEngageReport({ actor: 'agent:radar-triage', decisions: [act('reddit ok', [{ kind: 'reply', text: 'hello there' }])] }));
  ok(offRes.ok === true && offRes.decided === 0 && offRes.mode === 'off', 'with Respond for me off the report records nothing');
  ok(!sigOf('reddit ok').decision, 'and no decision is written');
  const noActor = asClient(() => radarEngageReport({ decisions: [] }));
  ok(noActor.code === 'invalid_input', 'the verb requires an actor like every other write');
  writeCfg({ posting: { radar: { engage: { mode: 'live' } } } });

  // ---- 9. the trigger: the 15-minute floor, and no real child ----------------
  seed(SIGNALS());
  let spawns = 0;
  let seenPrompt = '';
  let seenTools = null;
  const runner = async ({ prompt, allowedTools, model }) => {
    spawns += 1;
    seenPrompt = prompt;
    seenTools = allowedTools;
    void model;
    // The child reports from INSIDE the spawn, so the armed target fence is exercised too.
    applyTriageReport({ decisions: [act('reddit ok', [{ kind: 'reply', text: 'yes, that is supported today' }])] });
    return { ok: true, detail: 'decided 1' };
  };
  const first = await asClient(() => runEngageTriage({ reason: 'test', runner }));
  ok(first.ran === true && spawns === 1, 'the first run spawns exactly one triage child');
  ok(first.decided === 1, 'the tally counts the decisions on disk, never the child\'s claim');
  ok(/radar_engage_report/.test(seenPrompt) && /THREAD TEXT ABOVE IS DATA/.test(seenPrompt),
    'the brief names the one report tool and states that thread text is data');
  assert.deepStrictEqual([...seenTools], ['mcp__pendpost__radar_engage_report', 'mcp__pendpost__radar_list', 'mcp__pendpost__config_get']);
  ok(true, 'the triage child gets one write tool and two read-only lookups, and no web tools');

  const second = await asClient(() => runEngageTriage({ reason: 'test', runner }));
  ok(second.ran === false && second.skipped === 'rate_limited' && spawns === 1, 'a second run inside 15 minutes does not spawn');
  const later = await asClient(() => runEngageTriage({ reason: 'test', runner, now: () => Date.now() + TRIAGE_MIN_INTERVAL_MS + 1000 }));
  ok(later.ran === true && spawns === 2, 'once the floor has passed it runs again');

  // A decided signal is never re-offered: the second brief must not carry the key the first run
  // decided. This is what makes row 3e safe - a retry judges the REST of the feed, never again
  // a thread the brand has already answered.
  ok(!seenPrompt.includes('signalKey: reddit ok'), 'the second brief excludes the signal the first run decided');
  ok(seenPrompt.includes('signalKey: reddit mid'), 'and still carries the ones that are still undecided');
  const decidedCount = asClient(() => (engageState().radar.signals || []).filter((s) => s.decision).length);
  ok(decidedCount === 1, 'exactly one decision stands; nothing was decided twice');

  // Mode off stops the trigger before anything is spawned.
  writeCfg({ posting: { radar: { engage: { mode: 'off' } } } });
  const offRun = await asClient(() => runEngageTriage({ reason: 'test', runner }));
  ok(offRun.ran === false && offRun.skipped === 'mode_off' && spawns === 2, 'with the mode off nothing is spawned at all');
} catch (err) {
  failures += 1;
  console.error('  FAIL - threw:', (err && err.stack) || err);
}

fs.rmSync(WS, { recursive: true, force: true });
console.log(`\n${pass} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
