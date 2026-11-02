#!/usr/bin/env node
// test/nostr-inbox-verify.test.mjs - Nostr in full for the reply inbox, and no relay can lie to it
// (planner-bulk contract 2026-11-01, row R4; security review 2026-11-01, two MEDIUM spoofing
// findings).
//
// Any relay in NOSTR_RELAYS can return a fabricated event. The inbox therefore checks every
// event with the engine's own verifyRelayEvent (NIP-01 id recompute + BIP340 signature, the zap
// PAY path's guard) BEFORE dedupe and classification, so a forged reply, mention or zap never
// shows and a forged copy never shadows the real event with the same id. A zap also needs a
// signed kind-9734 request (its pubkey is the zapper shown), the request must name us and our
// note, and its amount tag must equal the receipt's bolt11 amount. A quote or repost found by
// the #p mention read counts only when it targets one of OUR notes.
//
// Fixtures are signed with the engine's own buildEvent (BIP340 over the NIP-01 id); no relay.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); console.log(`  ok - ${m}`); pass += 1; };
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-nostr-verify-'));
process.env.PENDPOST_ROOT = WS;
delete process.env.PENDPOST_MODE;
const engine = await import('../scripts/nostr-social.mjs');
const { keysFromSecret, buildEvent, verifyRelayEvent, bolt11AmountMsat, queryRelays, pointMul, pointAdd, doubleMul } = engine;
const OURS = keysFromSecret('1'.repeat(64));
const ANA = keysFromSecret('2'.repeat(64));
const ZAPPER = keysFromSecret('3'.repeat(64));
const PROVIDER = keysFromSecret('4'.repeat(64));
const NOTE = 'ab'.repeat(32); // one of our published notes
const OTHER_NOTE = 'cd'.repeat(32); // someone else's note
const { envPath } = await import('../lib/util.mjs');
fs.writeFileSync(envPath(), `NOSTR_RELAYS=wss://relay.one,wss://relay.two\nNOSTR_PUBLIC_KEY=${OURS.pubHex}\n`, { mode: 0o600 });
const { runLaneComments, runLaneMentions, nostrEngagementItems, nostrMentionItems, zapFromReceipt, bolt11Msat } = await import('../lib/comments.mjs');

const sign = (keys, kind, tags, content = '') => buildEvent(keys, kind, tags, content);
const zap = ({ amountTag = '21000', bolt11 = 'lnbc210n1pjunk', requestKeys = ZAPPER, unsigned = false, issuer = PROVIDER, e = NOTE, reqTags = null } = {}) => {
  const req = sign(requestKeys, 9734, reqTags || [['p', OURS.pubHex], ...(e ? [['e', e]] : []), ...(amountTag ? [['amount', amountTag]] : []), ['relays', 'wss://relay.one']], 'great post');
  if (unsigned) delete req.sig;
  return sign(issuer, 9735, [['p', OURS.pubHex], ...(e ? [['e', e]] : []), ['bolt11', bolt11], ['description', JSON.stringify(req)]]);
};
const v = verifyRelayEvent;

