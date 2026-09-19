#!/usr/bin/env node
// test/engage-asks.test.mjs - the auto-engage ASK lifecycle (spec 50 P5a, §7.7 + §4 S3/S4).
//
// An Ask is the ONE interruption "Respond for me" is allowed, so what is on trial here is
// mostly the ways it can go wrong for the owner:
//   - a sweep that runs every 60 seconds forever must never file the same ask twice;
//   - the owner answering an ask must NOT be a hole in the §7.4 hard rules - the reply they
//     triggered goes through the same gate a child's own act does, including the sensitivity
//     conversion that stops a pricing answer from posting unread;
//   - a confirm the owner just read must not then sit fifteen more minutes in grace;
//   - a skip must be attributed to the HUMAN who made it ("skipped by you"), never to a
//     machine reason the owner never chose;
//   - an ask must die when the world makes it moot: the copy-draft was posted by hand, the
//     platform came back, autonomy was revoked.
//
// No child is ever spawned: answerAsk takes an injected runner.
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ok - ${m}`); } else { failures += 1; console.error(`  FAIL - ${m}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-engage-asks-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

try {
  const { getConfig, setConfig } = await import('../lib/config.mjs');
  const { engageState, markCopyPosted } = await import('../lib/writes.mjs');
  const { saveState } = await import('../lib/state.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { clientRoot, activeClientId } = await import('../lib/multi-client.mjs');
  const { planReleases } = await import('../lib/engage-pacer.mjs');
  const { setLaneRuntime, enginePolicy } = await import('../lib/engage.mjs');
  const asks = await import('../lib/engage-asks.mjs');
  const {
    createAsk, listAsks, answerAsk, confirmAsk, dismissAsk,
    resolveLaneAsks, holdForRevoke, askSweep, ASK_KINDS,
  } = asks;
  const verbs = await import('../lib/engage-verbs.mjs');

  const asClient = (fn) => withClient(clientRoot(activeClientId()), fn);
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
          lanes: { reddit: { enabled: true }, linkedin: { enabled: true } },
        },
      },
    },
  });
  ok(cfgRes.ok === true, 'the fixture config saved (engage live on reddit + linkedin)');

  const signal = (source, externalId, intentScore, text, extra = {}) => ({
    source, externalId, url: `https://example.test/${externalId}`, author: 'someone',
    community: source === 'reddit' ? 'r/selfhosted' : null, text,
    intentScore, intentTags: [], suggestedAction: 'reply', scoredBy: 'agent',
    ts: new Date().toISOString(), ...extra,
  });

  const seed = (rows, queue = []) => asClient(() => {
    const s = engageState();
    s.radar = s.radar && typeof s.radar === 'object' ? s.radar : { signals: [], seen: [], copyPosted: [] };
    s.radar.signals = rows;
    if (!Array.isArray(s.radar.seen)) s.radar.seen = [];
    if (!Array.isArray(s.radar.copyPosted)) s.radar.copyPosted = [];
    s.engage.queue = queue;
    s.engage.asks = [];
    s.engage.lanes = {};
    saveState();
  });
  const store = () => asClient(() => engageState().engage);
  const sigOf = (key) => asClient(() => (engageState().radar.signals || []).find((s) => `${s.source} ${s.externalId}` === key));

  // =========================================================================
  console.log('\n[1] createAsk is idempotent while an ask of the same shape is open');
  // =========================================================================
  seed([signal('reddit', 'a1', 70, 'does it do approval per client?')]);
  const first = asClient(() => createAsk({ kind: 'question', signalKey: 'reddit a1', question: 'is the reviewer link in Starter?' }));
  const second = asClient(() => createAsk({ kind: 'question', signalKey: 'reddit a1', question: 'asked again by a second tick' }));
  ok(first.ok === true && first.created === true, 'the first ask is created');
  ok(second.ok === true && second.created === false && second.ask.id === first.ask.id, 'the second call returns the SAME ask instead of filing a duplicate');
  ok(store().asks.length === 1, 'exactly one ask stands for that signal + kind');
  // A DIFFERENT kind on the same signal is a different question, so it is allowed.
  const other = asClient(() => createAsk({ kind: 'confirm', signalKey: 'reddit a1', finalText: 'held text' }));
  ok(other.created === true && store().asks.length === 2, 'a different kind on the same signal is its own ask');
  ok(asClient(() => createAsk({ kind: 'nonsense' })).code === 'invalid_input', 'an unknown kind is refused (the vocabulary is closed)');
  ok(ASK_KINDS.length === 5, 'five ask kinds, exactly as §3.1 lists them');

  // Dismissing the duplicate-guard's ask frees the shape again: the guard is about OPEN asks,
  // not about ever asking twice - a thread the owner skipped can legitimately come back.
  asClient(() => dismissAsk(other.ask.id));
  const third = asClient(() => createAsk({ kind: 'confirm', signalKey: 'reddit a1', finalText: 'held text' }));
  ok(third.created === true, 'once the first is resolved, the same shape can be asked again');

  // =========================================================================
  console.log('\n[2] listAsks sorts the way the strip renders: urgent first, then by score');
  // =========================================================================
  seed([
    signal('reddit', 'lo', 40, 'a quiet question'),
    signal('reddit', 'hi', 90, 'a loud question'),
    signal('reddit', 'urg', 35, 'my lawyer will be in touch about this'),
  ]);
  asClient(() => createAsk({ kind: 'question', signalKey: 'reddit lo', question: 'q' }));
  asClient(() => createAsk({ kind: 'question', signalKey: 'reddit hi', question: 'q' }));
  asClient(() => createAsk({ kind: 'question', signalKey: 'reddit urg', question: 'q' }));
  const listed = asClient(() => listAsks({ status: 'open' }));
  ok(listed.length === 3, 'three open asks');
  ok(listed[0].signalKey === 'reddit urg' && listed[0].urgent === true, 'the legal thread leads: urgency is DERIVED by the engine from the words, never claimed');
  ok(listed[1].signalKey === 'reddit hi' && listed[2].signalKey === 'reddit lo', 'the rest sort by the signal score');
  ok(listed[1].signal && listed[1].signal.author === 'someone' && listed[1].signal.url, 'each ask carries the thread it is about (S4 renders author + excerpt + link)');

  // =========================================================================
  console.log('\n[3] answerAsk: the owner types one line, the engine posts the reply');
  // =========================================================================
  seed([signal('reddit', 'q1', 70, 'does pendpost approve per client or globally?')]);
  const ask1 = asClient(() => createAsk({ kind: 'question', signalKey: 'reddit q1', draft: 'Per client.', question: 'is the reviewer link in Starter?' }));
  let sawPrompt = null;
  const plainRunner = async ({ ask, signal: sig }) => {
    sawPrompt = { answer: ask.answer, source: sig.source };
    return { ok: true, text: 'Per client. Every brand has its own approval gate, and the reviewer link is in Starter too.', sensitive: false };
  };
  const answered = await asClient(() => answerAsk(ask1.ask.id, 'yes, the reviewer link is in every tier including Starter', { runner: plainRunner }));
  ok(answered.ok === true && answered.status === 'answered', 'the ask is answered');
  ok(sawPrompt && sawPrompt.answer.startsWith('yes, the reviewer link'), "the owner's answer reaches the child as the authoritative fact");
  ok(answered.queued === 1, 'one reply row was queued through the normal pacer');
  ok(answered.confirm === false, 'a plain answer does not need a second look');
  ok(sigOf('reddit q1').decision.kind === 'act', 'the signal now carries an act decision, so the feed row stops saying "needs you"');
  ok(store().queue.length === 1 && store().queue[0].kind === 'reply', 'the queued row is the reply');
  ok(/reviewer link is in Starter/.test(store().queue[0].payload.text), 'the queued text is the reply the child wrote, not the answer the owner typed');

  // The gate still runs. A reply carrying a stranger's link is refused exactly as a child's
  // own act would be - answering an ask is not a way around §7.4.
  seed([signal('reddit', 'q2', 70, 'what do you use for this?')]);
  const ask2 = asClient(() => createAsk({ kind: 'question', signalKey: 'reddit q2', question: 'which plan?' }));
  const fenced = await asClient(() => answerAsk(ask2.ask.id, 'the Studio plan', {
    runner: async () => ({ ok: true, text: 'Try https://not-our-domain.example/deal instead.', sensitive: false }),
  }));
  ok(fenced.ok !== true && fenced.code === 'invalid_input', 'a reply with a stranger link is refused by the same hard rules a child gets');
  ok(store().asks[0].status === 'open', 'the refused ask stays OPEN so nothing the owner typed is lost');
  ok(store().asks[0].answer === 'the Studio plan', "the owner's words are still on the ask after the refusal");

  // A child that never came back leaves the ask open with the answer on it (row 8's error).
  seed([signal('reddit', 'q3', 70, 'pricing?')]);
  const ask3 = asClient(() => createAsk({ kind: 'question', signalKey: 'reddit q3', question: 'which tier?' }));
  const failed = await asClient(() => answerAsk(ask3.ask.id, 'the Agency tier', {
    runner: async () => ({ ok: false, code: 'agent_failed', message: 'the child did not report' }),
  }));
  ok(failed.ok !== true && failed.code === 'engine_failure', 'a failed spawn is an honest error, not a silent success');
  ok(store().asks[0].status === 'open' && store().asks[0].answer === 'the Agency tier', 'the answer survives a failed spawn');

  // =========================================================================
  console.log('\n[4] a sensitive answer converts to a confirm ask instead of posting (row 8e)');
  // =========================================================================
  seed([signal('reddit', 's1', 70, 'what does this cost for an agency with 12 brands?')]);
  const ask4 = asClient(() => createAsk({ kind: 'question', signalKey: 'reddit s1', question: 'what do we quote agencies?' }));
  const sensitive = await asClient(() => answerAsk(ask4.ask.id, 'Agency is 129 a month for up to 25 brands', {
    runner: async () => ({ ok: true, text: 'The Agency tier is 129 a month for up to 25 brands, so 12 fits with room to grow.', sensitive: true, sensitiveReason: 'this touches pricing' }),
  }));
  ok(sensitive.ok === true && sensitive.confirm === true, 'the answer produced a CONFIRM, not a post');
  ok(sensitive.queued === 0, 'nothing was queued: a sensitive reply never posts unread');
  const confirmAsks = asClient(() => listAsks({ status: 'open' })).filter((a) => a.kind === 'confirm');
  ok(confirmAsks.length === 1, 'exactly one confirm ask now stands');
  ok(confirmAsks[0].reasonLine === 'this touches pricing', 'the confirm carries the one line that says why (S4 renders "Checked before posting: ...")');
  ok(/129 a month/.test(confirmAsks[0].finalText), 'the confirm holds the finished text the owner will read');

  // =========================================================================
  console.log('\n[5] confirmAsk queues the text and SKIPS grace');
  // =========================================================================
  const confirmed = asClient(() => confirmAsk(confirmAsks[0].id));
  ok(confirmed.ok === true && confirmed.queued === 1, 'confirming queues one row');
  const confirmRow = store().queue.find((r) => r.kind === 'reply');
  ok(confirmRow.skipGrace === true, 'the row is flagged to skip grace - the owner just read it');
  // And the PACER honours the flag: with a 15-minute grace window and a follower count far
  // over the threshold (which would normally force grace), the row still gets no graceUntil.
  // planReleases reaches the grace step (step 6) only for a row that first clears the
  // waking-hours gate (step 3, default 08:00-22:00). Pin the clock to mid-day UTC so this block
  // tests ONE variable - the skipGrace flag - and never flakes when the suite runs overnight in
  // UTC (grace is applied on the pass that gives the row a real daytime releaseAt).
  const noonUtc = Date.parse('2026-09-16T12:00:00Z');
  const paced = planReleases(
    [{ ...confirmRow, authorFollowers: 500000 }],
    { ...asClient(() => enginePolicy()), grace: { minutes: 15, followerThreshold: 10000 } },
    {}, noonUtc, {}, { tz: 'UTC' },
  );
  ok(paced.rows[0].graceUntil === null, 'the pacer gives a skipGrace row no undo window, even on a huge account');
  const gracedAnyway = planReleases(
    [{ ...confirmRow, skipGrace: false, authorFollowers: 500000 }],
    { ...asClient(() => enginePolicy()), grace: { minutes: 15, followerThreshold: 10000 } },
    {}, noonUtc, {}, { tz: 'UTC' },
  );
  ok(gracedAnyway.rows[0].graceUntil !== null, 'without the flag the SAME row does sit in grace (the flag is what changed it)');
  // An edited confirm still runs through the humanizer (D11).
  seed([signal('reddit', 'c2', 70, 'question')]);
  const ask5 = asClient(() => createAsk({ kind: 'confirm', signalKey: 'reddit c2', finalText: 'original' }));
  const edited = asClient(() => confirmAsk(ask5.ask.id, 'Our own wording, edited by hand.'));
  ok(edited.ok === true && /edited by hand/.test(edited.text), 'an edited confirm posts the edit');

  // =========================================================================
  console.log('\n[6] dismissAsk attributes the skip to the human who made it (row 8e2)');
  // =========================================================================
  seed([signal('reddit', 'd1', 70, 'a thread the owner does not want to answer')]);
  const ask6 = asClient(() => createAsk({ kind: 'question', signalKey: 'reddit d1', question: 'q' }));
  const dismissed = asClient(() => dismissAsk(ask6.ask.id));
  ok(dismissed.ok === true && dismissed.status === 'dismissed', 'the ask is dismissed');
  ok(sigOf('reddit d1').decision.kind === 'skip' && sigOf('reddit d1').decision.reason === 'owner', 'the signal records skip / owner, so the feed reads "Skipped by you"');
  ok(asClient(() => listAsks({ status: 'open' })).length === 0, 'the strip count drops to zero');
  ok(asClient(() => dismissAsk(ask6.ask.id)).ok !== true, 'a resolved ask cannot be dismissed twice');

  // =========================================================================
  console.log('\n[7] askSweep: a row that ran out of rungs becomes a hand-off (§8 L4)');
  // =========================================================================
  seed(
    [signal('linkedin', 'f1', 82, 'anna asks what this costs for 12 brands')],
    [{
      id: 'row-f1', signalKey: 'linkedin f1', lane: 'linkedin', kind: 'reply',
      payload: { text: 'Per client, and the reviewer link is included.' },
      status: 'failed', waitingOn: null, rung: 'L4', attempts: [{ executor: 'browser', code: 'exec_failed' }],
      result: { code: 'exec_failed', message: 'the post control was not found' },
      executorIndex: 0, executors: null, askId: null, dryRun: false, authorFollowers: 0,
      createdAt: new Date().toISOString(),
    }],
  );
  const swept = asClient(() => askSweep());
  ok(swept.handoffs === 1, 'one hand-off ask was filed');
  const handoff = asClient(() => listAsks({ status: 'open' })).find((a) => a.kind === 'handoff');
  ok(handoff && handoff.lane === 'linkedin' && handoff.actionId === 'row-f1', 'it points at the platform and the row it came from');
  ok(handoff.draft === 'Per client, and the reviewer link is included.', 'it carries the draft, so the owner can copy it');
  ok(handoff.reasonLine === 'the post box was not found', 'the reason is plain words, never the raw exec_failed enum');
  ok(handoff.urgent === true, 'a score of 82 clears the L4 urgency bar (>= 60)');
  const again = asClient(() => askSweep());
  ok(again.handoffs === 0 && asClient(() => listAsks({ status: 'open' })).filter((a) => a.kind === 'handoff').length === 1,
    'the sweep runs every tick forever and never files a second hand-off for the same row');

  // A low-score hand-off is filed, but it is NOT urgent: the ladder running out is not by
  // itself worth a push (§7.7 urgent classes).
  seed(
    [signal('linkedin', 'f2', 20, 'a small thread')],
    [{
      id: 'row-f2', signalKey: 'linkedin f2', lane: 'linkedin', kind: 'reply', payload: { text: 'x' },
      status: 'failed', rung: 'L4', attempts: [], result: { code: 'exec_failed' }, waitingOn: null,
      executorIndex: 0, executors: null, askId: null, dryRun: false, authorFollowers: 0, createdAt: new Date().toISOString(),
    }],
  );
  asClient(() => askSweep());
  ok(asClient(() => listAsks({ status: 'open' }))[0].urgent === false, 'a low-value hand-off is filed quietly');

  // =========================================================================
  console.log('\n[8] a hand-off resolves through the EXISTING radar_mark_copy_posted');
  // =========================================================================
  seed(
    [signal('linkedin', 'f3', 70, 'a thread we could not post to')],
    [{
      id: 'row-f3', signalKey: 'linkedin f3', lane: 'linkedin', kind: 'reply', payload: { text: 'draft' },
      status: 'failed', rung: 'L4', attempts: [], result: { code: 'exec_failed' }, waitingOn: null,
      executorIndex: 0, executors: null, askId: null, dryRun: false, authorFollowers: 0, createdAt: new Date().toISOString(),
    }],
  );
  asClient(() => askSweep());
  ok(asClient(() => listAsks({ status: 'open' })).length === 1, 'the hand-off is open before the owner posts by hand');
  const marked = await asClient(() => markCopyPosted({ source: 'linkedin', externalId: 'f3', postedUrl: 'https://example.test/posted/1', actor: 'owner' }));
  ok(marked.ok === true, 'the owner marked the copy posted, through the verb that already existed');
  ok(asClient(() => listAsks({ status: 'open' })).length === 0, 'the hand-off ask resolved itself: no second verb, no second click');
  const doneRow = store().queue.find((r) => r.id === 'row-f3');
  ok(doneRow.status === 'done' && doneRow.result.permalink === 'https://example.test/posted/1', 'the action row is done and holds the link the owner gave');

  // =========================================================================
  console.log('\n[9] login / switchAccount asks are filed by the sweep and resolve on a probe');
  // =========================================================================
  seed([]);
  asClient(() => setLaneRuntime('linkedin', { usable: false, reason: 'not_logged_in' }));
  asClient(() => setLaneRuntime('reddit', { usable: false, reason: 'wrong_account', handleSeen: 'other_brand' }));
  const laneSweep = asClient(() => askSweep());
  ok(laneSweep.lanes === 2, 'both platforms filed their one standing ask');
  const laneAsks = asClient(() => listAsks({ status: 'open' }));
  ok(laneAsks.some((a) => a.kind === 'login' && a.lane === 'linkedin'), 'the logged-out platform files a login ask');
  const switchAsk = laneAsks.find((a) => a.kind === 'switchAccount');
  ok(switchAsk && switchAsk.lane === 'reddit' && switchAsk.reasonLine === 'other_brand', 'the wrong-account ask names the handle it saw');
  ok(laneAsks.every((a) => a.urgent === true), 'both are urgent (§7.7): the platform cannot act at all until they are fixed');
  ok(asClient(() => askSweep()).lanes === 0, 'a second sweep files nothing new');

  // The probe passing IS the answer. resolveLaneAsks is what engage_probe calls on success.
  asClient(() => setLaneRuntime('linkedin', { usable: true, reason: 'ready' }));
  const resolved = asClient(() => resolveLaneAsks('linkedin', true));
  ok(resolved.resolved === 1, 'the login ask closed itself when the platform came back');
  ok(asClient(() => listAsks({ status: 'open' })).length === 1, 'only the wrong-account ask is left');
  ok(asClient(() => resolveLaneAsks('reddit', false)).resolved === 0, 'a probe that failed AGAIN leaves the ask exactly where it was');
  // And the sweep closes them too, so a lane fixed outside a probe still clears.
  asClient(() => setLaneRuntime('reddit', { usable: true, reason: 'ready' }));
  asClient(() => askSweep());
  ok(asClient(() => listAsks({ status: 'open' })).length === 0, 'the sweep closes an ask whose platform came back on its own');

  // A platform the owner never turned on cannot interrupt them.
  asClient(() => setLaneRuntime('mastodon', { usable: false, reason: 'not_logged_in' }));
  asClient(() => askSweep());
  ok(asClient(() => listAsks({ status: 'open' })).length === 0, 'a platform that is switched off files no ask (being logged out of it is not news)');

  // =========================================================================
  console.log('\n[10] row 17: revoke holds the queue and hands the grace rows back');
  // =========================================================================
  const graceRow = (id, key) => ({
    id, signalKey: key, lane: 'reddit', kind: 'repost', payload: { text: `text for ${id}` },
    status: 'posting_soon', waitingOn: null, rung: null, attempts: [], result: null,
    executorIndex: 0, executors: null, askId: null, dryRun: false, authorFollowers: 0,
    graceUntil: new Date().toISOString(), createdAt: new Date().toISOString(),
  });
  seed(
    [signal('reddit', 'g1', 70, 'a thread'), signal('reddit', 'g2', 70, 'another')],
    [graceRow('row-g1', 'reddit g1'), { ...graceRow('row-g2', 'reddit g2'), status: 'queued', graceUntil: null }],
  );
  const revoked = asClient(() => holdForRevoke());
  ok(revoked.ok === true, 'the revoke hold ran');
  ok(revoked.held === 1, 'the queued row is held rather than released');
  ok(store().queue.find((r) => r.id === 'row-g2').waitingOn === 'paused', 'a queued row now waits on the hold: after a revoke, zero rows execute');
  ok(revoked.asked === 1, 'the grace row became one confirm ask');
  const revokeAsk = asClient(() => listAsks({ status: 'open' }))[0];
  ok(revokeAsk.kind === 'confirm' && revokeAsk.finalText === 'text for row-g1', 'the ask carries the text that was about to go out - nothing is thrown away');
  ok(store().queue.find((r) => r.id === 'row-g1').status === 'cancelled', 'the grace row itself is cancelled: it can only go out now through the confirm');

  // =========================================================================
  console.log('\n[11] the verbs: owner-only writes, an open read');
  // =========================================================================
  seed([signal('reddit', 'v1', 70, 'a thread')]);
  const vAsk = asClient(() => createAsk({ kind: 'question', signalKey: 'reddit v1', question: 'q' }));
  ok(asClient(() => verbs.engageAsksList({})).asks.length === 1, 'engage_asks_list reads the strip');
  ok(asClient(() => verbs.engageDismiss({ askId: vAsk.ask.id, actor: 'agent:claude' })).ok !== true, 'an AGENT cannot skip an ask: an ask exists because a machine may not decide it');
  ok((await asClient(() => verbs.engageAnswer({ askId: vAsk.ask.id, text: 'x', actor: 'agent:claude' }))).ok !== true, 'an agent cannot answer its own ask either');
  ok(asClient(() => verbs.engageConfirmAsk({ askId: vAsk.ask.id, actor: 'agent:claude' })).ok !== true, 'nor confirm one');
  ok(asClient(() => verbs.engageDismiss({ askId: vAsk.ask.id, actor: 'owner' })).ok === true, 'the owner can');

  // The mode gate: writes are refused while the feature is off, the READ still answers - a
  // backlog filed while it was live must stay legible after the owner switches it off.
  writeCfg({ posting: { radar: { engage: { mode: 'off' } } } });
  ok(asClient(() => verbs.engageDismiss({ askId: 'anything', actor: 'owner' })).ok !== true, 'a write is refused while the mode is off');
  ok(asClient(() => verbs.engageAsksList({})).ok === true, 'the read still answers with the mode off');
  ok(asClient(() => askSweep()).ran === false, 'the sweep is inert with the mode off (a byte-unchanged tick)');
  writeCfg({ posting: { radar: { engage: { mode: 'live' } } } });

  // =========================================================================
  console.log(`\n[engage-asks] ${failures ? 'FAILED' : 'OK'} - ${pass} assertions, ${failures} failures.`);
  assert.equal(failures, 0, `${failures} assertion(s) failed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
