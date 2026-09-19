#!/usr/bin/env node
// test/engage-themes.test.mjs - ORIGINAL POSTS from Radar themes (spec 50 P6, §7.10, row 14).
//
// This is the one place where "Respond for me" opens its mouth unprompted, so the test is
// mostly about the gates rather than the words:
//
//   - a theme is only ripe when >= minSignals DISTINCT signals, dated by their OWN clock, fall
//     inside windowDays. An undated signal does NOT count: elsewhere in Radar an undated find
//     fails open because the consequence is "show it to the operator", and here the consequence
//     is "publish something";
//   - at most ONE post row per client per day, counted from BOTH the counters and the live
//     rows, so a row still sitting in its grace window is not invisible to the budget;
//   - the drafted text goes through the SAME lint / link / humanizer fences a reply does;
//   - a failed drafting attempt cools down instead of spawning a child every 60 seconds;
//   - `postedAt` follows the row's arrival at `done`, never an optimistic write at enqueue -
//     a cancelled or failed row must leave the theme free to come back;
//   - and the end to end §12 P6 gate: one theme post PUBLISHED after the grace window, as a
//     planner post approved by `policy:auto-engage`.
//
// No child is ever spawned: themeSweep takes an injected draftRunner, and the config below
// deliberately names NO agent provider, so even a mistaken default spawn could only refuse.
//
// Zero-dep node:assert. Fresh temp PENDPOST_ROOT set BEFORE importing lib.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ok - ${m}`); } else { failures += 1; console.error(`  FAIL - ${m}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-engage-themes-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
// Both plan manifests: the workspace one and the per-client subtree the engage store binds to
// (withClient(clientRoot('default'))), because the planner post lands in the CLIENT's plans.
for (const base of [WS, path.join(WS, 'data', 'clients', 'default')]) {
  fs.mkdirSync(path.join(base, 'data', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(base, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));
}

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse('2026-09-09T10:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

try {
  const { getConfig, setConfig } = await import('../lib/config.mjs');
  const { engageState, createCampaign, createPost } = await import('../lib/writes.mjs');
  const { saveState } = await import('../lib/state.mjs');
  const { withClient } = await import('../lib/context.mjs');
  const { clientRoot, activeClientId } = await import('../lib/multi-client.mjs');
  const { loadPlanStore } = await import('../lib/plans.mjs');
  const { enginePolicy, cancelAction, markDone, engageTick, incrementCounter, engageDateKey } = await import('../lib/engage.mjs');
  const themes = await import('../lib/engage-themes.mjs');
  const {
    themeSignalsInWindow, themeInCooldown, themeDraftCoolingDown, judgeTheme, themePostLane,
    vetThemeText, markThemePosted, reconcileThemePosts, postsUsedToday, themeSweep,
    THEME_REPOST_COOLDOWN_MS, THEME_DRAFT_RETRY_MS,
  } = themes;

  const asClient = (fn) => withClient(clientRoot(activeClientId()), fn);
  const writeCfg = (set) => asClient(() => setConfig({ ifRev: getConfig().rev, actor: 'owner', set }));

  const cfgRes = writeCfg({
    posting: {
      defaultLink: 'https://pendpost.com',
      radar: {
        enabled: true,
        engage: {
          mode: 'live',
          minScore: 30,
          lanes: { mastodon: { enabled: true }, quora: { enabled: true } },
          originalPosts: { enabled: true, minSignals: 3, windowDays: 7 },
        },
      },
    },
  });
  ok(cfgRes.ok === true, 'the fixture config saved (engage live on mastodon, original posts on)');
  const policy = () => asClient(() => enginePolicy());
  ok(policy().caps.post === 1, 'caps.post defaults to 1 a day (§7.1)');

  const sig = (source, externalId, ts, extra = {}) => ({
    source, externalId, url: `https://example.test/${externalId}`, author: 'someone',
    text: 'how do you keep an approval gate when a bot writes the post?',
    intentScore: 70, intentTags: [], ts, ...extra,
  });
  const theme = (id, topic, keys, extra = {}) => ({
    id, topic, signalKeys: keys, firstSeen: iso(NOW - DAY), lastSeen: iso(NOW), postedAt: null, ...extra,
  });
  const seed = (signals, themeRows, queue = [], counters = {}) => asClient(() => {
    const s = engageState();
    s.radar = s.radar && typeof s.radar === 'object' ? s.radar : { signals: [], seen: [], copyPosted: [] };
    s.radar.signals = signals;
    if (!Array.isArray(s.radar.seen)) s.radar.seen = [];
    if (!Array.isArray(s.radar.copyPosted)) s.radar.copyPosted = [];
    s.engage.themes = themeRows;
    s.engage.queue = queue;
    s.engage.counters = counters;
    s.engage.lanes = {};
    saveState();
  });
  const store = () => asClient(() => engageState().engage);
  const fullStore = () => asClient(() => engageState());
  const plans = () => asClient(() => loadPlanStore().campaigns || []);
  const themeById = (id) => store().themes.find((t) => t && t.id === id);
  const draftsSpawned = () => spawns;
  let spawns = 0;
  const runner = (text) => async () => { spawns += 1; return { ok: true, text }; };
  const lanesSeam = () => ['mastodon'];
  const sweep = (opts = {}) => asClient(() => themeSweep({
    now: NOW, tz: 'UTC', draftRunner: runner('Approval gates are the boring half of automation, and the half that saves you.'), connectedLanes: lanesSeam, ...opts,
  }));

  // =========================================================================
  console.log('\n[1] ripeness: distinct signals, dated by their own clock, inside the window');
  // =========================================================================
  const inWindowSignals = [
    sig('mastodon', 'a1', iso(NOW - DAY)),
    sig('mastodon', 'a2', iso(NOW - 2 * DAY)),
    sig('mastodon', 'a3', iso(NOW - 3 * DAY)),
    sig('mastodon', 'old', iso(NOW - 30 * DAY)),
    sig('mastodon', 'undated', null, { ts: null, foundAt: null }),
  ];
  const t1 = theme('t1', 'approval gates', ['mastodon a1', 'mastodon a2', 'mastodon a3', 'mastodon old', 'mastodon undated']);
  const within = themeSignalsInWindow(t1, inWindowSignals, { windowDays: 7, now: NOW });
  ok(within.length === 3, 'three of five signals are inside the 7-day window');
  ok(!within.some((s) => s.externalId === 'old'), 'a signal older than the window does not count');
  ok(!within.some((s) => s.externalId === 'undated'), 'an UNDATED signal does not count: publishing is the one place uncertainty must fail closed');
  const dupTheme = theme('tdup', 'dupes', ['mastodon a1', 'mastodon a1', 'mastodon a2']);
  ok(themeSignalsInWindow(dupTheme, inWindowSignals, { windowDays: 7, now: NOW }).length === 2,
    'the same thread reported twice counts ONCE (distinct by signal key)');

  ok(judgeTheme(t1, inWindowSignals, policy(), NOW).ok === true, 'three signals in seven days is ripe');
  const thin = theme('t2', 'thin', ['mastodon a1', 'mastodon a2']);
  const thinVerdict = judgeTheme(thin, inWindowSignals, policy(), NOW);
  ok(thinVerdict.ok === false && thinVerdict.reason === 'below_min_signals' && thinVerdict.need === 3,
    'two signals is not a theme: below_min_signals, with the number it needed');
  const posted = theme('t3', 'posted', ['mastodon a1', 'mastodon a2', 'mastodon a3'], { postedAt: iso(NOW - 2 * DAY) });
  ok(judgeTheme(posted, inWindowSignals, policy(), NOW).reason === 'cooldown', 'a theme posted two days ago is in the 7-day cool-down');
  ok(themeInCooldown(posted, NOW) === true && themeInCooldown({ ...posted, postedAt: iso(NOW - 8 * DAY) }, NOW) === false,
    `the cool-down is exactly ${THEME_REPOST_COOLDOWN_MS / DAY} days`);
  ok(themeInCooldown(theme('t4', 'never', []), NOW) === false, 'a theme that never posted is never in cool-down');
  ok(themeDraftCoolingDown({ draftFailedAt: iso(NOW - 60_000) }, NOW) === true
    && themeDraftCoolingDown({ draftFailedAt: iso(NOW - THEME_DRAFT_RETRY_MS - 1) }, NOW) === false
    && themeDraftCoolingDown({ draftFailedAt: iso(NOW - 60_000), draft: 'words' }, NOW) === false,
    'a failed draft cools down, unless the theme already carries usable words');

  // =========================================================================
  console.log('\n[2] the gates: off, disabled, no post budget');
  // =========================================================================
  seed(inWindowSignals, [theme('g1', 'approval gates', ['mastodon a1', 'mastodon a2', 'mastodon a3'])]);
  writeCfg({ posting: { radar: { engage: { originalPosts: { enabled: false } } } } });
  ok((await sweep()).reason === 'disabled', 'original posts OFF is a complete no-op, however ripe the theme');
  writeCfg({ posting: { radar: { engage: { originalPosts: { enabled: true }, caps: { post: 0 } } } } });
  ok((await sweep()).reason === 'cap_zero', 'caps.post = 0 disables the kind, exactly as §7.1 says a zero cap does');
  writeCfg({ posting: { radar: { engage: { caps: { post: 1 }, mode: 'off' } } } });
  ok((await sweep()).reason === 'mode_off', 'the whole feature off is a byte-unchanged sweep');
  writeCfg({ posting: { radar: { engage: { mode: 'live' } } } });
  ok(store().queue.length === 0 && spawns === 0, 'not one of those gates spawned a drafting child');

  // =========================================================================
  console.log('\n[3] the happy path: ONE queued post row, and what is on it');
  // =========================================================================
  seed(inWindowSignals, [theme('g1', 'approval gates', ['mastodon a1', 'mastodon a2', 'mastodon a3'])]);
  const first = await sweep();
  ok(first.enqueued === 1 && first.reason === 'queued' && first.themeId === 'g1', 'one row is enqueued for the ripe theme');
  ok(spawns === 1, 'exactly one drafting child was asked for the words');
  const row = store().queue[0];
  ok(row.kind === 'post' && row.lane === 'mastodon' && row.status === 'queued', 'a queued `post` row on the mastodon lane');
  ok(row.signalKey === 'theme:g1' && row.payload.themeId === 'g1', 'the row names the theme it speaks for');
  ok(Array.isArray(row.payload.lanes) && row.payload.lanes[0] === 'mastodon',
    'payload.lanes carries the client CONNECTED publish lanes (what engageApiPost reads), separate from the accounting lane');
  ok(row.payload.text.includes('Approval gates'), 'the drafted text rides on the row');
  ok(row.graceUntil === null, 'graceUntil is left to the pacer: the countdown starts when the row is due, not when it was written');
  ok(themeById('g1').draft === row.payload.text, 'the finished words are stored on the theme, so a tick that cannot enqueue does not throw them away');
  ok(themePostLane(within, policy()) === 'mastodon', 'the accounting lane is the enabled engage lane most of the signals came from');
  ok(themePostLane([sig('quora', 'q1', iso(NOW))], policy()) === null, 'a lane that cannot post at all (quora, §7.2) is never chosen');

  // =========================================================================
  console.log('\n[4] one post per client per day - counters AND live rows');
  // =========================================================================
  const second = await sweep();
  ok(second.enqueued === 0 && second.reason === 'daily_cap', 'a second sweep on the same day enqueues nothing while a row stands');
  ok(spawns === 1, 'and it does not pay for a second draft');
  ok(postsUsedToday(fullStore(), engageDateKey(NOW, 'UTC')) === 1, 'the live grace-window row is visible to the day budget, not only the counters');
  // A CANCELLED row frees the day again; a done one does not (the counter holds it).
  seed(inWindowSignals, [theme('g1', 'approval gates', ['mastodon a1', 'mastodon a2', 'mastodon a3'])], [
    { id: 'x1', signalKey: 'theme:g1', lane: 'mastodon', kind: 'post', status: 'cancelled', createdAt: iso(NOW), payload: { themeId: 'g1' } },
  ]);
  ok(postsUsedToday(fullStore(), engageDateKey(NOW, 'UTC')) === 0, 'a cancelled row spends nothing');
  seed(inWindowSignals, [theme('g1', 'approval gates', ['mastodon a1', 'mastodon a2', 'mastodon a3'])], [], { [`mastodon post ${engageDateKey(NOW, 'UTC')}`]: 1 });
  ok((await sweep()).reason === 'daily_cap', 'a post that already went out today closes the day, even with no row left in the queue');
  ok((await sweep({ now: NOW + DAY })).reason !== 'daily_cap', 'and tomorrow is a new day');

  // =========================================================================
  console.log('\n[5] the fences the words must survive');
  // =========================================================================
  ok(vetThemeText('', { lane: 'mastodon', defaultLink: 'https://pendpost.com' }).code === 'no_text', 'empty words are refused');
  ok(vetThemeText('Read more at https://not-ours.example/deal', { lane: 'mastodon', defaultLink: 'https://pendpost.com' }).code === 'foreign_link',
    "a stranger's link is refused (the §42 link fence)");
  ok(vetThemeText(`x${'y'.repeat(400)}`, { lane: 'x', defaultLink: 'https://pendpost.com' }).code === 'lint',
    'a post over the platform hard cap is refused by brandLint before anything is queued');
  const humanized = vetThemeText('Approval gates are boring — and that is the point.', { lane: 'mastodon', defaultLink: 'https://pendpost.com', locale: 'en' });
  ok(humanized.ok === true && !/[–—]/.test(humanized.text), 'the deterministic humanizer runs on every outbound text (D11): the em dash is gone');
  ok(vetThemeText('Our own link is fine: https://pendpost.com/radar', { lane: 'mastodon', defaultLink: 'https://pendpost.com' }).ok === true,
    "the brand's own link passes");

  seed(inWindowSignals, [theme('g2', 'refused draft', ['mastodon a1', 'mastodon a2', 'mastodon a3'])]);
  const refused = await sweep({ draftRunner: runner('Grab it at https://not-ours.example/deal') });
  ok(refused.enqueued === 0 && refused.reason === 'draft_refused' && refused.code === 'foreign_link',
    'a draft that fails a fence is refused, not posted');
  ok(store().queue.length === 0, 'and nothing at all is queued');
  ok(typeof themeById('g2').draftFailedAt === 'string', 'the failure is stamped on the theme');
  const cooling = await sweep({ draftRunner: runner('a perfectly good second attempt') });
  ok(cooling.reason === 'no_ripe_theme', 'the next tick does NOT spawn another child: the theme is cooling down');
  const later = await sweep({ now: NOW + THEME_DRAFT_RETRY_MS + 1000, draftRunner: runner('a perfectly good second attempt, hours later') });
  ok(later.enqueued === 1, 'once the cool-down is served the theme may be drafted again');

  // =========================================================================
  console.log('\n[6] cancelling a post row inside its grace window');
  // =========================================================================
  seed(inWindowSignals, [theme('g3', 'cancel me', ['mastodon a1', 'mastodon a2', 'mastodon a3'])]);
  await sweep();
  const toCancel = store().queue[0];
  const plansBefore = JSON.stringify(plans());
  const cancelled = asClient(() => cancelAction(toCancel.id));
  ok(cancelled.ok === true && cancelled.action.status === 'cancelled', 'the owner can call the row back');
  ok(JSON.stringify(plans()) === plansBefore,
    'the plan store is byte-unchanged: the planner post is created at EXECUTE time, so a cancel in grace has nothing to delete');
  ok(themeById('g3').postedAt === null, 'a cancelled row leaves the theme free to come back');
  ok((await sweep({ draftRunner: runner('the theme comes back around') })).reason === 'duplicate',
    'the SAME day it does not come back: the row id is deterministic per day, so a cancel is not undone by the next tick sixty seconds later');
  ok((await sweep({ now: NOW + DAY, draftRunner: runner('the theme comes back around') })).enqueued === 1, 'tomorrow it may be posted about again');

  // =========================================================================
  console.log('\n[7] postedAt follows the row to `done`, never the enqueue');
  // =========================================================================
  seed(inWindowSignals, [theme('g4', 'stamp me', ['mastodon a1', 'mastodon a2', 'mastodon a3'])]);
  await sweep();
  const stampRow = store().queue[0];
  ok(themeById('g4').postedAt === null, 'nothing is stamped while the row is only queued');
  asClient(() => markDone(stampRow.id, { postId: 'eng-post-1' }));
  ok(asClient(() => reconcileThemePosts()) === 1, 'the reconcile stamps the theme when its row reaches done');
  ok(typeof themeById('g4').postedAt === 'string' && themeById('g4').postId === 'eng-post-1', 'postedAt + the post id land on the theme');
  ok(asClient(() => reconcileThemePosts()) === 0, 'the reconcile is idempotent (it runs every tick, forever)');
  ok(asClient(() => markThemePosted({ kind: 'like', payload: { themeId: 'g4' } })) === null, 'only a `post` row can stamp a theme');
  ok(judgeTheme(themeById('g4'), inWindowSignals, policy(), NOW).reason === 'cooldown', 'and the theme is now in its cool-down');

  // =========================================================================
  console.log('\n[8] end to end (§12 P6): one theme post PUBLISHED after the grace window');
  // =========================================================================
  const camp = await asClient(() => createCampaign({ id: 'themes', note: 'auto-engage themes', actor: 'owner' }));
  ok(camp.ok === true, 'a campaign exists for the planner post to land in');
  seed(inWindowSignals, [theme('e2e', 'the end to end theme', ['mastodon a1', 'mastodon a2', 'mastodon a3'])]);
  await sweep({ draftRunner: runner('An approval gate is the difference between automation you can leave running and one you cannot.') });

  const tick1 = await asClient(() => engageTick(NOW));
  const paced = store().queue[0];
  ok(tick1.executed === 0, 'the first tick executes nothing: the row is in its grace window');
  ok(paced.status === 'posting_soon' && typeof paced.graceUntil === 'string',
    'an original post ALWAYS sits in grace (D8/D10): status posting_soon with a graceUntil');
  ok(Date.parse(paced.releaseAt) - Date.parse(paced.graceUntil) === 15 * 60 * 1000, 'the window is the configured fifteen minutes');
  ok(plans().every((c) => (c.posts || []).length === 0), 'and nothing exists in the planner yet');

  const tick2 = await asClient(() => engageTick(NOW + 16 * 60 * 1000));
  ok(tick2.executed === 1 && tick2.done === 1, 'after the window the tick executes the row');
  const executed = store().queue[0];
  ok(executed.status === 'done' && executed.result.postId, 'the row is done and names the planner post it created');
  const posts = plans().flatMap((c) => c.posts || []);
  const published = posts.find((p) => p.id === executed.result.postId);
  ok(Boolean(published), 'the planner now holds the post');
  // This is an ORIGINAL POST (post kind, published to your OWN feed), not a radar reply into a
  // stranger's thread - so it is approved by the engage post executor under policy:auto-engage,
  // unchanged by the reply-trust merge (owner Q2 only moved the REPLY approval into radarReplies).
  ok(published.approval === 'approved' && published.approvalBy === 'policy:auto-engage',
    'approved by the policy actor, never by the owner and never by the general auto-approve scope');
  ok((published.platforms || []).includes('mastodon'), 'it publishes on the connected lane the row named');
  ok(published.caption.includes('approval gate'), 'with the drafted words');
  // Row 14's provenance half (§5.5 P6-3): the marker has to survive BOTH whitelists -
  // createPost's copy into the stored post, and normalizePost's copy back out - or the
  // audit reads a post that looks hand-authored. `plans()` is the READ model (the same
  // normalizePost DTO plan_get / listPlan / the dashboard see), so this covers the read
  // side; the raw plan file below covers the disk.
  ok(published.origin === 'radar-theme',
    "plan_get / listPlan report the post's provenance: origin is 'radar-theme', not the owner's calendar");
  const rawPosts = plans()
    .map((c) => JSON.parse(fs.readFileSync(path.resolve(clientRoot(activeClientId()), c.path), 'utf8')))
    .flatMap((p) => p.posts || []);
  ok(rawPosts.find((p) => p.id === executed.result.postId)?.origin === 'radar-theme',
    'and it reached DISK, not just the read model: the stored plan post carries origin');
  ok(store().counters[`mastodon post ${engageDateKey(NOW + 16 * 60 * 1000, 'UTC')}`] === 1, 'the day counter moved on `done`, so tomorrow is the earliest next one');

  const tick3 = await asClient(() => engageTick(NOW + 17 * 60 * 1000));
  ok(tick3.ran === true, 'a third tick runs');
  ok(typeof themeById('e2e').postedAt === 'string', "and the tick's own sweep closed the loop: the theme carries postedAt");
  ok(draftsSpawned() > 0, 'every draft in this file came from the injected runner - no child was ever spawned');

  // =========================================================================
  // =========================================================================
  console.log('\n[9] createPost owns the origin marker: a closed set, and absence stays absence');
  // =========================================================================
  // The write side of §5.5 P6-3, unit-level: the whitelist carries `origin` through, but
  // only for a value the audit surfaces can actually read back. An open provenance string
  // is a claim nobody can check, so anything outside the set is refused like any other
  // bad field - and an owner-authored post keeps NO origin key at all (absence is the
  // default, so no migration invents a provenance for every post already on disk).
  const basePost = { type: 'text', platforms: ['mastodon'], caption: 'a plain calendar post', scheduledAt: iso(NOW + DAY) };
  const foreign = await asClient(() => createPost({
    campaign: 'themes', actor: 'owner', post: { ...basePost, id: 'origin-foreign', origin: 'hand-authored' },
  }));
  ok(foreign.code === 'invalid_input' && /origin must be one of/.test(foreign.message || ''),
    'a foreign origin value is refused (invalid_input), never quietly stored');
  ok(!plans().flatMap((c) => c.posts || []).some((p) => p.id === 'origin-foreign'), 'and the refused post was not created');
  const plain = await asClient(() => createPost({ campaign: 'themes', actor: 'owner', post: { ...basePost, id: 'origin-absent' } }));
  ok(plain.ok !== false && !plain.code, 'a post with no origin is created exactly as before');
  const plainRaw = JSON.parse(fs.readFileSync(path.resolve(clientRoot(activeClientId()), plans().find((c) => c.id === 'themes').path), 'utf8'))
    .posts.find((p) => p.id === 'origin-absent');
  ok(Object.prototype.hasOwnProperty.call(plainRaw, 'origin') === false, 'absence stays absence: no origin key is stamped on disk');
  ok(plans().flatMap((c) => c.posts || []).find((p) => p.id === 'origin-absent').origin === null,
    'and the read model reports it as null, the "authored in the calendar" default');

  // =========================================================================
  console.log(`\n[engage-themes] ${failures ? 'FAILED' : 'OK'} - ${pass} assertions, ${failures} failures.`);
  assert.equal(failures, 0, `${failures} assertion(s) failed`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
