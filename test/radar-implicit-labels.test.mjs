// radar-implicit-labels.test.mjs - Radar 2.0 step 2 (spec 53): the owner's ordinary actions write
// steering examples into state.radar.feedback, with no new control, and nothing an agent or an
// MCP caller says can write one. Plus the ingest role-drop integrity fence.
//
// Proofs:
//   (a) addImplicitFeedback: a weak (implicit) example never pushes out an explicit tap, an
//       explicit tap pushes out the oldest weak one first, a weak label never overrides the owner's
//       own tap on the same signal, an engaged (strong) label is idempotent;
//   (b) owner paths label, everything else does not: "Done" (more), a bulk sweep (less) and a
//       hand-posted copy (more) label ONLY with the process-private RADAR_OWNER_ACTION marker the
//       Studio REST routes set; the same calls with a JSON body (MCP, any actor string, even
//       "owner") label nothing; the four REST routes carry the marker;
//   (c) Undo of a "Done" takes its implicit example back;
//   (d) a reply the author answered becomes an engaged (strong) "more", once;
//   (e) security: a vendor role drop from radar_ingest never deletes a cached signal, never
//       rewrites an existing seen entry (owner triage), and is appended only for an unknown key.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-radar-labels-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }));
const Q = { id: 'q1', label: 'scheduler seekers', keywords: ['scheduler'], sources: ['hackernews'] };
fs.writeFileSync(path.join(WS, 'config.json'), JSON.stringify({ radar: { enabled: true, queries: [Q] } }));

