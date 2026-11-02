#!/usr/bin/env node
// test/nostr-inbox-zap-provider.test.mjs - two more spoofing guards on the Nostr reply inbox
// (security review 2026-11-01, round two, both MEDIUM).
//
//  (A) The relay fan-out's signature budget is PER RELAY: a rogue relay that answers first with
//      hundreds of forged events spends only its own budget, so an honest relay's real reply
//      still gets checked and lands. A failed check counts against the relay that sent it.
//  (B) A zap's amount is only trusted when the receipt was issued by OUR Lightning provider
//      (the LNURL `nostrPubkey` of our own profile's lud16/lud06). The sweep resolves it ONCE,
//      caches it ~24 h in state.comments.zapProvider, and hands it to every Nostr read
//      (--zap-provider). Known provider: a receipt from anyone else is dropped and a matching
//      one carries amountVerified:true. Unknown provider: the zap is kept with
//      amountVerified:false, so no total, digest line or insight counts its sats.
//
// Signed fixtures via the engine's own buildEvent; relay and LNURL reads are injected.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-zap-provider-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
const engine = await import('../scripts/nostr-social.mjs');
const { keysFromSecret, buildEvent, verifyRelayEvent, bolt11AmountMsat, queryRelays, relayVerifyBudget, cmdZapProvider, RUN } = engine;
const OURS = keysFromSecret('1'.repeat(64));
const ANA = keysFromSecret('2'.repeat(64));
const ZAPPER = keysFromSecret('3'.repeat(64));
const PROVIDER = keysFromSecret('4'.repeat(64));
const ROGUE = keysFromSecret('5'.repeat(64));
const NOTE = 'ab'.repeat(32);
const { envPath } = await import('../lib/util.mjs');
fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(envPath(), `NOSTR_RELAYS=wss://relay.one\nNOSTR_PUBLIC_KEY=${OURS.pubHex}\n`, { mode: 0o600 });
const { nostrEngagementItems, zapFromReceipt, runLaneComments } = await import('../lib/comments.mjs');

const zap = (issuer = PROVIDER) => {
  const req = buildEvent(ZAPPER, 9734, [['p', OURS.pubHex], ['e', NOTE], ['amount', '21000']], 'great post');
  return buildEvent(issuer, 9735, [['p', OURS.pubHex], ['e', NOTE], ['bolt11', 'lnbc210n1pjunk'], ['description', JSON.stringify(req)]], '');
};