try {
  // ---- the fast verify is the same math as the affine path --------------------------------
  for (let i = 0; i < 3; i += 1) {
    const a = BigInt(`0x${Buffer.from(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))).toString('hex')}`);
    const b = BigInt(`0x${Buffer.from(Array.from({ length: 32 }, () => Math.floor(Math.random() * 256))).toString('hex')}`);
    const P = pointMul(7n, { x: 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n, y: 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n });
    const G = { x: 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n, y: 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n };
    const slow = pointAdd(pointMul(a, G), pointMul(b, P));
    const fast = doubleMul(a, G, b, P);
    ok(slow.x === fast.x && slow.y === fast.y, `verify math: Jacobian a*G + b*P equals the affine result (round ${i + 1})`);
  }
  const selftest = execFileSync(process.execPath, [path.join(REPO, 'scripts/nostr-social.mjs'), 'selftest'], { cwd: REPO, env: { ...process.env, PENDPOST_ROOT: WS }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  ok(/selftest passed/i.test(selftest), `verify math: the engine selftest (official BIP340 vector, random rounds, tamper) still passes (got ${JSON.stringify(selftest.slice(-200))})`);
  const probe = sign(ANA, 1, [], 'timing');
  const t0 = Date.now();
  for (let i = 0; i < 10; i += 1) v(probe);
  ok(Date.now() - t0 < 1500, `verify speed: ten checks in ${Date.now() - t0} ms (was ~250 ms each)`);

  // ---- replies, reposts, quotes: only signed events count -----------------------------------
  const reply = sign(ANA, 1, [['e', NOTE, '', 'root'], ['p', OURS.pubHex]], 'hello');
  const deep = sign(ANA, 1, [['e', NOTE, '', 'root'], ['e', reply.id, '', 'reply']], 'and more');
  const repost = sign(ANA, 6, [['e', NOTE], ['p', OURS.pubHex]], '');
  const quote = sign(ANA, 1, [['q', NOTE], ['p', OURS.pubHex]], 'look');
  const tampered = { ...sign(ANA, 1, [['e', NOTE, '', 'root']], 'original'), content: 'tampered text' };
  const badSig = { ...sign(ANA, 1, [['e', NOTE, '', 'root']], 'bad sig'), sig: reply.sig };
  const forgedShadow = { ...reply, content: 'forged words under the real id' };
  const own = sign(OURS, 1, [['e', NOTE, '', 'root']], 'our own');
  const items = nostrEngagementItems([forgedShadow, reply, deep, repost, quote, tampered, badSig, own], { noteId: NOTE, ownPubkey: OURS.pubHex, verifyEvent: v });
  const byId = Object.fromEntries(items.map((i) => [i.commentId, i]));
  ok(byId[reply.id] && byId[reply.id].kind === 'comment' && byId[reply.id].text === 'hello', 'reply: a signed direct reply counts, with its real text');
  ok(items.filter((i) => i.commentId === reply.id).length === 1, 'reply: a forged copy listed first under the same id does not shadow the real one');
  ok(byId[deep.id] && byId[deep.id].kind === 'reply' && byId[deep.id].parentId === reply.id, 'reply: a signed reply to a reply carries its NIP-10 parent');
  ok(byId[repost.id] && byId[repost.id].kind === 'repost' && byId[quote.id] && byId[quote.id].kind === 'quote', 'repost + quote of our note count');
  ok(!byId[tampered.id] && !byId[badSig.id], 'a tampered id and a bad signature are dropped');
  ok(!byId[own.id], 'our own note is not inbound');
  ok(nostrEngagementItems([reply], { noteId: NOTE, ownPubkey: OURS.pubHex }).length === 0, 'fail closed: without a verifier nothing is classified');

  // ---- zaps: signed receipt AND signed request, matching amounts -----------------------------
  const good = zap();
  const z = nostrEngagementItems([good], { noteId: NOTE, ownPubkey: OURS.pubHex, verifyEvent: v, bolt11Msat: bolt11AmountMsat })[0];
  ok(z && z.kind === 'zap' && z.author === ZAPPER.pubHex && z.amountSats === 21 && z.text === 'great post', 'zap: verified receipt + verified request -> the zapper, 21 sats, the zap note');
  const unsignedReq = zap({ unsigned: true });
  ok(nostrEngagementItems([unsignedReq], { noteId: NOTE, ownPubkey: OURS.pubHex, verifyEvent: v }).length === 0, 'zap: a receipt whose embedded 9734 is unsigned is dropped');
  const forgedReq = (() => { const r = zap(); const tags = r.tags.map((t) => (t[0] === 'description' ? ['description', JSON.stringify({ ...JSON.parse(t[1]), pubkey: ANA.pubHex })] : t)); return sign(PROVIDER, 9735, tags); })();
  ok(nostrEngagementItems([forgedReq], { noteId: NOTE, ownPubkey: OURS.pubHex, verifyEvent: v }).length === 0, 'zap: a request re-labelled with another zapper fails its own check');
  ok(nostrEngagementItems([zap({ amountTag: '50000' })], { noteId: NOTE, ownPubkey: OURS.pubHex, verifyEvent: v }).length === 0, 'zap: a 9734 amount that does not match the bolt11 amount is dropped');
  ok(nostrEngagementItems([zap({ amountTag: null })], { noteId: NOTE, ownPubkey: OURS.pubHex, verifyEvent: v })[0].amountSats === 21, 'zap: no amount tag -> the bolt11 amount');
  ok(nostrEngagementItems([zap({ amountTag: '21000', bolt11: 'lnbc1pjunk' })], { noteId: NOTE, ownPubkey: OURS.pubHex, verifyEvent: v }).length === 0, 'zap: an amount tag against an amountless invoice cannot match -> dropped');
  ok(nostrEngagementItems([{ ...good, content: 'x' }], { noteId: NOTE, ownPubkey: OURS.pubHex, verifyEvent: v }).length === 0, 'zap: a tampered receipt is dropped');
  ok(nostrEngagementItems([zap({ reqTags: [['p', ANA.pubHex], ['e', NOTE]] })], { noteId: NOTE, ownPubkey: OURS.pubHex, verifyEvent: v }).length === 0, 'zap: a request that zaps someone else is dropped');
  ok(nostrEngagementItems([zap({ reqTags: [['p', OURS.pubHex], ['e', OTHER_NOTE]] })], { noteId: NOTE, ownPubkey: OURS.pubHex, verifyEvent: v }).length === 0, 'zap: a request for another note is dropped');
  ok(zapFromReceipt(good, { verifyEvent: v, ownPubkey: OURS.pubHex, noteId: NOTE, zapProviderPubkey: ANA.pubHex }) === null && zapFromReceipt(good, { verifyEvent: v, ownPubkey: OURS.pubHex, noteId: NOTE, zapProviderPubkey: PROVIDER.pubHex }).sats === 21, 'zap: when our provider pubkey is known, only its receipts count');
  ok(nostrEngagementItems([zap({ requestKeys: OURS })], { noteId: NOTE, ownPubkey: OURS.pubHex, verifyEvent: v }).length === 0, 'zap: a self-zap is not news');
  ok(bolt11Msat('lnbc210n1x') === 21000n && bolt11Msat('lnbc2500u1x') === 250000000n && bolt11Msat('lnbc1x') === null && bolt11Msat('lnbc15p1x') === null, 'bolt11 fallback decode matches the engine (n, u, amountless, sub-msat pico)');

  // ---- mentions (#p): quotes and reposts only of OUR notes ----------------------------------
  const mention = sign(ANA, 1, [['p', OURS.pubHex]], 'hey pendpost');
  const quoteOther = sign(ANA, 1, [['q', OTHER_NOTE], ['p', OURS.pubHex]], 'quoting someone else');
  const quoteOurs = sign(ANA, 1, [['q', NOTE], ['p', OURS.pubHex]], 'quoting you');
  const repostOther = sign(ANA, 6, [['e', OTHER_NOTE], ['p', OURS.pubHex]], '');
  const forgedMention = { ...sign(ANA, 1, [['p', OURS.pubHex]], 'real'), content: 'fake' };
  const profileZap = zap({ e: null });
  const m = nostrMentionItems([mention, quoteOther, quoteOurs, repostOther, forgedMention, profileZap], { ownPubkey: OURS.pubHex, verifyEvent: v, ourNoteIds: [NOTE] });
  const mk = Object.fromEntries(m.map((i) => [i.commentId, i]));
  ok(mk[mention.id] && mk[mention.id].kind === 'mention', 'mention: a signed mention counts');
  ok(!mk[quoteOther.id] && mk[quoteOurs.id] && mk[quoteOurs.id].kind === 'quote', 'mention: a quote of someone else\'s note is dropped; a quote of ours counts');
  ok(!mk[repostOther.id], 'mention: a repost of someone else\'s note is dropped');
  ok(!mk[forgedMention.id], 'mention: a forged mention is dropped');
  ok(mk[profileZap.id] && mk[profileZap.id].kind === 'zap' && mk[profileZap.id].amountSats === 21 && !mk[profileZap.id].inReplyTo, 'mention: a verified profile zap counts');
  ok(nostrMentionItems([quoteOurs], { ownPubkey: OURS.pubHex, verifyEvent: v }).length === 0, 'mention: no list of our notes -> no quote counts (fail closed)');

  // ---- the engine transport: verify before dedupe across relays -----------------------------
  const merged = await queryRelays(['wss://rogue', 'wss://honest', 'wss://down'], {}, async (url) => {
    if (url === 'wss://down') throw new Error('down');
    return url === 'wss://rogue' ? [forgedShadow, tampered] : [reply, mention];
  });
  ok(merged.length === 2 && merged.find((e) => e.id === reply.id).content === 'hello', 'transport: the rogue relay\'s forged copy loses to the honest relay\'s real event; junk is dropped');

  // ---- the lane reads, end to end with an injected transport --------------------------------
  const nostrQuery = async (f) => (f['#q'] ? [quote] : [forgedShadow, reply, deep, good, unsignedReq, tampered]);
  let r = await runLaneComments('nostr', { id: NOTE, nostrQuery, verifyEvent: v, bolt11Msat: bolt11AmountMsat });
  ok(r.ok && r.items.map((i) => i.kind).sort().join() === 'comment,quote,reply,zap', `read: only the signed reply, deep reply, zap and quote (${r.items.map((i) => i.kind).join(',')})`);
  r = await runLaneComments('nostr', { id: NOTE, nostrQuery });
  ok(r.ok === false && r.code === 'no_event_verifier', 'read: a transport without a verifier refuses instead of trusting relays');
  r = await runLaneMentions('nostr', { nostrQuery: async () => [mention, quoteOther, quoteOurs], verifyEvent: v, 'our-notes': `${NOTE},not-hex` });
  ok(r.ok && r.items.length === 2, 'mentions: --our-notes from the sweep limits quotes to our notes');

  console.log(`\n${pass} passed`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