try {
  const { addImplicitFeedback, addFeedback, RADAR_FEEDBACK_CAP, RADAR_FEEDBACK_IMPLICIT, RADAR_FEEDBACK_ENGAGED } = await import('../lib/radar.mjs');
  const { RADAR_OWNER_ACTION } = await import('../lib/radar-tuner.mjs');
  const W = await import('../lib/writes.mjs');
  const { loadState, saveState } = await import('../lib/state.mjs');

  // ---- (a) the pure store rules -------------------------------------------------------------
  const ex = (id) => ({ excerpt: `text ${id}`, url: `https://x/${id}`, source: 'hackernews', externalId: id, at: new Date().toISOString() });
  let fb = {};
  for (let i = 0; i < RADAR_FEEDBACK_CAP; i += 1) fb = addFeedback(fb, 'q1', 'more', ex(`e${i}`));
  fb = addImplicitFeedback(fb, 'q1', 'more', ex('w1'));
  ok(fb.q1.more.length === RADAR_FEEDBACK_CAP && !fb.q1.more.some((e) => e.externalId === 'w1'), 'a weak example never pushes out an explicit tap (side full of explicit taps)');
  let fb2 = {};
  for (let i = 0; i < RADAR_FEEDBACK_CAP; i += 1) fb2 = addImplicitFeedback(fb2, 'q1', 'less', ex(`w${i}`));
  fb2 = addFeedback(fb2, 'q1', 'less', ex('tap'));
  ok(fb2.q1.less.length === RADAR_FEEDBACK_CAP && fb2.q1.less.some((e) => e.externalId === 'tap') && !fb2.q1.less.some((e) => e.externalId === 'w0'), 'an explicit tap pushes out the OLDEST weak example first');
  let fb3 = addFeedback({}, 'q1', 'less', ex('s1'));
  fb3 = addImplicitFeedback(fb3, 'q1', 'more', ex('s1'));
  ok(fb3.q1.less.length === 1 && fb3.q1.more.length === 0, "a weak label never overrides the owner's own tap on the same signal");
  let fb4 = addImplicitFeedback({}, 'q1', 'more', ex('s2'), { strong: true });
  const again = addImplicitFeedback(fb4, 'q1', 'more', ex('s2'), { strong: true });
  ok(fb4.q1.more[0].by === RADAR_FEEDBACK_ENGAGED && again.q1 === fb4.q1, 'an engaged label is marked and idempotent');
  ok(addImplicitFeedback({}, 'q1', 'more', ex('s3')).q1.more[0].by === RADAR_FEEDBACK_IMPLICIT, 'an implicit label is marked weak');

  // ---- seed a feed ---------------------------------------------------------------------
  const now = new Date().toISOString();
  const seed = (id, extra = {}) => ({ source: 'hackernews', externalId: id, url: `https://news.ycombinator.com/item?id=${id}`, author: `a_${id}`, text: `which scheduler for ${id}?`, matchedQuery: 'q1', ts: now, intentScore: 70, intentTags: [], suggestedAction: 'reply', scoredBy: 'agent', ingested: true, intent: 'ask_reco', authorRole: 'seeker', replyable: true, classifiedBy: 'agent', ...extra });
  let st = loadState();
  st.radar = { signals: ['d1', 'd2', 'b1', 'b2', 'c1', 'c2', 'r1', 'watch1', 'owned1'].map((id) => seed(id, id === 'watch1' ? { watched: true } : {})), seen: [{ source: 'hackernews', externalId: 'tri1', at: now, by: 'less', queryId: 'q1' }], feedback: {} };
  saveState();
  const fbq = () => (loadState().radar.feedback || {}).q1 || { less: [], more: [] };
  const has = (side, id, by) => (fbq()[side] || []).some((e) => e.externalId === id && (by === undefined || e.by === by));
  // An MCP call is a JSON body: a Symbol key cannot survive it.
  const viaJson = (args) => JSON.parse(JSON.stringify(args));

  // ---- (b) owner paths only ------------------------------------------------------------
  let r = await W.triageSignal(viaJson({ source: 'hackernews', externalId: 'd1', action: 'dismiss', actor: 'owner', [RADAR_OWNER_ACTION]: true }));
  ok(r.ok && !has('more', 'd1'), 'an MCP/JSON "Done" (even actor "owner") writes NO label');
  r = await W.triageSignal({ source: 'hackernews', externalId: 'd2', action: 'dismiss', actor: 'gui', [RADAR_OWNER_ACTION]: true });
  ok(r.ok && has('more', 'd2', RADAR_FEEDBACK_IMPLICIT), 'the owner-verified "Done" is an implicit "more like this"');

  r = await W.triageSignalsBulk(viaJson({ ids: [{ source: 'hackernews', externalId: 'b1' }], action: 'dismiss', actor: 'owner' }));
  ok(r.ok && r.dismissed === 1 && !has('less', 'b1'), 'an MCP bulk sweep writes NO label');
  r = await W.triageSignalsBulk({ ids: [{ source: 'hackernews', externalId: 'b2' }], action: 'dismiss', actor: 'gui', [RADAR_OWNER_ACTION]: true });
  ok(r.ok && has('less', 'b2', RADAR_FEEDBACK_IMPLICIT), 'the owner-verified bulk sweep is an implicit "less like this"');

  r = await W.markCopyPosted({ source: 'hackernews', externalId: 'c1', actor: 'policy:auto-engage' });
  ok(r.ok && !has('more', 'c1'), 'the auto-engage executor marking a copy posted writes NO label');
  r = await W.markCopyPosted({ source: 'hackernews', externalId: 'c2', actor: 'gui', [RADAR_OWNER_ACTION]: true });
  ok(r.ok && has('more', 'c2', RADAR_FEEDBACK_IMPLICIT), 'the owner-verified hand-posted copy is an implicit "more"');

  const apiSrc = fs.readFileSync(new URL('../lib/api.mjs', import.meta.url), 'utf8');
  for (const fn of ['triageSignal', 'triageSignalsBulk', 'markCopyPosted', 'queueRadarReply']) {
    const line = apiSrc.split('\n').find((l) => l.includes(`=> ${fn}({`));
    ok(line && line.includes('[RADAR_OWNER_ACTION]: isStudioOwner(req)'), `the Studio REST route for ${fn} carries the owner marker, derived from the Studio token (spec 56)`);
  }
  const mcpSrc = fs.readFileSync(new URL('../lib/mcp.mjs', import.meta.url), 'utf8');
  ok(!mcpSrc.includes('RADAR_OWNER_ACTION'), 'the MCP face never sets the owner marker');

  // ---- (c) Undo -------------------------------------------------------------------------
  const d2 = seed('d2');
  r = await W.restoreSignals({ signals: [d2], actor: 'gui' });
  ok(r.ok && !has('more', 'd2'), 'Undo of a "Done" takes its implicit example back');

  // ---- (d) engaged -----------------------------------------------------------------------
  st = loadState();
  st.radar.copyPosted.push({ source: 'hackernews', externalId: 'r1', at: now, actor: 'gui', radarReplyState: 'author_replied', radarFollowup: { author: 'a_r1', text: 'thanks!' } });
  saveState();
  ok(W.labelEngagedReplies() === 1 && has('more', 'r1', RADAR_FEEDBACK_ENGAGED), 'an answered reply becomes an engaged (strong) "more"');
  ok(W.labelEngagedReplies() === 0, 'and only once');

  // ---- (e) the ingest role-drop integrity fence ----------------------------------------
  const before = loadState().radar;
  const triEntry = JSON.stringify(before.seen.find((e) => e.externalId === 'tri1'));
  const ing = await W.radarIngest({ actor: 'agent:radar-scan', queryId: 'q1', signals: [
    { source: 'hackernews', externalId: 'watch1', url: 'https://news.ycombinator.com/item?id=watch1', ts: now, text: 'a scheduler pitch', authorRole: 'vendor', intent: 'none', replyable: true },
    { source: 'hackernews', externalId: 'owned1', url: 'https://news.ycombinator.com/item?id=owned1', ts: now, text: 'a scheduler pitch', authorRole: 'competitor', intent: 'none', replyable: true },
    { source: 'hackernews', externalId: 'tri1', url: 'https://news.ycombinator.com/item?id=tri1', ts: now, text: 'a scheduler pitch', authorRole: 'bot', intent: 'none', replyable: true },
    { source: 'hackernews', externalId: 'new-vendor', url: 'https://news.ycombinator.com/item?id=nv', ts: now, text: 'a scheduler pitch', authorRole: 'vendor', intent: 'none', replyable: true },
  ] });
  const after = loadState().radar;
  ok(ing.ok && ing.roleDropped === 4, `all four role drops are counted (${ing.roleDropped})`);
  ok(after.signals.some((s) => s.externalId === 'watch1' && s.watched === true) && after.signals.some((s) => s.externalId === 'owned1' && s.authorRole === 'seeker'), 'an ingest role drop NEVER deletes or rewrites a cached signal (watched or not)');
  ok(!after.seen.some((e) => e.externalId === 'watch1' || e.externalId === 'owned1'), 'no seen entry is added for a key that is cached');
  ok(JSON.stringify(after.seen.find((e) => e.externalId === 'tri1')) === triEntry && after.seen.filter((e) => e.externalId === 'tri1').length === 1, "the owner's existing seen entry (triage) is never replaced");
  const nv = after.seen.find((e) => e.externalId === 'new-vendor');
  ok(nv && nv.by === 'judge' && nv.reason === 'vendor-or-bot', 'an unknown vendor key is appended to the seen ledger');
} catch (err) {
  failures += 1;
  console.error(`  FAIL - threw: ${err && err.stack}`);
}
console.log(`\n${pass} passed, ${failures} failed`);
if (failures) { console.error(`[radar-implicit-labels] FAIL - ${failures} assertion(s) failed`); process.exit(1); }