try {
  // ---- (A) per-relay signature budget ------------------------------------------------------
  ok(relayVerifyBudget(1) === 400 && relayVerifyBudget(2) === 200 && relayVerifyBudget(10) === 50 && relayVerifyBudget(40) === 50, 'budget: ceil(400 / relays), at least 50 per relay');
  const forged = Array.from({ length: 400 }, (_, i) => ({ id: i.toString(16).padStart(64, '0'), forged: true }));
  const real = { id: 'f'.repeat(64), real: true };
  const checks = { rogue: 0, honest: 0 };
  const merged = await queryRelays(['wss://rogue', 'wss://honest'], {}, async (url) => (url === 'wss://rogue' ? forged : [real]), (e) => {
    checks[e.forged ? 'rogue' : 'honest'] += 1;
    return e.real === true;
  });
  ok(merged.length === 1 && merged[0].id === real.id, 'budget: 400 forged events from a rogue relay cannot starve the honest relay\'s one real reply');
  ok(checks.rogue === 200 && checks.honest === 1, `budget: the rogue relay spent only its own share (${checks.rogue} checks), the honest one was still checked`);
  const many = Array.from({ length: 10 }, (_, i) => `wss://r${i}`);
  const perRelay = {};
  await queryRelays(many, {}, async (url) => Array.from({ length: 80 }, (_, i) => ({ id: `${url}-${i}`, url })), (e) => { perRelay[e.url] = (perRelay[e.url] || 0) + 1; return false; });
  ok(Object.values(perRelay).every((n) => n === 50), 'budget: with ten relays each one gets 50 checks, no more');

  // ---- (B) zaps: the provider decides whether the amount is trusted ------------------------
  const good = zap(PROVIDER);
  const minted = zap(ROGUE); // an attacker can sign a receipt with any bolt11 amount
  const v = verifyRelayEvent;
  let z = zapFromReceipt(good, { verifyEvent: v, bolt11Msat: bolt11AmountMsat, ownPubkey: OURS.pubHex, noteId: NOTE, zapProviderPubkey: PROVIDER.pubHex });
  ok(z && z.sats === 21 && z.amountVerified === true, 'provider known: our provider\'s receipt -> amountVerified true');
  ok(zapFromReceipt(minted, { verifyEvent: v, ownPubkey: OURS.pubHex, noteId: NOTE, zapProviderPubkey: PROVIDER.pubHex }) === null, 'provider known: a receipt minted by anyone else is dropped');
  z = zapFromReceipt(minted, { verifyEvent: v, ownPubkey: OURS.pubHex, noteId: NOTE });
  ok(z && z.amountVerified === false && z.pubkey === ZAPPER.pubHex, 'provider unknown: the zap is kept, amountVerified false (the zapper is still the signed request)');
  let items = nostrEngagementItems([good], { noteId: NOTE, ownPubkey: OURS.pubHex, verifyEvent: v });
  ok(items[0].kind === 'zap' && items[0].amountVerified === false && items[0].amountSats === 21, 'item: unknown provider -> amountVerified:false rides the item');
  items = nostrEngagementItems([good, minted], { noteId: NOTE, ownPubkey: OURS.pubHex, verifyEvent: v, zapProviderPubkey: PROVIDER.pubHex });
  ok(items.length === 1 && items[0].amountVerified === true, 'item: known provider -> the minted receipt is gone, ours is verified');
  const r = await runLaneComments('nostr', { id: NOTE, nostrQuery: async (f) => (f['#q'] ? [] : [good, minted]), verifyEvent: v, 'zap-provider': PROVIDER.pubHex.toUpperCase() });
  ok(r.ok && r.items.length === 1 && r.items[0].amountVerified === true, 'read: --zap-provider reaches the classification (case-insensitive hex)');

  // ---- the engine resolves OUR provider from our own profile, once -------------------------
  fs.writeFileSync(envPath(), `NOSTR_RELAYS=wss://relay.one\nNOSTR_PUBLIC_KEY=${OURS.pubHex}\n`, { mode: 0o600 });
  let asked = null;
  RUN.zapProvider = undefined;
  await cmdZapProvider({}, { resolve: async (relays, pub) => { asked = { relays, pub }; return { nostrPubkey: PROVIDER.pubHex.toUpperCase(), allowsNostr: true }; }, hasWebSocket: true });
  ok(asked && asked.pub === OURS.pubHex && asked.relays.join() === 'wss://relay.one' && RUN.zapProvider && RUN.zapProvider.nostrPubkey === PROVIDER.pubHex, 'engine: zap-provider reads OUR profile\'s Lightning address and returns its nostrPubkey');
  RUN.zapProvider = undefined;
  await cmdZapProvider({}, { resolve: async () => { throw new Error('the recipient has no Lightning address (lud16/lud06) - cannot zap'); }, hasWebSocket: true });
  ok(RUN.zapProvider === null && /Lightning address/.test(RUN.zapProviderError), 'engine: no Lightning address -> provider null with the reason');
  const mock = JSON.parse(execFileSync(process.execPath, [path.join(REPO, 'scripts/nostr-social.mjs'), 'zap-provider', '--json'], { cwd: REPO, env: { ...process.env, PENDPOST_ROOT: WS, PENDPOST_MODE: 'mock' }, encoding: 'utf8' }).trim().split('\n').pop());
  ok(mock.ok === true && mock.zapProvider === null, 'engine (mock): zap-provider answers unknown, never a network call');

  // ---- the sweep: resolve once per ~24 h, pass it to every Nostr read ----------------------
  fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [{ id: 'n', path: 'data/plans/n.json', active: true }] }));
  fs.writeFileSync(path.join(WS, 'data', 'plans', 'n.json'), JSON.stringify({ campaign: 'n', posts: [{ id: 'note', type: 'text', platforms: ['nostr'], status: 'posted', postedAt: new Date(Date.now() - 864e5).toISOString(), nostrEventId: NOTE }] }));
  const { commentSweep, commentInbox } = await import('../lib/comment-watch.mjs');
  const { getConfig, setConfig } = await import('../lib/config.mjs');
  const { loadState } = await import('../lib/state.mjs');
  setConfig({ ifRev: getConfig().rev, actor: 'owner', set: { posting: { commentWatch: { enabled: true } } } });
  let resolves = 0;
  const seen = { comments: null, mentions: null };
  const run = (now, provider = PROVIDER.pubHex) => commentSweep({
    force: true, now,
    resolveZapProvider: async () => { resolves += 1; return provider ? { pubkey: provider } : { pubkey: null, error: 'no lightning address' }; },
    readComments: async (args, known) => { seen.comments = known && known.extraArgs; return { ok: true, items: [{ kind: 'zap', commentId: 'z1', author: ZAPPER.pubHex, text: 'great', ts: new Date(now).toISOString(), amountSats: 21, amountVerified: true }] }; },
    readMentions: async (lane, ctx) => { seen.mentions = ctx && ctx.zapProvider; return { ok: true, items: [] }; },
    readRadarReplies: async () => ({ items: [], sources: {} }), readReviews: async () => null, readEvents: async () => [],
  });
  const t0 = Date.now();
  await run(t0);
  ok(resolves === 1 && Array.isArray(seen.comments) && seen.comments.join(' ') === `--zap-provider ${PROVIDER.pubHex}` && seen.mentions === PROVIDER.pubHex, 'sweep: resolves our provider once and hands it to the comments and the mentions read');
  ok(loadState().comments.zapProvider.pubkey === PROVIDER.pubHex, 'sweep: the provider is cached in state.comments.zapProvider');
  ok(commentInbox().posts[0].comments[0].amountVerified === true, 'sweep: amountVerified reaches the inbox item');
  await run(t0 + 3 * 3600e3);
  ok(resolves === 1, 'sweep: inside 24 h the cached provider is reused (no call per sweep, none per zap)');
  await run(t0 + 25 * 3600e3, null);
  ok(resolves === 2 && seen.comments.length === 0 && seen.mentions === null, 'sweep: after 24 h it resolves again; unknown -> no --zap-provider at all');
  await run(t0 + 27 * 3600e3, null);
  ok(resolves === 2, 'sweep: an unresolved provider is not retried on every sweep either');

  console.log(`\n${pass} passed`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
