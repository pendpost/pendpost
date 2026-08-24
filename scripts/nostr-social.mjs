#!/usr/bin/env node
/**
 * nostr-social.mjs - direct Nostr publishing via NIP-01 relays.
 *
 * Sibling of scripts/telegram-social.mjs / x-social.mjs / discord-social.mjs:
 * the same zero-dep, plan-driven, publish-straight-from-the-local-render pattern,
 * with Nostr's own (radically simple) keypair identity + relay fan-out model.
 *
 * Nostr has NO central API, NO OAuth and NO scheduling - identity is a secp256k1
 * keypair and "publishing" means handing a signed event to relays - so entries
 * publish at their due time by re-running `publish-due` (driven by the scheduler
 * tick), exactly like Instagram / LinkedIn / X / Telegram.
 *
 * AUTH - a single static keypair, no ceremony:
 *   NOSTR_PRIVATE_KEY  the signing key: nsec1... (bech32, NIP-19) or 64-char hex.
 *                      Mint one with `keygen [--save]` - there is no signup.
 *   NOSTR_RELAYS       comma-separated relay websocket URLs (wss://... or ws://...).
 * `connect`/`auth` here derives + persists NOSTR_PUBLIC_KEY (hex) and NOSTR_NPUB
 * (bech32) and confirms at least one configured relay actually answers a REQ:
 * there is no token to mint, only a key to prove and relays to reach.
 *
 * PUBLISH - every due entry becomes ONE signed event fanned out to EVERY configured
 * relay; the post counts as published when at least ONE relay replies ["OK", <id>,
 * true] - that is Nostr's delivery model (redundancy over guarantees, per-relay
 * acceptance is advisory). publish-due branches on post.type:
 *   - text/default -> a kind-1 short note (NIP-01). Text comes from post.nostrCaption
 *     (falls back to post.caption), the additive per-platform override pattern x uses
 *     for xCaption; relays impose no hard length cap.
 *   - poll         -> a kind-1068 NIP-88 poll event (spec 10).
 *   - nostr-longform -> a kind-30023 NIP-23 LONG-FORM article (spec 18): content is
 *     the Markdown post.body; title/summary(excerpt)/published_at/image/t(hashtags)
 *     ride tags; a stable `d` tag (post.blogSlug || post.id) makes it a PARAMETERIZED-
 *     REPLACEABLE event, so re-publishing the SAME post EDITS the article in place
 *     (a natural fit for pendpost's re-run model) rather than posting a duplicate.
 * Media (NIP-96/98) rides uploadNostrMedia for BOTH an article's NIP-23 header image
 * AND a short note's NIP-92 `imeta` embed: an already-remote post.image URL is used
 * as-is; a LOCAL render is uploaded to the NOSTR_MEDIA_SERVER (a signed NIP-98 kind-27235
 * auth header carrying a payload sha256). A type=text note with a resolvable local image
 * embeds it via an imeta tag (URL appended to the content); a note with NO media stays a
 * bare kind-1 (byte-identical). Degradation is honest + never a crash, with a distinct
 * warning code per cause: 'media_not_configured' (no NOSTR_MEDIA_SERVER), 'upload_failed'
 * (server set but the upload failed), 'media_missing' (a render was referenced but did
 * not resolve on disk). --dry-run performs NO upload and NO relay publish (preview only).
 *   NOSTR_MEDIA_SERVER  optional NIP-96 file-server base URL for article + note images.
 *
 * Permalinks go through njump.me (a public event gateway) via the NIP-19
 * note1... encoding of the event id. `delete` publishes a NIP-09 kind-5
 * deletion event - relays MAY honor it, nothing forces them to.
 *
 * All crypto is IN-FILE and dependency-free: bech32 (BIP-173), secp256k1 +
 * BIP340 Schnorr over BigInt, tagged hashes via node:crypto. `selftest` proves
 * the implementation against the official BIP340 test vector before any key
 * ever touches a relay. Relay I/O uses the GLOBAL WebSocket, so network
 * commands require Node >= 22.
 *
 * Commands:
 *   keygen           [--save]                    mint a fresh keypair (prints nsec + npub)
 *   auth | connect   derive + persist the public identity, check relay reachability
 *   refresh          no-op (keypairs are static) - kept for sibling parity
 *   validate         --plan <p> [--only <id>]   side-effect-free preview, never posts
 *   publish-due      --plan <p> [--only <id>] [--dry-run]   publish any due Nostr entry
 *                                                          (kind-1 note | kind-1068 poll | kind-30023 article)
 *   status           --plan <p>                 list Nostr plan entries
 *   verify           --plan <p> [--only <id>]   read-only liveness (REQ by event id)
 *   insights         --plan <p> [--only <id>]   reaction (kind-7) + zap-receipt (kind-9735) counts per note (spec 08)
 *   probe                                        read-only health probe
 *   delete           --id <eventId>              publish a NIP-09 deletion request
 *   selftest                                     offline crypto self-check (BIP340 + bech32)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveMode, isMockableCommand } from '../lib/mode.mjs';
import { enforceCeremonyClient } from '../lib/cli-client.mjs';
import { recordAttempt } from '../lib/publish-hold.mjs';
import { runMockCommand } from '../lib/drivers/mock-driver.mjs';
import { isPollPost, pollOptions, pollDurationMinutes, pollMultiple, pollBlocker, pollBlockRow, POLL_LANE_LIMITS } from '../lib/poll.mjs';
import { envPath } from '../lib/util.mjs';
import { resolveCredential } from '../lib/cli-prompt.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = envPath();

// Every relay exchange (EVENT publish, REQ read-back, reachability probe) is
// wrapped in a promise with this timeout - a dead relay must never hang a tick.
// The 10s ceiling is sized for a WRITE: an OK acceptance frame can settle over
// several seconds, so a publish must wait it out.
const RELAY_TIMEOUT_MS = 10 * 1000;

// READS and reachability probes get a TIGHTER ceiling. A live relay answers a
// trivial REQ (EVENT/EOSE) in well under 2s; a relay that cannot is dead FOR OUR
// PURPOSES. The fan-outs behind the health probe and the NIP-65 relay-list read
// use Promise.allSettled, so their wall-time is the SLOWEST relay - at 10s each a
// single dead relay (e.g. one that times out rather than erroring fast) can push
// the whole call past its parent execFile budget and surface as a hard "no probe
// result" / "engine produced no envelope", certifying the lane as FAILED even
// though live relays answered instantly. Capping reads at 4s keeps a dead relay
// from dragging a read/probe over that edge, while giving a live relay 2x margin.
const RELAY_READ_TIMEOUT_MS = 4 * 1000;

// Relay I/O rides the GLOBAL WebSocket (Node >= 22). Guarded per network
// command so the offline commands (keygen, selftest, validate, status) still
// work on older Nodes.
function requireWebSocket() {
  if (typeof WebSocket === 'undefined') {
    console.error('[err] the nostr lane needs Node >= 22 (global WebSocket)');
    process.exit(2);
  }
}

// ---------- env helpers (same shape as the sibling engines) ----------

function readEnvRaw() {
  return fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
}
function readEnv(name) {
  const m = readEnvRaw().match(new RegExp(`^${name}=(.+)$`, 'm'));
  return m ? m[1].trim() : null;
}
function writeEnv(vars) {
  let raw = readEnvRaw();
  for (const [k, v] of Object.entries(vars)) {
    if (v == null) continue;
    // function replacer: values may contain '$' which is special in a string replacement.
    if (new RegExp(`^${k}=`, 'm').test(raw)) {
      raw = raw.replace(new RegExp(`^${k}=.*$`, 'm'), () => `${k}=${v}`);
    } else {
      raw += `${raw.endsWith('\n') || raw === '' ? '' : '\n'}${k}=${v}\n`;
    }
  }
  // Atomic + 0600: a crash mid-write must never truncate the secret-bearing .env.
  const tmp = `${ENV_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, raw, { mode: 0o600 });
  fs.renameSync(tmp, ENV_PATH);
}

// ---------- bech32 (BIP-173) - the NIP-19 nsec/npub/note encoding ----------

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const BECH32_GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function bech32Polymod(values) {
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= BECH32_GEN[i];
  }
  return chk;
}

function bech32HrpExpand(hrp) {
  const out = [];
  for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
  out.push(0);
  for (const c of hrp) out.push(c.charCodeAt(0) & 31);
  return out;
}

// 8-bit <-> 5-bit regrouping (BIP-173 "convertbits").
function convertBits(data, from, to, pad) {
  let acc = 0;
  let bits = 0;
  const out = [];
  const maxv = (1 << to) - 1;
  for (const v of data) {
    if (v < 0 || v >> from) throw new Error('bech32: invalid data value');
    acc = (acc << from) | v;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits) out.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv)) {
    throw new Error('bech32: invalid padding');
  }
  return out;
}

function bech32Encode(hrp, bytes) {
  const data = convertBits([...bytes], 8, 5, true);
  const pm = bech32Polymod([...bech32HrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = [];
  for (let i = 0; i < 6; i++) checksum.push((pm >> (5 * (5 - i))) & 31);
  return `${hrp}1${[...data, ...checksum].map((v) => BECH32_CHARSET[v]).join('')}`;
}

function bech32Decode(str, expectedHrp = null) {
  if (str !== str.toLowerCase() && str !== str.toUpperCase()) throw new Error('bech32: mixed case');
  const lower = str.toLowerCase();
  const pos = lower.lastIndexOf('1');
  if (pos < 1 || pos + 7 > lower.length) throw new Error('bech32: malformed');
  const hrp = lower.slice(0, pos);
  if (expectedHrp && hrp !== expectedHrp) throw new Error(`bech32: expected ${expectedHrp}1..., got ${hrp}1...`);
  const data = [...lower.slice(pos + 1)].map((c) => BECH32_CHARSET.indexOf(c));
  if (data.includes(-1)) throw new Error('bech32: invalid character');
  if (bech32Polymod([...bech32HrpExpand(hrp), ...data]) !== 1) throw new Error('bech32: bad checksum');
  return Buffer.from(convertBits(data.slice(0, -6), 5, 8, false));
}

const npubEncode = (pubHex) => bech32Encode('npub', Buffer.from(pubHex, 'hex'));
const noteEncode = (idHex) => bech32Encode('note', Buffer.from(idHex, 'hex'));

// ---------- secp256k1 + BIP340 Schnorr (BigInt, affine, zero deps) ----------

const SECP_P = 2n ** 256n - 2n ** 32n - 977n;
const SECP_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
const G = {
  x: 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n,
  y: 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n,
};

const mod = (a, m) => ((a % m) + m) % m;

// Modular inverse via the extended Euclidean algorithm.
function modInv(a, m) {
  let [r0, r1] = [mod(a, m), m];
  let [s0, s1] = [1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1] = [r1, r0 - q * r1];
    [s0, s1] = [s1, s0 - q * s1];
  }
  if (r0 !== 1n) throw new Error('secp256k1: no modular inverse');
  return mod(s0, m);
}

function powMod(base, exp, m) {
  let r = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

// Affine point arithmetic; null is the point at infinity.
function pointDouble(P) {
  if (!P) return null;
  if (P.y === 0n) return null;
  const l = mod(3n * P.x * P.x * modInv(2n * P.y, SECP_P), SECP_P);
  const x = mod(l * l - 2n * P.x, SECP_P);
  return { x, y: mod(l * (P.x - x) - P.y, SECP_P) };
}

function pointAdd(P, Q) {
  if (!P) return Q;
  if (!Q) return P;
  if (P.x === Q.x) {
    if (mod(P.y + Q.y, SECP_P) === 0n) return null;
    return pointDouble(P);
  }
  const l = mod((Q.y - P.y) * modInv(Q.x - P.x, SECP_P), SECP_P);
  const x = mod(l * l - P.x - Q.x, SECP_P);
  return { x, y: mod(l * (P.x - x) - P.y, SECP_P) };
}

// Double-and-add scalar multiplication.
function pointMul(k0, P) {
  let k = mod(k0, SECP_N);
  let R = null;
  let A = P;
  while (k > 0n) {
    if (k & 1n) R = pointAdd(R, A);
    A = pointDouble(A);
    k >>= 1n;
  }
  return R;
}

const bytesToBig = (buf) => BigInt(`0x${Buffer.from(buf).toString('hex').padStart(2, '0')}`);
const bigToBytes32 = (x) => Buffer.from(x.toString(16).padStart(64, '0'), 'hex');

function sha256(...bufs) {
  const h = crypto.createHash('sha256');
  for (const b of bufs) h.update(b);
  return h.digest();
}

// BIP340 tagged hash: sha256(sha256(tag) || sha256(tag) || msg).
function taggedHash(tag, ...msgs) {
  const th = sha256(Buffer.from(tag, 'utf8'));
  return sha256(th, th, ...msgs);
}

// BIP340 x-only pubkey: x(d*G) - parity is normalized inside signing, never here.
function pubkeyBytes(d) {
  return bigToBytes32(pointMul(d, G).x);
}

// BIP340 Schnorr signature. `aux` is normally fresh randomness; the selftest
// passes the official vector's fixed all-zero aux to prove determinism.
function schnorrSign(msg, d0, aux = null) {
  if (d0 <= 0n || d0 >= SECP_N) throw new Error('BIP340: private key out of range');
  const P = pointMul(d0, G);
  const d = (P.y & 1n) === 1n ? SECP_N - d0 : d0; // normalize for an even-Y pubkey
  const pub = bigToBytes32(P.x);
  const t = bigToBytes32(d ^ bytesToBig(taggedHash('BIP0340/aux', aux || crypto.randomBytes(32))));
  const k0 = mod(bytesToBig(taggedHash('BIP0340/nonce', t, pub, msg)), SECP_N);
  if (k0 === 0n) throw new Error('BIP340: zero nonce (retry)');
  const R = pointMul(k0, G);
  const k = (R.y & 1n) === 1n ? SECP_N - k0 : k0; // normalize for an even-Y R
  const e = mod(bytesToBig(taggedHash('BIP0340/challenge', bigToBytes32(R.x), pub, msg)), SECP_N);
  return Buffer.concat([bigToBytes32(R.x), bigToBytes32(mod(k + e * d, SECP_N))]);
}

// lift_x: the curve point with the given x and EVEN y, or null if x is not on the curve.
function liftX(x) {
  if (x <= 0n || x >= SECP_P) return null;
  const c = mod(x * x * x + 7n, SECP_P);
  const y = powMod(c, (SECP_P + 1n) / 4n, SECP_P);
  if (mod(y * y, SECP_P) !== c) return null;
  return { x, y: (y & 1n) === 0n ? y : SECP_P - y };
}

// Standard BIP340 verification (used by the selftest to prove sign() honest).
function schnorrVerify(msg, pub, sig) {
  if (pub.length !== 32 || sig.length !== 64) return false;
  const P = liftX(bytesToBig(pub));
  if (!P) return false;
  const r = bytesToBig(sig.subarray(0, 32));
  const s = bytesToBig(sig.subarray(32));
  if (r >= SECP_P || s >= SECP_N) return false;
  const e = mod(bytesToBig(taggedHash('BIP0340/challenge', sig.subarray(0, 32), pub, msg)), SECP_N);
  const R = pointAdd(pointMul(s, G), pointMul(SECP_N - e, P)); // s*G - e*P
  if (!R) return false;
  if ((R.y & 1n) === 1n) return false;
  return R.x === r;
}

// ---------- key handling ----------

function parsePrivateKey(raw) {
  const v = String(raw || '').trim();
  let bytes;
  if (/^nsec1/i.test(v)) bytes = bech32Decode(v, 'nsec');
  else if (/^[0-9a-f]{64}$/i.test(v)) bytes = Buffer.from(v, 'hex');
  else throw new Error('NOSTR_PRIVATE_KEY must be nsec1... (bech32) or 64-char hex');
  if (bytes.length !== 32) throw new Error(`NOSTR_PRIVATE_KEY decodes to ${bytes.length} bytes (expected 32)`);
  const d = bytesToBig(bytes);
  if (d <= 0n || d >= SECP_N) throw new Error('NOSTR_PRIVATE_KEY is out of the secp256k1 range');
  return { bytes, d };
}

// Derive the { d, pubHex, npub } identity from a raw secret (nsec1... or 64-char
// hex). Pure + exported so a test can build a known keypair without touching the
// env; deriveKeys() is the env-reading wrapper the commands use.
export function keysFromSecret(raw) {
  const { d } = parsePrivateKey(raw);
  const pubHex = pubkeyBytes(d).toString('hex');
  return { d, pubHex, npub: npubEncode(pubHex) };
}

// null when NOSTR_PRIVATE_KEY is unset; throws on a malformed key.
function deriveKeys() {
  const raw = readEnv('NOSTR_PRIVATE_KEY');
  if (!raw) return null;
  return keysFromSecret(raw);
}

// ---------- NIP-01 events + relay protocol ----------

// id = sha256 of the canonical [0, pubkey, created_at, kind, tags, content]
// serialization; sig = BIP340 Schnorr over those 32 bytes (NIP-01).
function buildEvent(keys, kind, tags, content) {
  const createdAt = Math.floor(Date.now() / 1000);
  const idBytes = sha256(Buffer.from(JSON.stringify([0, keys.pubHex, createdAt, kind, tags, content]), 'utf8'));
  const sig = schnorrSign(idBytes, keys.d);
  return { id: idBytes.toString('hex'), pubkey: keys.pubHex, created_at: createdAt, kind, tags, content, sig: sig.toString('hex') };
}

// The NIP-88 poll tag set for a kind-1068 poll event (spec 10). option tags are
// ['option', '<option id>', '<label>'] per NIP-88 - NOT 'poll_option', which is NIP-69
// zap-poll vocabulary. Plus one polltype tag, an endsAt (unix seconds) tag, and one
// relay tag per configured relay so votes are collected where the poll lives. Pure +
// exported so a test asserts the tag shape without a relay round-trip. `nowSec` is
// injectable for a deterministic endsAt in tests.
export function buildPollTags(post, relays, nowSec = Math.floor(Date.now() / 1000)) {
  const endsAt = nowSec + pollDurationMinutes(post) * 60;
  return [
    ...pollOptions(post).map((o, i) => ['option', String(i), o]),
    ['polltype', pollMultiple(post) ? 'multiplechoice' : 'singlechoice'],
    ['endsAt', String(endsAt)],
    ...(relays || []).map((url) => ['relay', url]),
  ];
}

// Spec 18: the NIP-23 tag set for a kind-30023 long-form article. `d` is the STABLE
// parameterized-replaceable identifier (post.blogSlug || post.id) - re-publishing the
// same post reuses it, so relays EDIT the article in place instead of duplicating it.
// title/summary(=excerpt)/published_at describe the article; `image` is present ONLY
// when a header image resolved (a URL, or an uploaded NIP-96 url - never a broken tag);
// one `t` topic tag per hashtag (leading '#' stripped, empties dropped). Pure +
// exported so a test asserts the tag shape without a relay round-trip (mirrors
// buildPollTags). `publishedAtSec` is injectable for a deterministic tag in tests.
export function buildLongformTags(post, imageUrl = null, publishedAtSec = Math.floor(Date.now() / 1000), hashtags = []) {
  return [
    ['d', String(post.blogSlug || post.id)],
    ['title', String(post.title || '')],
    ['summary', String(post.excerpt || '')],
    ['published_at', String(publishedAtSec)],
    ...(imageUrl ? [['image', String(imageUrl)]] : []),
    ...(Array.isArray(hashtags) ? hashtags : [])
      .map((h) => String(h || '').replace(/^#/, '').trim())
      .filter(Boolean)
      .map((h) => ['t', h]),
  ];
}

function relayUrls() {
  const all = (readEnv('NOSTR_RELAYS') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const valid = all.filter((u) => /^wss?:\/\//i.test(u));
  for (const u of all) if (!valid.includes(u)) console.error(`[warn] ignoring non-websocket relay URL: ${u}`);
  return valid;
}

// One relay round-trip: open, run the exchange, ALWAYS close the socket, and
// never hang past RELAY_TIMEOUT_MS whatever the relay does.
function relayExchange(url, { onOpen, onFrame }, timeoutMs = RELAY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(url); } catch (err) { reject(err); return; }
    let settled = false;
    let timer = null;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closed */ }
      if (err) reject(err); else resolve(value);
    };
    timer = setTimeout(() => finish(new Error(`relay timeout after ${timeoutMs / 1000}s`)), timeoutMs);
    ws.addEventListener('open', () => { try { onOpen(ws); } catch (err) { finish(err); } });
    ws.addEventListener('error', (ev) => finish(new Error(`websocket error${ev?.message ? ` - ${ev.message}` : ''}`)));
    ws.addEventListener('close', () => finish(new Error('relay closed the connection')));
    ws.addEventListener('message', (ev) => {
      let frame;
      try { frame = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)); } catch { return; }
      if (!Array.isArray(frame)) return;
      try { onFrame(frame, ws, (value) => finish(null, value), (err) => finish(err)); } catch (err) { finish(err); }
    });
  });
}

// Send ["EVENT", event]; resolves on ["OK", id, true], rejects on ["OK", id, false, reason].
function publishEventToRelay(url, event) {
  return relayExchange(url, {
    onOpen: (ws) => ws.send(JSON.stringify(['EVENT', event])),
    onFrame: (frame, ws, done, fail) => {
      if (frame[0] !== 'OK' || frame[1] !== event.id) return;
      if (frame[2] === true) done(true);
      else fail(new Error(`relay rejected the event: ${frame[3] || 'no reason given'}`));
    },
  });
}

// REQ by event id; resolves with the event (seen before EOSE) or null.
function fetchEventFromRelay(url, id) {
  const subId = `pendpost-${crypto.randomBytes(4).toString('hex')}`;
  let found = null;
  return relayExchange(url, {
    onOpen: (ws) => ws.send(JSON.stringify(['REQ', subId, { ids: [id] }])),
    onFrame: (frame, ws, done) => {
      if (frame[0] === 'EVENT' && frame[1] === subId && frame[2]?.id === id) found = frame[2];
      if (frame[0] === 'EOSE' && frame[1] === subId) {
        try { ws.send(JSON.stringify(['CLOSE', subId])); } catch { /* closing anyway */ }
        done(found);
      }
    },
  });
}

// REQ for every event of the given kinds tagging `eventId` via '#e' (NIP-01
// generic tag filter) - resolves the full list seen before EOSE. Generalizes
// fetchEventFromRelay (which stops at the first match) to collect ALL matches,
// since reaction/zap counts need every event, not just one.
function fetchEventsForNote(url, eventId, kinds) {
  const subId = `pendpost-${crypto.randomBytes(4).toString('hex')}`;
  const events = [];
  return relayExchange(url, {
    onOpen: (ws) => ws.send(JSON.stringify(['REQ', subId, { kinds, '#e': [eventId], limit: 500 }])),
    onFrame: (frame, ws, done) => {
      if (frame[0] === 'EVENT' && frame[1] === subId) events.push(frame[2]);
      if (frame[0] === 'EOSE' && frame[1] === subId) {
        try { ws.send(JSON.stringify(['CLOSE', subId])); } catch { /* closing anyway */ }
        done(events);
      }
    },
  });
}

// Reachability: a relay that answers a tiny REQ (any EVENT or the EOSE) is alive.
// Read-timeout budget (RELAY_READ_TIMEOUT_MS): the health probe fans this out over
// every relay and waits for the slowest, so a dead relay must fail FAST here or it
// can drag the whole probe past its parent budget and mis-report the lane as failed.
function probeRelay(url) {
  const subId = 'pendpost-auth';
  return relayExchange(url, {
    onOpen: (ws) => ws.send(JSON.stringify(['REQ', subId, { kinds: [0], limit: 1 }])),
    onFrame: (frame, ws, done) => {
      if ((frame[0] === 'EVENT' || frame[0] === 'EOSE') && frame[1] === subId) {
        try { ws.send(JSON.stringify(['CLOSE', subId])); } catch { /* closing anyway */ }
        done(true);
      }
    },
  }, RELAY_READ_TIMEOUT_MS);
}

// ---------- plan helpers (same shape as the sibling engines) ----------

function loadPlan(planPath) {
  const abs = path.resolve(planPath);
  return { abs, plan: JSON.parse(fs.readFileSync(abs, 'utf8')) };
}

const ENGINE_OWNED_FIELDS = ['fbPostId', 'fbReelId', 'igMediaId', 'liPostId', 'ytVideoId', 'xPostId', 'tgMessageId', 'dcMessageId', 'redditPostId', 'pinId', 'tiktokVideoId', 'mastodonStatusId', 'wordpressPostId', 'ghostPostId', 'nostrEventId', 'gbpPostId', 'status', 'postedAt', 'attempts', 'publishHold', 'publishRetry', 'externalUrl', 'radarReplyState', 'radarFollowup'];

async function withPlanLock(abs, fn) {
  const lockDir = `${abs}.lock.d`;
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(lockDir); break; } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let ageMs = 0;
      try { ageMs = Date.now() - fs.statSync(lockDir).mtimeMs; } catch { continue; }
      if (ageMs > 15 * 60 * 1000) { try { fs.rmdirSync(lockDir); } catch { /* racing steal */ } continue; }
      if (i >= 5) throw new Error(`plan lock busy: ${lockDir}`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  try { return fn(); } finally { try { fs.rmdirSync(lockDir); } catch { /* released */ } }
}

async function savePlan(abs, plan, touchedIds = null) {
  await withPlanLock(abs, () => {
    let out = plan;
    if (Array.isArray(touchedIds)) {
      try {
        const disk = JSON.parse(fs.readFileSync(abs, 'utf8'));
        for (const id of touchedIds) {
          const mem = (plan.posts || []).find((p) => p.id === id);
          const target = (disk.posts || []).find((p) => p.id === id);
          if (!mem || !target) continue;
          for (const f of ENGINE_OWNED_FIELDS) if (mem[f] !== undefined) target[f] = mem[f];
        }
        out = disk;
      } catch { /* unreadable disk copy - fall back to in-memory plan */ }
    }
    const tmp = `${abs}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`);
    fs.renameSync(tmp, abs);
  });
}

function appendAttempt(post, entry) {
  // Shared recorder (lib/publish-hold.mjs): trims the attempts tail and maintains
  // the publishHold failure cap - the local mirror of the cloud re-fire cap.
  recordAttempt(post, entry);
}

const RUN = { results: [] };
let JSON_MODE = false;
let ACTOR = 'cli';

const isNostr = (post) => (post.platforms || []).includes('nostr');
const isTextPost = (post) => post.type === 'text';
const noteText = (post) => (post.nostrCaption || post.caption || '').trim();

// Public permalink: njump.me resolves a NIP-19 note1... id on any relay set.
function permalinkFor(eventId) {
  return `https://njump.me/${noteEncode(eventId)}`;
}

// Spec 18 (NIP-92): the `imeta` tag that embeds an uploaded media file in a kind-1
// short note. Each field is a space-delimited element ('url <url>' 'm <mime>' ...);
// only the fields the NIP-96 upload actually returned are included (never a broken
// empty field). Pure + exported so a test asserts the tag shape without an upload.
export function buildImetaTag(media = {}) {
  const parts = [`url ${media.url}`];
  if (media.m) parts.push(`m ${media.m}`);
  if (media.dim) parts.push(`dim ${media.dim}`);
  if (media.ox) parts.push(`ox ${media.ox}`);
  return ['imeta', ...parts];
}

// Spec 18 (NIP-23): the FIRST-publish timestamp for `published_at`. NIP-23 defines it
// as when the article was first published, NOT re-stamped on every edit-in-place - so
// reuse the engine-owned first-publish field (post.postedAt) when it exists, else now.
// (created_at stays per-event `now`, which is correct.) Pure + exported for a test.
export function publishedAtSecFor(post, nowMs = Date.now()) {
  const parsed = post && post.postedAt ? Date.parse(post.postedAt) : NaN;
  return Number.isNaN(parsed) ? Math.floor(nowMs / 1000) : Math.floor(parsed / 1000);
}

// Spec 18: build the signed event for a due post, branching on post.type. Pure +
// exported so a test asserts the kind + tag mapping + content for EACH branch without
// a relay round-trip: nostr-longform -> kind 30023 (NIP-23; content = the Markdown
// body, metadata rides buildLongformTags); poll -> kind 1068 (NIP-88, spec 10);
// everything else -> kind 1 (NIP-01 short note). A short note carrying resolved `media`
// (an uploaded NIP-96 file) embeds it via a NIP-92 imeta tag + the URL appended to the
// content; a media-LESS short note is BYTE-IDENTICAL to the pre-spec-18 code (kind-1,
// no tags, bare text - the regression guard) and the kind-1068 poll branch is unchanged.
export function buildNostrEvent(post, { keys, relays = [], imageUrl = null, publishedAt = Math.floor(Date.now() / 1000), media = null } = {}) {
  if (post.type === 'nostr-longform') {
    const hashtags = Array.isArray(post.hashtags) ? post.hashtags : [];
    return buildEvent(keys, 30023, buildLongformTags(post, imageUrl, publishedAt, hashtags), (post.body || '').trim());
  }
  if (isPollPost(post)) {
    return buildEvent(keys, 1068, buildPollTags(post, relays), noteText(post));
  }
  // A media short note (NIP-92): append the URL to the content + carry one imeta tag.
  // ONLY when media actually resolved - a text note with no media stays byte-identical.
  if (media && media.url) {
    const base = noteText(post);
    const content = base ? `${base}\n${media.url}` : media.url;
    return buildEvent(keys, 1, [buildImetaTag(media)], content);
  }
  return buildEvent(keys, 1, [], noteText(post));
}

// Spec 24 (NIP-25): build a signed kind-7 reaction event for a comment/mention as the brand.
// content is '+' for a like, else the emoji glyph (defaulting to '+' if none given). The tags
// carry BOTH ['e', <event-id>] (the reacted-to note) AND ['p', <author-pubkey>] (its author),
// per NIP-25 - the 'p' tag is what routes the reaction back to the author, so it is required.
// Pure + signed + exported so a test asserts the kind/tags/content + a verifiable Schnorr sig
// WITHOUT a relay round-trip (mirrors buildPollTags/buildNostrEvent). nostr react is engine-
// side because signing needs the keypair the zero-dep lib/comments.mjs cannot carry.
export function buildReactionEvent(keys, eventId, authorPubkey, reaction, emoji = '') {
  const content = reaction === 'emoji' ? (String(emoji || '').trim() || '+') : '+';
  return buildEvent(keys, 7, [['e', String(eventId)], ['p', String(authorPubkey)]], content);
}

// Radar reply lane (spec 33 flip): build a signed kind-1 REPLY to an external
// note - NIP-10 marked tags: ['e', <parent-id>, '', 'root'] threads it under the
// parent, ['p', <author-pubkey>] routes it to the author. Pure + signed +
// exported so the proof test asserts kind/tags/content + a verifiable Schnorr
// sig WITHOUT a relay round-trip (mirrors buildReactionEvent above).
export function buildRadarReplyEvent(keys, parentId, authorPubkey, text) {
  return buildEvent(keys, 1, [['e', String(parentId), '', 'root'], ['p', String(authorPubkey)]], String(text));
}

// Map a local render's extension to a media mimetype for the NIP-96 upload part
// (models scripts/reddit-social.mjs mimeForRender; node built-ins only).
function mimeForPath(p) {
  const ext = path.extname(String(p || '')).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.mp4') return 'video/mp4';
  return 'application/octet-stream';
}

// Resolve a post's LOCAL media render to an absolute path. Self-contained (mirrors
// lib/plans.mjs resolveMediaPath's path-wins-then-folder+file anchoring under the
// active root) so the publish hot path stays lib-light; null when nothing resolves.
function resolveLocalMedia(plan, post) {
  // Anchor like the sibling engines' resolveMediaPath (reddit-social.mjs:198): the
  // active root (PENDPOST_ROOT) else the repo root - NEVER process.cwd(), which drifts
  // when the daemon is started from a different working directory.
  const root = process.env.PENDPOST_ROOT ? path.resolve(process.env.PENDPOST_ROOT) : path.resolve(__dirname, '..');
  if (post.path) {
    const abs = path.isAbsolute(post.path) ? post.path : path.resolve(root, post.path);
    if (fs.existsSync(abs)) return abs;
  }
  if (post.file) {
    const rel = path.join(plan.folder || '', post.file);
    const abs = path.isAbsolute(rel) ? rel : path.resolve(root, rel);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

// Spec 18 (Pattern P3/P9): decide how a long-form article's NIP-23 header image
// resolves, WITHOUT any I/O - so a test asserts the branch cheaply:
//   - an already-remote http(s) post.image -> use it directly (no upload).
//   - a LOCAL render + a configured NOSTR_MEDIA_SERVER -> upload it (mode 'upload').
//   - a LOCAL render but NO media server -> degrade text-only (media_not_configured).
//   - nothing -> no image tag, no warning (an image-less article is legitimate).
// The caller NEVER throws on this path: an unset server OR a failed upload both
// degrade to a text-only article with a structured warning row.
export function planArticleImage({ image, localPath, mediaServer } = {}) {
  const url = String(image || '').trim();
  if (/^https?:\/\//i.test(url)) return { mode: 'url', imageUrl: url };
  if (localPath && mediaServer) return { mode: 'upload', localPath };
  if (localPath && !mediaServer) return { mode: 'degrade', warning: 'media_not_configured' };
  return { mode: 'none' };
}

// Spec 18 (NIP-96/98, Pattern P3): upload a LOCAL media render to a NIP-96 file server
// and return { url, m, dim, ox } (only the fields the server reports) - enough for a
// NIP-23 article's `image` tag OR a short note's NIP-92 `imeta` tag (relays carry
// events, not files). THREE steps, node built-ins only (no new dep, §H.4; models
// scripts/reddit-social.mjs leaseAndUpload's hand-built multipart):
//   1. GET <server>/.well-known/nostr/nip96.json -> api_url (the upload endpoint).
//   2. sign a NIP-98 HTTP-auth event (kind 27235, tags u=api_url + method=POST + a
//      `payload` sha256 of the request body per NIP-98 - strict NIP-96 servers MAY 401
//      without it) with the SAME key and send it base64'd in `Authorization: Nostr <...>`.
//   3. multipart/form-data POST the file bytes -> nip94_event.tags -> url/m/dim/ox.
// THROWS on any failure so the caller degrades to a text-only article/note (never fatal).
export async function uploadNostrMedia(keys, localPath, mediaServer) {
  const base = String(mediaServer).replace(/\/+$/, '');
  const discovery = await fetch(`${base}/.well-known/nostr/nip96.json`, { headers: { Accept: 'application/json' } });
  if (!discovery.ok) throw new Error(`NIP-96 discovery failed: HTTP ${discovery.status}`);
  const info = await discovery.json();
  const apiUrl = info?.api_url;
  if (!apiUrl || !/^https?:\/\//i.test(apiUrl)) throw new Error('nip96.json has no absolute api_url');
  // Assemble the multipart body FIRST so the NIP-98 auth event can bind to its sha256.
  const bytes = fs.readFileSync(localPath);
  // Strip quote/CR/LF from the filename so it can never break out of the quoted
  // Content-Disposition filename="..." parameter (multipart header injection).
  const filename = path.basename(localPath).replace(/["\r\n]/g, '');
  const boundary = `----pendpost${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const enc = (s) => Buffer.from(s, 'utf8');
  const body = Buffer.concat([
    enc(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeForPath(filename)}\r\n\r\n`),
    bytes,
    enc(`\r\n--${boundary}--\r\n`),
  ]);
  // NIP-98: a kind-27235 event bound to (u=api_url, method=POST, payload=sha256(body)),
  // base64'd in the header. The payload tag lets a strict NIP-96 server verify the body.
  const auth = buildEvent(keys, 27235, [['u', apiUrl], ['method', 'POST'], ['payload', sha256(body).toString('hex')]], '');
  const authHeader = `Nostr ${Buffer.from(JSON.stringify(auth), 'utf8').toString('base64')}`;
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { Authorization: authHeader, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`NIP-96 upload failed: HTTP ${res.status} - ${String(text).slice(0, 160)}`);
  let payload;
  try { payload = JSON.parse(text); } catch { throw new Error(`NIP-96 upload returned non-JSON: ${String(text).slice(0, 160)}`); }
  const tags = payload?.nip94_event?.tags;
  const tagVal = (name) => (Array.isArray(tags) ? tags.find((tt) => Array.isArray(tt) && tt[0] === name) : null)?.[1];
  const url = tagVal('url');
  if (!url) throw new Error(`NIP-96 upload returned no url tag: ${String(text).slice(0, 160)}`);
  // m/dim/ox ride the NIP-92 imeta tag when present (mime falls back to the local ext).
  return { url, m: tagVal('m') || mimeForPath(filename), dim: tagVal('dim') || null, ox: tagVal('ox') || null };
}

// ---------- NIP-57 zaps (send) + NIP-47 Nostr Wallet Connect ----------
//
// Spec 20 (value-for-value): the ONLY money path in pendpost. Every primitive is
// reused from above (schnorr sign via buildEvent, relayExchange, bech32, fetch);
// the one addition is NIP-04 encryption for the NWC request/response, done with
// node:crypto AES-256-CBC over the secp256k1 ECDH shared secret. NO new deps (H.4).
//
// MONEY-PATH SAFETY: a wallet is paid EXACTLY ONCE per zap - there is NO retry
// anywhere on this path, so a timeout/reject can never double-charge. `not_configured`
// (scope nwc) is returned when NOSTR_NWC_URI is unset, and every failure degrades to a
// structured ok:false row - the caller never sees a throw and nothing is re-attempted.

// NIP-04 shared secret: the 32-byte X coordinate of privD * pubPoint(pubHex). The
// nostr pubkey is x-only, so lift it to an even-Y point first. Used as the raw
// AES-256 key (NIP-04 does NOT hash the shared X).
function nip04SharedKey(privD, pubHex) {
  const P = liftX(BigInt(`0x${pubHex}`));
  if (!P) throw new Error('NWC: invalid counterparty pubkey (not on the curve)');
  return bigToBytes32(pointMul(privD, P).x);
}
// NIP-04 ciphertext = base64(AES-256-CBC(plaintext)) + '?iv=' + base64(iv).
function nip04Encrypt(privD, pubHex, plaintext) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', nip04SharedKey(privD, pubHex), iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return `${enc.toString('base64')}?iv=${iv.toString('base64')}`;
}
function nip04Decrypt(privD, pubHex, payload) {
  const [ct, ivPart] = String(payload).split('?iv=');
  if (!ct || !ivPart) throw new Error('NWC: malformed NIP-04 payload (no ?iv=)');
  const decipher = crypto.createDecipheriv('aes-256-cbc', nip04SharedKey(privD, pubHex), Buffer.from(ivPart, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}

// Parse a NIP-47 connection URI: nostr+walletconnect://<wallet-pubkey-hex>?relay=<wss>&secret=<hex>.
// Throws on a malformed/incomplete URI (the caller maps it to an honest failure, never a crash).
// Exported so a test asserts the parse without a live wallet. The secret is a CLIENT SECRET
// (client .env) - never logged, never returned to any envelope.
export function parseNwcUri(uri) {
  const m = String(uri || '').trim().match(/^nostr\+walletconnect:\/\/([0-9a-f]{64})\?(.+)$/i);
  if (!m) throw new Error('NOSTR_NWC_URI is malformed (expected nostr+walletconnect://<pubkey>?relay=..&secret=..)');
  const walletPubkey = m[1].toLowerCase();
  const params = new URLSearchParams(m[2]);
  const relay = params.get('relay');
  const secret = params.get('secret');
  if (!relay || !/^wss?:\/\//i.test(relay)) throw new Error('NOSTR_NWC_URI carries no valid relay= wss:// URL');
  if (!secret || !/^[0-9a-f]{64}$/i.test(secret)) throw new Error('NOSTR_NWC_URI carries no valid 32-byte secret=');
  return { walletPubkey, relay, secret };
}

// NWC responses may take longer than a normal relay REQ (a real Lightning payment
// settles over seconds), so this exchange is given a wider ceiling than RELAY_TIMEOUT_MS.
const NWC_TIMEOUT_MS = 30 * 1000;

// The LNURL callback is an ARBITRARY url from the recipient's profile - both LNURL
// fetches (pay params + invoice) get a hard AbortSignal ceiling so a hostile/slow
// server can never hang unbounded and consume the whole zap budget, pushing the child
// past its parent execFile timeout (the timeout-mid-payment double-charge trap this
// review closes).
const LNURL_TIMEOUT_MS = 15 * 1000;

// The engine's own pre-pay budget. lib/writes.mjs gives the child a WIDER execFile
// timeout (ZAP_TIMEOUT_MS) so the engine ALWAYS returns a structured result before the
// parent SIGTERMs it. Before publishing the pay request we require at least the NWC
// wait plus a margin to remain, so we never publish-then-get-killed mid-await. The
// budget is overridable DOWNWARD only (a test can force insufficient_time; an operator
// can never widen it past the default and weaken the guard vs the outer timeout).
const ZAP_ENGINE_BUDGET_DEFAULT_MS = 90 * 1000;
const ZAP_PREPAY_SAFETY_MS = 5 * 1000;
function zapEngineBudgetMs() {
  const override = Number(process.env.PENDPOST_ZAP_BUDGET_MS);
  return Number.isFinite(override) && override >= 0 && override < ZAP_ENGINE_BUDGET_DEFAULT_MS
    ? override
    : ZAP_ENGINE_BUDGET_DEFAULT_MS;
}

// A structured, CODED failure (err.code set) so cmdZap maps it to a precise row
// errorCode (amount_mismatch | unverified_event | insufficient_time | payment_status_unknown)
// instead of a flat engine_failure - the money path must tell the operator EXACTLY why,
// and payment_status_unknown must NOT be retried blindly.
const codedError = (message, code) => Object.assign(new Error(message), { code });

// Decode a BOLT11 invoice's human-readable-part amount to MILLISATS. The hrp is
// `ln<currency><amount><multiplier>` (e.g. lnbc210n, lntb1u); the amount is a decimal
// number and the OPTIONAL multiplier is one of m(1e-3)/u(1e-6)/n(1e-9)/p(1e-12) BTC.
// 1 BTC = 1e11 msat, so: none->*1e11, m->*1e8, u->*1e5, n->*1e2, p->/10 (a pico amount
// must be a multiple of 10 to be msat-representable). Returns a BigInt msat, or null
// when the hrp carries NO amount (an amountless invoice cannot be verified). Pure +
// exported so a test drives the decode + the mismatch guard without a live server.
export function bolt11AmountMsat(invoice) {
  const s = String(invoice || '').trim().toLowerCase();
  const sep = s.lastIndexOf('1'); // bech32 separator: the data charset excludes '1'
  if (sep < 1) return null;
  const hrp = s.slice(0, sep);
  // bcrt before bc so the longer regtest prefix wins the alternation.
  const m = hrp.match(/^ln(bcrt|bc|tbs|tb|sb)(\d+)?([munp])?$/);
  if (!m) return null;
  const amtStr = m[2];
  const mult = m[3];
  if (!amtStr) return null; // no amount encoded -> unverifiable, reject upstream
  const amt = BigInt(amtStr);
  switch (mult) {
    case 'm': return amt * 100000000n; // 1e8 msat
    case 'u': return amt * 100000n; // 1e5 msat
    case 'n': return amt * 100n; // 1e2 msat
    case 'p': return amt % 10n === 0n ? amt / 10n : null; // sub-msat pico is not representable
    default: return amt * 100000000000n; // no multiplier: BTC -> 1e11 msat
  }
}

// Recompute a relay-returned event's id from its canonical NIP-01 serialization and
// verify its BIP340 signature. On the PAY path we trust NOTHING a relay hands us: a
// rogue relay in NOSTR_RELAYS can return an attacker pubkey under the requested note id,
// or a fabricated kind-0 profile whose lud16 is the attacker's. An event counts ONLY
// when its id is self-consistent (sha256 of [0,pubkey,created_at,kind,tags,content]
// equals the id field) AND its schnorr sig verifies against that pubkey. Exported so a
// test proves a tampered id / bad sig is rejected without a relay round-trip.
export function verifyRelayEvent(ev) {
  try {
    if (!ev || typeof ev !== 'object') return false;
    const { id, pubkey, created_at, kind, tags, content, sig } = ev;
    if (typeof id !== 'string' || !/^[0-9a-f]{64}$/i.test(id)) return false;
    if (typeof pubkey !== 'string' || !/^[0-9a-f]{64}$/i.test(pubkey)) return false;
    if (typeof sig !== 'string' || !/^[0-9a-f]{128}$/i.test(sig)) return false;
    const recomputed = sha256(Buffer.from(JSON.stringify([0, pubkey, created_at, kind, tags, content]), 'utf8')).toString('hex');
    if (recomputed !== id.toLowerCase()) return false;
    return schnorrVerify(Buffer.from(id, 'hex'), Buffer.from(pubkey, 'hex'), Buffer.from(sig, 'hex'));
  } catch { return false; }
}

// Pay a bolt11 invoice over NWC (NIP-47): publish ONE kind-23194 pay_invoice request
// (NIP-04-encrypted to the wallet service) and await the matching kind-23195 response
// on the SAME socket. SINGLE attempt - there is NO retry, so a timeout/reject cannot
// double-charge. Resolves { preimage } or throws (a relay reject, a wallet error, or a
// timeout). Exported so a test proves the single-attempt + response-decrypt path against
// a stubbed relay, with no live wallet.
export async function payInvoiceOverNwc(nwcUri, invoice) {
  const { walletPubkey, relay, secret } = parseNwcUri(nwcUri);
  const clientKeys = keysFromSecret(secret);
  const content = nip04Encrypt(clientKeys.d, walletPubkey, JSON.stringify({ method: 'pay_invoice', params: { invoice } }));
  const request = buildEvent(clientKeys, 23194, [['p', walletPubkey]], content);
  const subId = `pendpost-nwc-${crypto.randomBytes(4).toString('hex')}`;
  // Once the EVENT leaves the socket the wallet MAY settle the invoice - so any later
  // failure (timeout, socket drop, undecryptable response) is status-UNKNOWN, never a
  // clean "did not pay". `published` marks that crossing so the caller can distinguish
  // a safe pre-publish failure from an ambiguous post-publish one (the retry/double-
  // charge boundary). A relay reject or an explicit wallet decline are DEFINITIVE
  // negatives (no payment) and carry their own codes.
  let published = false;
  try {
    return await relayExchange(relay, {
      onOpen: (ws) => {
        // Subscribe for the wallet's response FIRST, then publish the single request.
        ws.send(JSON.stringify(['REQ', subId, { kinds: [23195], authors: [walletPubkey], '#e': [request.id] }]));
        ws.send(JSON.stringify(['EVENT', request]));
        published = true; // the pay request is now on the wire - the wallet may act
      },
      onFrame: (frame, ws, done, fail) => {
        // The relay refused our request event outright: the wallet never saw it, so no
        // payment happened - a DEFINITIVE, safe-to-surface failure.
        if (frame[0] === 'OK' && frame[1] === request.id && frame[2] === false) {
          fail(codedError(`NWC relay rejected the pay request: ${frame[3] || 'no reason given'}`, 'relay_rejected'));
          return;
        }
        if (frame[0] !== 'EVENT' || frame[1] !== subId) return;
        const ev = frame[2];
        if (!ev || ev.kind !== 23195) return;
        if (!Array.isArray(ev.tags) || !ev.tags.some((tt) => tt[0] === 'e' && tt[1] === request.id)) return;
        let payload;
        // A 23195 response DID arrive (the wallet acted on the request) but we could not
        // read it: the payment may well have settled - status UNKNOWN, do not retry.
        try { payload = JSON.parse(nip04Decrypt(clientKeys.d, walletPubkey, ev.content)); }
        catch (err) { fail(codedError(`NWC: could not decrypt the wallet response (${err.message})`, 'payment_status_unknown')); return; }
        if (payload && payload.error) {
          // The wallet explicitly declined: no payment - a DEFINITIVE, safe failure.
          fail(codedError(`wallet declined: ${[payload.error.code, payload.error.message].filter(Boolean).join(' - ') || 'unknown error'}`, 'wallet_declined'));
          return;
        }
        done({ preimage: payload?.result?.preimage || ev.id });
      },
    }, NWC_TIMEOUT_MS);
  } catch (err) {
    // An UNCODED failure after the request was published (timeout / socket drop) is
    // ambiguous: the wallet may have settled it. Tag it so the operator is told to check
    // their wallet rather than blindly retry. A failure BEFORE publish (connect refused)
    // never paid, so it stays a plain engine_failure.
    if (!err.code) err.code = published ? 'payment_status_unknown' : 'engine_failure';
    throw err;
  }
}

// REQ the recipient's kind-0 profile from ONE relay; resolves the first profile
// event seen before EOSE, or null.
function fetchProfileFromRelay(url, pubHex) {
  const subId = `pendpost-${crypto.randomBytes(4).toString('hex')}`;
  let found = null;
  return relayExchange(url, {
    onOpen: (ws) => ws.send(JSON.stringify(['REQ', subId, { kinds: [0], authors: [pubHex], limit: 1 }])),
    onFrame: (frame, ws, done) => {
      if (frame[0] === 'EVENT' && frame[1] === subId && frame[2]?.kind === 0) found = frame[2];
      if (frame[0] === 'EOSE' && frame[1] === subId) {
        try { ws.send(JSON.stringify(['CLOSE', subId])); } catch { /* closing anyway */ }
        done(found);
      }
    },
  });
}

// Turn a profile's lud16 ("name@domain") or lud06 (a bech32 lnurl) into the LNURL
// pay endpoint URL. Returns null when neither is present. Pure - a test can drive it.
export function lnurlFromProfile(meta = {}) {
  const lud16 = String(meta.lud16 || '').trim();
  if (/^[^@\s]+@[^@\s]+$/.test(lud16)) {
    const [name, domain] = lud16.split('@');
    return `https://${domain}/.well-known/lnurlp/${name}`;
  }
  const lud06 = String(meta.lud06 || '').trim();
  if (/^lnurl1/i.test(lud06)) {
    try { return bech32Decode(lud06, 'lnurl').toString('utf8'); } catch { return null; }
  }
  return null;
}

// Resolve the recipient (the note's author): REQ their kind-0 profile across the
// configured relays, derive their LNURL, and fetch the pay params. Requires a
// zap-capable LNURL (allowsNostr:true + a nostrPubkey) per NIP-57. Throws on any
// gap so the caller degrades to a structured ok:false row (never a partial send).
async function resolveRecipientPayParams(relays, recipientPubHex) {
  // A rogue relay can fabricate a kind-0 whose lud16 is the ATTACKER's, redirecting the
  // zap. Accept a profile ONLY when it is genuinely signed by the recipient (verify id
  // + sig) AND authored by exactly recipientPubHex; skip an unverifiable one and try the
  // next relay, so an honest relay can still answer.
  let profile = null;
  for (const url of relays) {
    try {
      const ev = await fetchProfileFromRelay(url, recipientPubHex);
      if (ev && verifyRelayEvent(ev) && ev.pubkey.toLowerCase() === recipientPubHex.toLowerCase()) { profile = ev; break; }
    } catch { /* next relay */ }
  }
  if (!profile) throw codedError('could not fetch a verifiable recipient profile (kind 0) from any relay', 'unverified_event');
  let meta;
  try { meta = JSON.parse(profile.content || '{}'); } catch { meta = {}; }
  const lnurl = lnurlFromProfile(meta);
  if (!lnurl) throw new Error('the recipient has no Lightning address (lud16/lud06) - cannot zap');
  const res = await fetch(lnurl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(LNURL_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`LNURL pay lookup failed: HTTP ${res.status}`);
  const params = await res.json();
  // LUD-06: an error surfaces as { status:"ERROR", reason } at HTTP 200 - surface the
  // reason instead of the generic "not a valid payRequest".
  if (params && params.status === 'ERROR') throw new Error(`LNURL pay error: ${String(params.reason || 'no reason given').slice(0, 160)}`);
  if (params?.tag !== 'payRequest' || !/^https?:\/\//i.test(String(params.callback || ''))) throw new Error('the recipient LNURL is not a valid payRequest');
  if (!params.allowsNostr || !/^[0-9a-f]{64}$/i.test(String(params.nostrPubkey || ''))) throw new Error('the recipient LNURL does not support Nostr zaps (allowsNostr/nostrPubkey missing)');
  return params;
}

// GET the LNURL callback with the amount + the encoded kind-9734 zap request and
// return the bolt11 invoice (NIP-57 step 4). Throws on a missing/failed invoice.
async function fetchZapInvoice(payParams, amountMsat, zapRequest, comment) {
  const url = new URL(payParams.callback);
  url.searchParams.set('amount', String(amountMsat));
  url.searchParams.set('nostr', JSON.stringify(zapRequest));
  // LUD-12: only send a comment when the server DECLARES it accepts one, truncated to
  // the length it allows - sending a comment to a server with no commentAllowed can 400.
  const maxComment = Number(payParams.commentAllowed) || 0;
  if (comment && maxComment > 0) url.searchParams.set('comment', String(comment).slice(0, maxComment));
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(LNURL_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`LNURL invoice request failed: HTTP ${res.status}`);
  const data = await res.json();
  // LUD-06: an error at HTTP 200 ({ status:"ERROR", reason }) - surface the reason.
  if (data && data.status === 'ERROR') throw new Error(`LNURL invoice error: ${String(data.reason || 'no reason given').slice(0, 160)}`);
  const invoice = data?.pr;
  if (!invoice || typeof invoice !== 'string') throw new Error('the LNURL callback returned no bolt11 invoice (pr)');
  return invoice;
}

// ---------- commands ----------

// There is no signup on Nostr - a keypair IS the account. Rejects the (astronomically
// unlikely) out-of-range draws and retries, per the spec for key generation.
async function cmdKeygen(args) {
  let bytes;
  let d;
  do { bytes = crypto.randomBytes(32); d = bytesToBig(bytes); } while (d === 0n || d >= SECP_N);
  const pubHex = pubkeyBytes(d).toString('hex');
  const nsec = bech32Encode('nsec', bytes);
  const npub = npubEncode(pubHex);
  console.log('[ok] minted a fresh Nostr keypair:');
  console.log(`  nsec (SECRET - this IS the account): ${nsec}`);
  console.log(`  npub (public identity):              ${npub}`);
  console.log(`  hex private key:                     ${bytes.toString('hex')}`);
  console.log(`  hex public key:                      ${pubHex}`);
  if (args.save) {
    if (readEnv('NOSTR_PRIVATE_KEY')) {
      console.error('[err] NOSTR_PRIVATE_KEY is already set - refusing to overwrite an existing key. Remove it from .env yourself if you really mean to rotate identities.');
      process.exit(2);
    }
    writeEnv({ NOSTR_PRIVATE_KEY: nsec });
    console.log(`[ok] saved NOSTR_PRIVATE_KEY to ${ENV_PATH} - run 'auth' next to persist the public identity and check relays.`);
  } else {
    console.log('[info] not saved - re-run with --save to persist NOSTR_PRIVATE_KEY (writes only when unset).');
  }
}

async function cmdAuth() {
  requireWebSocket();
  // .env still wins; otherwise, on an interactive terminal, prompt the operator to paste
  // what they copied (the private key hidden, never echoed, never in shell history) and
  // persist it so deriveKeys() below (and every later run) can read it. A non-interactive
  // run (daemon/CI/mock) skips the prompt and fails closed at the guards.
  const privKey = await resolveCredential({
    value: readEnv('NOSTR_PRIVATE_KEY'),
    secret: true,
    hint: 'Paste your Nostr private key (nsec1... or 64-char hex - or mint one with `keygen --save`): ',
  });
  if (!privKey) { console.error('[err] NOSTR_PRIVATE_KEY missing in .env (nsec1... or 64-char hex - mint one with `keygen --save`).'); process.exit(2); }
  writeEnv({ NOSTR_PRIVATE_KEY: privKey });
  const keys = deriveKeys();
  writeEnv({ NOSTR_PUBLIC_KEY: keys.pubHex, NOSTR_NPUB: keys.npub });
  console.log(`[ok] Key valid - identity ${keys.npub} (persisted NOSTR_PUBLIC_KEY + NOSTR_NPUB).`);
  const relaysRaw = await resolveCredential({
    value: readEnv('NOSTR_RELAYS'),
    hint: 'Paste your Nostr relays (comma-separated wss:// relay URLs): ',
  });
  if (relaysRaw) writeEnv({ NOSTR_RELAYS: relaysRaw });
  const relays = relayUrls();
  if (!relays.length) { console.error('[err] NOSTR_RELAYS missing in .env (comma-separated wss:// relay URLs).'); process.exit(2); }
  let reachable = 0;
  for (const url of relays) {
    try {
      await probeRelay(url);
      reachable += 1;
      console.log(`[ok] relay reachable - ${url}`);
    } catch (err) {
      console.log(`[warn] relay unreachable - ${url} (${err.message})`);
    }
  }
  if (!reachable) { console.error(`[err] no configured relay is reachable (0/${relays.length}) - cannot publish.`); process.exit(2); }
  RUN.results.push({ platform: 'nostr', action: 'auth', ok: true, detail: `${keys.npub.slice(0, 13)}... via ${reachable}/${relays.length} relays` });
}

async function cmdRefresh() {
  console.log('[info] Nostr keypairs are static (no refresh).');
}

async function cmdValidate(args) {
  const { plan } = loadPlan(args.plan);
  console.log('================ VALIDATION ONLY - NOTHING WILL BE PUBLISHED ================');
  try {
    const keys = deriveKeys();
    if (keys) console.log(`[ok] Key valid - would publish as ${keys.npub}.`);
    else console.log('[warn] NOSTR_PRIVATE_KEY not set - preview only, publish will need it.');
  } catch (err) {
    console.log(`[warn] key check failed (${err.message}). Continuing to text preview.`);
  }
  const targets = (plan.posts || []).filter((p) => isNostr(p) && (!args.only || p.id === args.only));
  if (!targets.length) { console.log('[warn] No Nostr entries match.'); return; }
  for (const post of targets) {
    const longform = post.type === 'nostr-longform';
    const text = longform ? (post.body || '').trim() : noteText(post);
    console.log(`\n----- ${post.id} -----`);
    console.log(`[preview] type:    ${post.type}`);
    console.log(`[preview] ${longform ? 'article body' : 'text'} (${text.length} chars - relays impose no hard cap):`);
    console.log(text);
    if (longform) console.log(`[preview] would sign a NIP-23 article (kind 30023, d=${post.blogSlug || post.id}) - re-publishing EDITS it in place.`);
    else if (!isTextPost(post)) console.log('[warn] nostr carries no media - this post will publish text only.');
  }
  console.log('\n================ VALIDATION COMPLETE ================');
}

async function cmdPublishDue(args) {
  requireWebSocket();
  const { abs, plan } = loadPlan(args.plan);
  const keys = deriveKeys();
  if (!keys) throw new Error('NOSTR_PRIVATE_KEY is not set - cannot publish.');
  const relays = relayUrls();
  if (!relays.length) throw new Error('NOSTR_RELAYS is not set - cannot publish.');
  const now = Date.now();
  let published = 0;

  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (!isNostr(post)) continue;
    if (post.executionMode !== 'fully-scheduled') continue;
    if (post.status !== 'planned') continue;
    // Publish hold (lib/publish-hold.mjs): the failure cap is spent - never re-fire on
    // its own. Backstop for direct CLI runs; the scheduler's lanesOwed already drops a
    // held post from the fire loop. Reschedule or edit clears the hold.
    if (post.publishHold) {
      console.log(`[skip] ${post.id}: publish hold after repeated failures (${post.publishHold.code ?? post.publishHold.message ?? 'unknown'}) - reschedule or edit the post to retry.`);
      continue;
    }
    if ((post.approval || 'draft') !== 'approved') {
      console.log(`[skip] ${post.id}: approval is "${post.approval || 'draft'}" - only approved posts publish.`);
      continue;
    }
    const dueMs = Date.parse(post.scheduledAt);
    if (Number.isNaN(dueMs) || dueMs > now) continue;

    const longform = post.type === 'nostr-longform';
    const pollPost = isPollPost(post);
    // The content: a long-form article's Markdown body (NIP-23), else the note/poll
    // text (nostrCaption/caption). Fail-closed BEFORE signing - an empty article/note
    // is [warn]-skipped, never signed as an empty event.
    const text = longform ? (post.body || '').trim() : noteText(post);
    if (!text) { console.log(`[warn] ${post.id}: due but no ${longform ? 'article body (body)' : (pollPost ? 'poll question (nostrCaption/caption)' : 'text (nostrCaption/caption)')} - skipping.`); continue; }
    // Spec 10: a NIP-88 poll event (kind 1068). The question is the caption; the
    // choices/duration ride the poll object. Fail-closed BEFORE signing/publishing.
    if (pollPost) {
      const blocker = pollBlocker(post, text, POLL_LANE_LIMITS.nostr);
      if (blocker) {
        console.log(`[warn] ${post.id}: ${blocker} - skipping.`);
        RUN.results.push(pollBlockRow(post, 'nostr', blocker));
        continue;
      }
    }
    // Spec 18: resolve media - a long-form article's NIP-23 header image OR a short
    // note's NIP-92 imeta embed. A remote post.image is used as-is; a LOCAL render is
    // uploaded via NIP-96; anything else degrades honestly (P9). NEVER throws and NEVER
    // performs a remote upload under --dry-run (every sibling gates before any network
    // call): an unset server, a failed upload, or an unresolvable render each publish
    // text-only with a structured warning row (media_not_configured | upload_failed |
    // media_missing), never a crash and never a silent image-less publish.
    const dryRun = Boolean(args['dry-run']);
    const mediaServer = readEnv('NOSTR_MEDIA_SERVER');
    const localMedia = resolveLocalMedia(plan, post);
    const mediaReferenced = Boolean(post.path || post.file); // a render was asked for
    let articleImageUrl = null; // longform: the NIP-23 image tag URL
    let noteMedia = null;       // short note: { url, m, dim, ox } for the NIP-92 imeta tag
    let mediaWarning = null;
    if (longform) {
      const decision = planArticleImage({ image: post.image, localPath: localMedia, mediaServer });
      if (decision.mode === 'url') articleImageUrl = decision.imageUrl;
      else if (decision.mode === 'degrade') mediaWarning = decision.warning; // media_not_configured (server unset)
      else if (decision.mode === 'upload') {
        if (!dryRun) {
          try {
            const up = await uploadNostrMedia(keys, decision.localPath, mediaServer);
            articleImageUrl = up.url;
            console.log(`[ok] ${post.id}: uploaded the header image via NIP-96 - ${up.url}`);
          } catch (err) {
            console.error(`[warn] ${post.id}: NIP-96 media upload failed (${err.message}) - publishing the article text-only`);
            mediaWarning = 'upload_failed'; // server IS set but the upload failed (distinct from unset)
          }
        }
      } else if (mediaReferenced) {
        // mode 'none' but a render was referenced -> it did not resolve on disk. Warn,
        // never silently publish an image-less article.
        mediaWarning = 'media_missing';
      }
    } else if (isTextPost(post)) {
      // A media-bearing SHORT note (NIP-92): upload the local image + embed it via imeta.
      if (localMedia && mediaServer) {
        if (!dryRun) {
          try {
            noteMedia = await uploadNostrMedia(keys, localMedia, mediaServer);
            console.log(`[ok] ${post.id}: uploaded the note image via NIP-96 - ${noteMedia.url}`);
          } catch (err) {
            console.error(`[warn] ${post.id}: NIP-96 media upload failed (${err.message}) - publishing the note text-only`);
            mediaWarning = 'upload_failed';
          }
        }
      } else if (localMedia && !mediaServer) {
        mediaWarning = 'media_not_configured'; // a resolvable image but no server to host it
      } else if (mediaReferenced && !localMedia) {
        mediaWarning = 'media_missing'; // a render was referenced but did not resolve
      }
    } else if (!pollPost) {
      console.log(`[warn] ${post.id}: nostr carries no media - publishing text only`);
    }

    if (dryRun) {
      // NO network call here (the upload above is gated on !dryRun) - a pure preview.
      if (longform) console.log(`[dry] ${post.id}: would sign a NIP-23 article (kind 30023, d=${post.blogSlug || post.id}${articleImageUrl ? ', +image' : (localMedia && mediaServer ? ', would upload image' : '')}) and fan it out to ${relays.length} relay(s).`);
      else if (pollPost) console.log(`[dry] ${post.id}: would sign a NIP-88 poll event (kind 1068, ${pollOptions(post).length} options) and fan it out to ${relays.length} relay(s).`);
      else if (isTextPost(post) && localMedia && mediaServer) console.log(`[dry] ${post.id}: would upload ${path.basename(localMedia)} via NIP-96 and sign a kind-1 note (${text.length} chars) with a NIP-92 imeta tag, fanned out to ${relays.length} relay(s).`);
      else console.log(`[dry] ${post.id}: would sign a kind-1 note (${text.length} chars) and fan it out to ${relays.length} relay(s).`);
      continue;
    }

    console.log(`[info] ${post.id}: publishing ${longform ? 'NIP-23 article (kind 30023)' : (pollPost ? 'NIP-88 poll event (kind 1068)' : 'kind-1 note')} to ${relays.length} relay(s)...`);
    try {
      // Kind selection (30023 article | 1068 poll | 1 note) lives in buildNostrEvent
      // (exported, so a test asserts each branch's kind/tags/content without a relay).
      // published_at reuses the FIRST-publish timestamp (NIP-23) so an edit-in-place
      // re-publish keeps the article's original date; noteMedia rides the NIP-92 imeta tag.
      const event = buildNostrEvent(post, { keys, relays, imageUrl: articleImageUrl, publishedAt: publishedAtSecFor(post, now), media: noteMedia });
      const outcomes = await Promise.allSettled(relays.map((url) => publishEventToRelay(url, event)));
      let accepted = 0;
      outcomes.forEach((o, i) => {
        if (o.status === 'fulfilled') { accepted += 1; console.log(`[ok] ${post.id}: accepted by ${relays[i]}`); }
        else console.log(`[warn] ${post.id}: ${relays[i]} - ${o.reason?.message || o.reason}`);
      });
      // Nostr's delivery model: ONE accepting relay makes the note live.
      if (!accepted) throw new Error(`no relay accepted the event (0/${relays.length})`);

      post.nostrEventId = event.id;
      post.status = 'posted';
      post.postedAt = new Date(now).toISOString();
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'nostr', action: 'publish', ok: true, errorCode: null, errorMessage: null, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'nostr', action: 'publish', ok: true, id: event.id, ...(mediaWarning ? { warning: mediaWarning } : {}) });
      console.log(`[ok] ${post.id}: published on Nostr (${accepted}/${relays.length} relays accepted)${mediaWarning ? ' [text-only: media_not_configured]' : ''} - ${permalinkFor(event.id)}`);
      published += 1;
    } catch (err) {
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'nostr', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300), actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'nostr', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: err.message.slice(0, 300) });
      console.error(`[err] ${post.id}: Nostr publish failed - ${err.message}`);
      continue;
    }
  }
  console.log(`[done] publish-due complete - ${published} note(s) published.`);
}

async function cmdStatus(args) {
  const { plan } = loadPlan(args.plan);
  console.log('[info] Nostr plan entries:');
  for (const post of (plan.posts || []).filter(isNostr)) {
    console.log(`  ${post.id.padEnd(18)} ${String(post.status).padEnd(10)} ${post.scheduledAt}  mode=${post.executionMode}${post.nostrEventId ? ` nostr=${post.nostrEventId}` : ''}`);
  }
}

// Real read-back liveness: REQ the stored event id against the configured relays
// until one returns the event - relays are the source of truth, not our plan file.
async function cmdVerify(args) {
  requireWebSocket();
  const { plan } = loadPlan(args.plan);
  const relays = relayUrls();
  for (const post of (plan.posts || []).filter(isNostr)) {
    if (args.only && post.id !== args.only) continue;
    if (!post.nostrEventId) continue;
    let live = false;
    for (const url of relays) {
      try { if (await fetchEventFromRelay(url, post.nostrEventId)) { live = true; break; } } catch { /* try the next relay */ }
    }
    RUN.results.push({ postId: post.id, platform: 'nostr', action: 'verify', ok: true, live, state: live ? 'published' : 'missing', permalink: live ? permalinkFor(post.nostrEventId) : null, id: post.nostrEventId });
  }
}

// Spec 08 (richer analytics, Pattern P5): relays DO store and forward NIP-25
// kind-7 reactions and NIP-57 kind-9735 zap receipts that tag a note via '#e' -
// this was a no-op only because nothing ever REQ'd them. One combined REQ per
// relay (kinds:[7,9735]) counts both; results are deduped by event id across
// relays (the same reaction/receipt is commonly relayed by more than one). A
// relay that errors or times out contributes zero and is never fatal to the
// row (Promise.allSettled) - reactions/zaps read 0, never a throw. Node < 22
// (no global WebSocket) degrades the same way: empty metrics, not a crash -
// the row still stores so the digest/panel read an honest "0", never a gap.
async function cmdInsights(args) {
  const { plan } = loadPlan(args.plan);
  const targets = (plan.posts || []).filter((p) => isNostr(p) && p.nostrEventId && (!args.only || p.id === args.only));
  if (!targets.length) { console.log('[done] insights complete - no posts with a nostrEventId.'); return; }
  if (typeof WebSocket === 'undefined') {
    for (const post of targets) RUN.results.push({ postId: post.id, platform: 'nostr', action: 'insights', ok: true, id: post.nostrEventId, metrics: { reactions: 0, zaps: 0, zapSats: 0 } });
    console.log('[warn] nostr insights needs Node >= 22 (global WebSocket) - metrics unavailable on this runtime.');
    return;
  }
  const relays = relayUrls();
  for (const post of targets) {
    const metrics = relays.length ? await gatherNoteEngagement(relays, post.nostrEventId) : { reactions: 0, zaps: 0, zapSats: 0 };
    RUN.results.push({ postId: post.id, platform: 'nostr', action: 'insights', ok: true, id: post.nostrEventId, metrics });
    console.log(`[ok] ${post.id}: nostr ${JSON.stringify(metrics)}`);
  }
  console.log(`[done] insights complete - ${RUN.results.filter((r) => r.ok).length} fetched.`);
}

// Gather kind-7 reactions + kind-9735 zap receipts for ONE note across every
// relay, deduped by event id and GUARDED by each event's own tags. Exported so a
// unit test can drive the real REQ/parse/dedupe/count path against a stubbed
// WebSocket (fabricated EVENT/EOSE frames) - the mock driver only supplies canned
// scalar values, never real frames. A relay that errors/times out contributes
// zero (Promise.allSettled), so this never throws past itself.
async function gatherNoteEngagement(relays, noteId) {
  const seen = new Map();
  await Promise.allSettled(relays.map(async (url) => {
    try {
      const events = await fetchEventsForNote(url, noteId, [7, 9735]);
      // Trust nothing but the event's OWN tags: a rogue/buggy relay could return
      // events that do not actually reference this note (ignoring the '#e'
      // filter), inflating the counts. Only keep events that carry an
      // ["e", <noteId>] tag themselves (mirrors fetchEventFromRelay's id check).
      for (const e of events) {
        if (!e?.id) continue;
        if (!Array.isArray(e.tags) || !e.tags.some((t) => t[0] === 'e' && t[1] === noteId)) continue;
        seen.set(e.id, e);
      }
    } catch { /* relay silent/unreachable - contributes zero, never fails the row */ }
  }));
  let reactions = 0;
  let zaps = 0;
  let zapMsat = 0;
  for (const e of seen.values()) {
    if (e.kind === 7) reactions += 1;
    else if (e.kind === 9735) { zaps += 1; zapMsat += zapReceiptMsat(e); }
  }
  // zapSats is the summed value in SATS (NIP-57 amounts are millisats); rounded so
  // a stray sub-sat total never renders a fraction. A receipt with no parseable
  // amount contributes 0 to the sum but is still counted as one zap above.
  return { reactions, zaps, zapSats: Math.round(zapMsat / 1000) };
}

// Spec 20 (NIP-57): a kind-9735 zap RECEIPT embeds the signed kind-9734 zap
// REQUEST as the JSON value of its `description` tag; that request's `amount` tag
// is the zapped value in MILLISATS. Parse it defensively - a receipt with no/
// garbled description, or no amount tag, contributes 0 (never throws, never NaN).
// Exported so a unit test drives the parse without a relay round-trip.
export function zapReceiptMsat(receipt) {
  try {
    const desc = (receipt.tags || []).find((tt) => tt[0] === 'description')?.[1];
    if (!desc) return 0;
    const request = JSON.parse(desc);
    const amountTag = (request.tags || []).find((tt) => tt[0] === 'amount')?.[1];
    const msat = Number(amountTag);
    return Number.isFinite(msat) && msat > 0 ? msat : 0;
  } catch { return 0; }
}

// Spec 20 (NIP-57 send, Pattern P3): zap a published note. Operator-initiated,
// confirm-gated at the tool layer - REAL sats leave the connected Lightning wallet.
// Flow (all with existing primitives): resolve the note's author -> their LNURL pay
// params (require allowsNostr) -> sign a kind-9734 zap request -> fetch a bolt11
// invoice from the LNURL callback -> pay it over NWC (NIP-47) in a SINGLE attempt.
//
// MONEY SAFETY (this review): a wallet is paid EXACTLY ONCE and ONLY for a verified
// recipient at the confirmed amount. Layered guards, each a structured ok:false row -
//   - not_configured (scope nwc): NOSTR_NWC_URI unset OR malformed - the FIRST gate,
//     BEFORE any network side effect (a malformed URI must never mint a live invoice).
//   - unverified_event: the note's author / the recipient profile did not verify (id
//     recompute + schnorr sig) - a rogue relay can NOT redirect the zap.
//   - amount_mismatch: the LNURL-returned bolt11 invoice's amount != the confirmed
//     amount - a hostile LNURL server can NOT make the wallet pay a different number.
//   - insufficient_time: too little budget remains to safely await the wallet response,
//     so we do NOT publish the pay request (the timeout-mid-payment double-charge trap).
//   - payment_status_unknown: the pay request WAS published but no confirmed response
//     arrived - the operator is told to CHECK THEIR WALLET, never to blindly retry.
// Single attempt, no retry anywhere on this path. cmdZap is the thin CLI wrapper; runZap
// is exported so a test drives every guard in-process with stubbed fetch/WebSocket.
async function cmdZap(args) {
  Object.assign(RUN, await runZap(args));
}
export async function runZap(args) {
  const startedAt = Date.now();
  const deadline = startedAt + zapEngineBudgetMs();
  const postId = typeof args.only === 'string' && args.only.trim() ? args.only.trim() : null;
  const row = (extra) => ({ platform: 'nostr', results: [{ postId, platform: 'nostr', action: 'zap', ok: false, ...extra }] });

  // (P9) not_configured is the very first gate: no wallet -> no send, no network, no
  // throw. A PRESENT-but-malformed URI is caught here too (parseNwcUri) so a bad wallet
  // string can never resolve a note / fetch a profile / MINT a live invoice before failing.
  const nwcUri = readEnv('NOSTR_NWC_URI');
  if (!nwcUri) return { ok: false, error: 'not_configured', scope: 'nwc', platform: 'nostr', results: [] };
  try { parseNwcUri(nwcUri); } catch { return { ok: false, error: 'not_configured', scope: 'nwc', platform: 'nostr', results: [] }; }

  // `zap --amount` with NO value parses as boolean true (Number(true)===1) - reject a
  // non-string/non-positive-integer amount rather than silently mint a 1-sat zap.
  const amountSats = typeof args.amount === 'string' || typeof args.amount === 'number' ? Number(args.amount) : NaN;
  if (!Number.isInteger(amountSats) || amountSats <= 0) return { ok: false, error: 'invalid_input', platform: 'nostr', results: [] };

  requireWebSocket();
  const keys = deriveKeys();
  if (!keys) return { ok: false, error: 'needs_scope', scope: null, platform: 'nostr', results: [] };
  const relays = relayUrls();
  if (!relays.length) return { ok: false, error: 'needs_scope', scope: null, platform: 'nostr', results: [] };

  // The target note id: an explicit --id, else the --only post's minted nostrEventId.
  let noteId = typeof args.id === 'string' && args.id.trim() ? args.id.trim() : null;
  if (!noteId && args.plan && postId) {
    try {
      const { plan } = loadPlan(args.plan);
      const post = (plan.posts || []).find((p) => p.id === postId);
      if (post && post.nostrEventId) noteId = post.nostrEventId;
    } catch { /* unreadable plan - handled by the guard below */ }
  }
  if (!noteId) return row({ errorCode: 'engine_failure', errorMessage: 'zap needs a published note (--id <eventId> or --plan --only <postId>)' });

  const comment = typeof args.comment === 'string' ? args.comment.trim() : '';
  const amountMsat = amountSats * 1000;
  try {
    // 1. Resolve the note and VERIFY it (recompute id + schnorr sig): a rogue relay can
    //    return an attacker pubkey under the requested id, redirecting the zap. Skip an
    //    unverifiable event and try the next relay; reject if NONE verify.
    let noteEvent = null;
    for (const url of relays) {
      try {
        const ev = await fetchEventFromRelay(url, noteId);
        if (ev && verifyRelayEvent(ev) && ev.id.toLowerCase() === noteId.toLowerCase()) { noteEvent = ev; break; }
      } catch { /* next relay */ }
    }
    if (!noteEvent) throw codedError(`could not resolve a verifiable note ${noteId} on any relay`, 'unverified_event');
    const recipient = noteEvent.pubkey;
    // 2. The recipient's pay params - the profile is verified inside resolveRecipientPayParams.
    const payParams = await resolveRecipientPayParams(relays, recipient);
    if (Number.isFinite(Number(payParams.minSendable)) && amountMsat < Number(payParams.minSendable)) throw new Error(`amount ${amountMsat} msat is below the recipient minimum (${payParams.minSendable} msat)`);
    if (Number.isFinite(Number(payParams.maxSendable)) && Number(payParams.maxSendable) > 0 && amountMsat > Number(payParams.maxSendable)) throw new Error(`amount ${amountMsat} msat is above the recipient maximum (${payParams.maxSendable} msat)`);
    // 3. Sign a kind-9734 zap request (NIP-57): relays + amount(msat) + p(recipient) + e(note).
    const zapRequest = buildEvent(keys, 9734, [
      ['relays', ...relays],
      ['amount', String(amountMsat)],
      ['p', recipient],
      ['e', noteId],
    ], comment);
    // DEADLINE GUARD (before minting the invoice / publishing the pay request): if too
    // little budget remains to fetch the invoice AND safely await the NWC response, do
    // NOT proceed - a pay request published seconds before the parent SIGTERMs the child
    // would settle while sendZap reports failure, and an operator retry double-charges.
    if (deadline - Date.now() < NWC_TIMEOUT_MS + LNURL_TIMEOUT_MS + ZAP_PREPAY_SAFETY_MS) {
      throw codedError('insufficient time remaining to safely await the wallet response - not publishing the pay request (retry on the next tick)', 'insufficient_time');
    }
    // 4. Fetch the bolt11 invoice, then VERIFY its amount == the confirmed amount BEFORE
    //    paying: a hostile LNURL server could return an invoice for a wildly different
    //    number, and the human confirmed THIS amount, not whatever the server encodes.
    const invoice = await fetchZapInvoice(payParams, amountMsat, zapRequest, comment);
    const invoiceMsat = bolt11AmountMsat(invoice);
    if (invoiceMsat === null || invoiceMsat !== BigInt(amountMsat)) {
      throw codedError(`the invoice amount (${invoiceMsat === null ? 'unspecified' : `${invoiceMsat} msat`}) does not match the confirmed ${amountMsat} msat - refusing to pay`, 'amount_mismatch');
    }
    // NIP-57 residual: the invoice's description-hash (h) SHOULD commit to the kind-9734
    // request JSON. Decoding bolt11 tagged fields is out of scope here; the amount match
    // + verified recipient + single-attempt pay are the load-bearing money guards.
    // 5. Pay it over NWC - the ONE and ONLY pay attempt (no retry, ever).
    const { preimage } = await payInvoiceOverNwc(nwcUri, invoice);
    console.log(`[ok] zapped ${amountSats} sat(s) to note ${noteId} (preimage ${String(preimage).slice(0, 16)}...)`);
    return { platform: 'nostr', results: [{ postId, platform: 'nostr', action: 'zap', ok: true, id: preimage, metrics: { sats: amountSats } }] };
  } catch (err) {
    // A CODED failure carries its precise reason to the row; everything else is a plain
    // engine_failure. payment_status_unknown gets an operator-facing "check your wallet"
    // message so a possibly-settled payment is never blindly retried.
    const errorCode = err.code || 'engine_failure';
    const errorMessage = errorCode === 'payment_status_unknown'
      ? 'payment status unknown - check your wallet before retrying'
      : String(err.message || err).slice(0, 300);
    console.error(`[err] zap failed (${errorCode}) - ${err.message || err}`);
    return row({ errorCode, errorMessage });
  }
}

// NIP-09: a kind-5 event tagging the target id ASKS relays to drop it. Best-effort
// by design - relays MAY honor the request, nothing in the protocol forces them to.
async function cmdDelete(args) {
  if (!args.id) { console.error('[err] delete requires --id <eventId>'); process.exit(2); }
  requireWebSocket();
  const keys = deriveKeys();
  if (!keys) { console.error('[err] NOSTR_PRIVATE_KEY missing in .env - cannot sign a deletion event.'); process.exit(2); }
  const relays = relayUrls();
  if (!relays.length) { console.error('[err] NOSTR_RELAYS missing in .env - nowhere to send the deletion.'); process.exit(2); }
  const event = buildEvent(keys, 5, [['e', String(args.id)]], '');
  const outcomes = await Promise.allSettled(relays.map((url) => publishEventToRelay(url, event)));
  let accepted = 0;
  outcomes.forEach((o, i) => {
    if (o.status === 'fulfilled') { accepted += 1; console.log(`[ok] deletion accepted by ${relays[i]}`); }
    else console.log(`[warn] ${relays[i]} - ${o.reason?.message || o.reason}`);
  });
  if (!accepted) throw new Error(`no relay accepted the deletion event (0/${relays.length})`);
  RUN.results.push({ platform: 'nostr', action: 'delete', ok: true, id: String(args.id) });
  console.log(`[ok] published a NIP-09 deletion for event ${args.id} (${accepted}/${relays.length} relays) - relays MAY still ignore it.`);
}

async function cmdProbe() {
  if (!readEnv('NOSTR_PRIVATE_KEY')) {
    RUN.results.push({ platform: 'nostr', action: 'probe', ok: false, detail: 'not configured (NOSTR_PRIVATE_KEY missing)' });
    return;
  }
  requireWebSocket();
  try {
    const keys = deriveKeys();
    const relays = relayUrls();
    if (!relays.length) {
      RUN.results.push({ platform: 'nostr', action: 'probe', ok: false, detail: 'not configured (NOSTR_RELAYS missing)' });
      return;
    }
    const outcomes = await Promise.allSettled(relays.map((url) => probeRelay(url)));
    const reachable = outcomes.filter((o) => o.status === 'fulfilled').length;
    if (reachable) RUN.results.push({ platform: 'nostr', action: 'probe', ok: true, detail: `connected as ${keys.npub.slice(0, 13)}... via ${reachable}/${relays.length} relays`, tokenExpiresAt: null });
    else RUN.results.push({ platform: 'nostr', action: 'probe', ok: false, detail: `no relay reachable (0/${relays.length})` });
  } catch (err) {
    RUN.results.push({ platform: 'nostr', action: 'probe', ok: false, detail: String(err.message || err).slice(0, 200) });
  }
}

// ---------- profile editing (spec 28 - the shipped X `profile` pattern, cloned) ----------
//
// Nostr's kind-0 metadata event IS the account-wide profile document (NIP-01): a
// REPLACEABLE event, so publishing a new one REPLACES the whole content object on
// relays. Editing only ONE field (e.g. --about) must therefore GET-merge-PUT: fetch
// the CURRENT kind-0 from every relay (fetchProfileFromRelay, already used by the
// zap LNURL lookup), verify each candidate (verifyRelayEvent + pubkey match, spec 28
// review MAJOR-2) and pick the max-created_at survivor (MAJOR-3), merge the touched
// field(s) on top, then sign+publish - never clobber the fields the operator did NOT
// touch, and never trust an unverified/stale relay answer. The wrong-account guard is
// TRIVIAL here (spec §4): the sealed NOSTR_PRIVATE_KEY IS the identity - there is no
// live "authenticated as" call to mismatch against, so this can never edit a sibling
// client's account by construction (a different key signs a DIFFERENT pubkey's kind-0,
// never this one's).
async function cmdProfile(args) {
  const keys = deriveKeys();
  if (!keys) {
    RUN.results.push({ platform: 'nostr', action: args.probe ? 'profile-probe' : 'profile-update', ok: false, error: 'needs_scope', scope: null, detail: 'not configured (NOSTR_PRIVATE_KEY missing)' });
    return;
  }

  // --probe: non-mutating access-tier check. Nostr has no OAuth scope concept (a
  // signed event either reaches a relay or it does not) - the "tier" is trivially
  // 'permitted' once a valid key is configured; report the identity, mutate nothing.
  if (args.probe) {
    RUN.results.push({ platform: 'nostr', action: 'profile-probe', ok: true, tier: 'permitted', pubkey: keys.pubHex, npub: keys.npub, detail: `identity ${keys.npub.slice(0, 13)}...` });
    return;
  }

  const name = typeof args.name === 'string' ? args.name : null;
  const about = typeof args.about === 'string' ? args.about : null;
  const picture = typeof args.picture === 'string' ? args.picture : null;
  const nip05 = typeof args.nip05 === 'string' ? args.nip05 : null;
  const website = typeof args.website === 'string' ? args.website : null;
  if (name == null && about == null && picture == null && nip05 == null && website == null) {
    throw new Error('nothing to update - pass at least one of --name --about --picture --nip05 --website (or --probe).');
  }

  const relays = relayUrls();
  if (!relays.length) {
    RUN.results.push({ platform: 'nostr', action: 'profile-update', ok: false, error: 'needs_scope', scope: null, detail: 'not configured (NOSTR_RELAYS missing)' });
    return;
  }

  if (args['dry-run']) {
    const changes = [];
    if (name != null) changes.push(`name="${name}"`);
    if (about != null) changes.push(`about(${about.length})`);
    if (picture != null) changes.push(`picture="${picture}"`);
    if (nip05 != null) changes.push(`nip05="${nip05}"`);
    if (website != null) changes.push(`website="${website}"`);
    console.error(`[dry] ${keys.npub.slice(0, 13)}...: would update ${changes.join(', ')} (GET-merge-PUT kind-0).`);
    RUN.results.push({ platform: 'nostr', action: 'profile-dry-run', ok: true, pubkey: keys.pubHex, changes });
    return;
  }

  requireWebSocket();
  // GET: fetch the CURRENT kind-0 from EVERY configured relay (not just the first to
  // answer) and merge onto the VERIFIED event with the MAX created_at - a stale relay
  // must never resurrect old values over a genuinely newer edit (spec 28 review,
  // MAJOR-3). Every candidate is verified EXACTLY like the zap path (verifyRelayEvent
  // recompute-id + schnorr check, AND pubkey === keys.pubHex) before it is ever
  // trusted - a rogue relay's fabricated kind-0 (injecting its own lud16/website etc,
  // which would otherwise get SIGNED under the owner's key and republished) is
  // rejected outright, never merged (spec 28 review, MAJOR-2). A relay that genuinely
  // has no prior kind-0 (answers with EOSE, no event) is NOT the same as a relay that
  // FAILED to answer at all (timeout/network error) - only relays that actually
  // answered count toward "no prior profile exists", which legitimately starts a
  // fresh identity ({}). If EVERY relay query failed outright, ABORT rather than
  // publish a kind-0 built from {} - that would clobber the network-wide picture/
  // nip05/lud16 the operator never touched.
  let answered = 0;
  let bestVerified = null; // the max-created_at VERIFIED event seen so far
  const getOutcomes = await Promise.allSettled(relays.map((url) => fetchProfileFromRelay(url, keys.pubHex)));
  for (const outcome of getOutcomes) {
    if (outcome.status !== 'fulfilled') continue; // this relay failed to answer at all
    answered += 1;
    const ev = outcome.value;
    if (!ev) continue; // this relay answered honestly: no kind-0 for this pubkey yet
    if (!verifyRelayEvent(ev) || String(ev.pubkey || '').toLowerCase() !== keys.pubHex.toLowerCase()) continue; // reject an unverifiable/wrong-pubkey event
    if (!bestVerified || (Number(ev.created_at) || 0) > (Number(bestVerified.created_at) || 0)) bestVerified = ev;
  }
  if (!answered) {
    RUN.results.push({ platform: 'nostr', action: 'profile-update', ok: false, errorCode: 'profile_fetch_failed', errorMessage: `could not reach any configured relay to read the current kind-0 profile (0/${relays.length} answered) - aborting rather than publish a partial profile that would clobber the existing one` });
    console.error(`[err] profile update: could not fetch the current profile from any relay (0/${relays.length} answered) - aborted.`);
    return;
  }
  let current = {};
  if (bestVerified) { try { current = JSON.parse(bestVerified.content || '{}'); } catch { current = {}; } }
  const merged = { ...current };
  if (name != null) merged.name = name;
  if (about != null) merged.about = about;
  if (picture != null) merged.picture = picture;
  if (nip05 != null) merged.nip05 = nip05;
  if (website != null) merged.website = website;

  const event = buildEvent(keys, 0, [], JSON.stringify(merged));
  const outcomes = await Promise.allSettled(relays.map((url) => publishEventToRelay(url, event)));
  const accepted = outcomes.filter((o) => o.status === 'fulfilled').length;
  if (!accepted) {
    RUN.results.push({ platform: 'nostr', action: 'profile-update', ok: false, errorCode: 'engine_failure', errorMessage: `no relay accepted the profile event (0/${relays.length})` });
    console.error(`[err] profile update: no relay accepted the event (0/${relays.length}).`);
    return;
  }
  RUN.results.push({ platform: 'nostr', action: 'profile-update', ok: true, id: event.id, pubkey: keys.pubHex });
  console.error(`[ok] profile updated (kind-0, ${accepted}/${relays.length} relays accepted).`);
}

// ---------- social-graph verbs (spec 31 - NIP-65 relay list + NIP-51 lists) ----------
//
// Housekeeping account-level actions, not a scheduled publish: no approval fence,
// these never touch buildPublishJob/eligibleDuePosts, so the cloud publish path
// (nostr IS a CLOUD_LANES member for scheduled notes) is entirely unaffected.
// relay-list-set/list-set sign + fan out a REPLACEABLE (10002/10000/10001) or
// PARAMETERIZED-REPLACEABLE (30000) event; list-get REQs the author's own latest
// event of the given kind back from the relays.

const NIP51_LIST_KINDS = [10000, 10001, 30000];
const LIST_GET_KINDS = [...NIP51_LIST_KINDS, 10002]; // + NIP-65 relay list

// REQ the LATEST event of {kind, authors:[pubHex]} from one relay - a plain
// REPLACEABLE kind (10000/10001/10002) has at most one canonical current copy
// per relay, so the first EVENT a relay hands back for this filter is already
// its held copy. kind 30000 is PARAMETERIZED-replaceable instead: a relay may
// hold ONE canonical copy per (pubkey, kind, d-tag) combo, so without a `#d`
// filter it can legitimately return a DIFFERENT client's 30000 set under the
// SAME pubkey+kind (review MAJOR-1) - `extraFilter` lets the caller narrow the
// REQ (e.g. `#d: ['pendpost']`). Resolves null when the relay genuinely has
// none. Generalizes fetchProfileFromRelay (hardcoded to kind 0).
function fetchLatestEventOfKind(url, pubHex, kind, extraFilter = null) {
  const subId = `pendpost-${crypto.randomBytes(4).toString('hex')}`;
  let found = null;
  const filter = { kinds: [kind], authors: [pubHex], limit: 1, ...(extraFilter || {}) };
  return relayExchange(url, {
    onOpen: (ws) => ws.send(JSON.stringify(['REQ', subId, filter])),
    onFrame: (frame, ws, done) => {
      if (frame[0] === 'EVENT' && frame[1] === subId && frame[2]?.kind === kind) found = frame[2];
      if (frame[0] === 'EOSE' && frame[1] === subId) {
        try { ws.send(JSON.stringify(['CLOSE', subId])); } catch { /* closing anyway */ }
        done(found);
      }
    },
  }, RELAY_READ_TIMEOUT_MS);
}

// relay-list-set (spec 31, NIP-65): --relays is a JSON array of [url, marker?]
// pairs (marker is 'read'|'write'|null - null/omitted means both), exactly the
// shape buildEvent(keys, 10002, relays.map(([u,rw]) => rw ? ['r',u,rw] : ['r',u]), '')
// expects.
async function cmdRelayListSet(args) {
  const keys = deriveKeys();
  if (!keys) { RUN.results.push({ platform: 'nostr', action: 'relay-list-set', ok: false, error: 'needs_scope', scope: null }); return; }
  let relays;
  try { relays = JSON.parse(typeof args.relays === 'string' ? args.relays : '[]'); } catch { relays = null; }
  const valid = Array.isArray(relays) && relays.length > 0
    && relays.every((r) => Array.isArray(r) && typeof r[0] === 'string' && /^wss?:\/\//i.test(r[0]) && (r[1] == null || r[1] === 'read' || r[1] === 'write'));
  if (!valid) {
    RUN.results.push({ platform: 'nostr', action: 'relay-list-set', ok: false, error: 'invalid_input', errorMessage: '--relays must be a non-empty JSON array of [wss://url, "read"|"write"|null] pairs' });
    return;
  }
  const configured = relayUrls();
  if (!configured.length) { RUN.results.push({ platform: 'nostr', action: 'relay-list-set', ok: false, error: 'needs_scope', scope: null }); return; }
  requireWebSocket();
  const tags = relays.map(([u, rw]) => (rw ? ['r', u, rw] : ['r', u]));
  const event = buildEvent(keys, 10002, tags, '');
  const outcomes = await Promise.allSettled(configured.map((url) => publishEventToRelay(url, event)));
  const accepted = outcomes.filter((o) => o.status === 'fulfilled').length;
  if (!accepted) {
    RUN.results.push({ platform: 'nostr', action: 'relay-list-set', ok: false, errorCode: 'engine_failure', errorMessage: `no relay accepted the event (0/${configured.length})` });
    console.error(`[err] relay-list-set: no relay accepted the event (0/${configured.length}).`);
    return;
  }
  RUN.results.push({ platform: 'nostr', action: 'relay-list-set', ok: true, id: event.id, count: relays.length });
  console.log(`[ok] relay-list-set: kind-10002 published (${accepted}/${configured.length} relays accepted).`);
}

// list-set (spec 31, NIP-51): --kind <10000 mute|10001 pin|30000 follow-set>
// --items <JSON array of ids>. Canonical NIP-51 tag mapping per kind (review
// MAJOR-2): 10000 (mute) tags MUTED PUBKEYS via 'p' - muting a USER is the
// canonical mute op, NOT muting an event; 10001 (pin) tags PINNED EVENT ids via
// 'e'; 30000 (a member pubkey follow-set) tags MEMBER PUBKEYS via 'p' plus a
// stable 'd' identifier - the parameterized-replaceable marker that makes a
// re-publish EDIT the SAME list in place rather than mint a duplicate under a
// new d value. An optional --tag override (one of e|p|t|word) lets an operator
// mint the rarer kind-10000 event/hashtag/word mute variants NIP-51 also
// defines, but the DEFAULT for 10000 stays 'p' (mute users) - never 'e', which
// would silently replace the operator's real mute list with an ineffective
// event-only one (kind 10000 is REPLACEABLE - one list-set REPLACES it whole).
const LIST_SET_DEFAULT_TAG = { 10000: 'p', 10001: 'e', 30000: 'p' };
const LIST_SET_TAG_OVERRIDES = ['e', 'p', 't', 'word'];
async function cmdListSet(args) {
  const kind = Number(args.kind);
  if (!NIP51_LIST_KINDS.includes(kind)) {
    RUN.results.push({ platform: 'nostr', action: 'list-set', ok: false, error: 'invalid_input', errorMessage: `--kind must be one of ${NIP51_LIST_KINDS.join(',')} (got ${args.kind})` });
    return;
  }
  const keys = deriveKeys();
  if (!keys) { RUN.results.push({ platform: 'nostr', action: 'list-set', ok: false, error: 'needs_scope', scope: null }); return; }
  let items;
  try { items = JSON.parse(typeof args.items === 'string' ? args.items : '[]'); } catch { items = null; }
  if (!Array.isArray(items)) {
    RUN.results.push({ platform: 'nostr', action: 'list-set', ok: false, error: 'invalid_input', errorMessage: '--items must be a JSON array of ids' });
    return;
  }
  let tagLetter = LIST_SET_DEFAULT_TAG[kind];
  if (kind === 10000 && args.tag != null) {
    const override = String(args.tag).trim();
    if (!LIST_SET_TAG_OVERRIDES.includes(override)) {
      RUN.results.push({ platform: 'nostr', action: 'list-set', ok: false, error: 'invalid_input', errorMessage: `--tag must be one of ${LIST_SET_TAG_OVERRIDES.join(',')} (got ${args.tag})` });
      return;
    }
    tagLetter = override;
  }
  const relays = relayUrls();
  if (!relays.length) { RUN.results.push({ platform: 'nostr', action: 'list-set', ok: false, error: 'needs_scope', scope: null }); return; }
  requireWebSocket();
  const tags = items.map((v) => [tagLetter, String(v)]);
  // A single canonical pendpost-managed list per kind - the stable `d` keeps every
  // re-publish a REPLACE, never a new parameterized list under a fresh identifier.
  if (kind === 30000) tags.push(['d', 'pendpost']);
  const event = buildEvent(keys, kind, tags, '');
  const outcomes = await Promise.allSettled(relays.map((url) => publishEventToRelay(url, event)));
  const accepted = outcomes.filter((o) => o.status === 'fulfilled').length;
  if (!accepted) {
    RUN.results.push({ platform: 'nostr', action: 'list-set', ok: false, errorCode: 'engine_failure', errorMessage: `no relay accepted the event (0/${relays.length})` });
    console.error(`[err] list-set: no relay accepted the event (0/${relays.length}).`);
    return;
  }
  RUN.results.push({ platform: 'nostr', action: 'list-set', ok: true, id: event.id, kind, count: items.length });
  console.log(`[ok] list-set: kind-${kind} published (${accepted}/${relays.length} relays accepted).`);
}

// list-get (spec 31, read): REQ the author's LATEST event of --kind (any of
// 10000/10001/30000 NIP-51, or 10002 NIP-65) across every configured relay, keep
// the max-created_at VERIFIED candidate (verifyRelayEvent + pubkey === own key,
// mirrors cmdProfile's GET-merge) - a rogue/lying relay can never inject a
// fabricated list under this pubkey. kind 30000 is PARAMETERIZED-replaceable
// (review MAJOR-1): a relay may hold a DIFFERENT client's 30000 set under the
// SAME pubkey+kind, so the REQ additionally filters `#d: ['pendpost']`, AND
// every candidate is defensively re-checked for a matching `d` tag before it
// can become `best` - a relay that ignores the REQ filter (or a rogue one) can
// never smuggle a wrong-list candidate through. Error-not-empty: a genuine read
// failure (no relay answered at all) is ok:false, never a false-empty
// {ok:true, items:[]} - a relay that DID answer but holds no list of this kind
// yet is a legitimate empty result.
async function cmdListGet(args) {
  const kind = Number(args.kind);
  if (!LIST_GET_KINDS.includes(kind)) {
    RUN.results.push({ platform: 'nostr', action: 'list-get', ok: false, error: 'invalid_input', errorMessage: `kind must be one of ${LIST_GET_KINDS.join(',')} (got ${args.kind})` });
    return;
  }
  const keys = deriveKeys();
  if (!keys) { RUN.results.push({ platform: 'nostr', action: 'list-get', ok: false, error: 'needs_scope', scope: null }); return; }
  const relays = relayUrls();
  if (!relays.length) { RUN.results.push({ platform: 'nostr', action: 'list-get', ok: false, error: 'needs_scope', scope: null }); return; }
  requireWebSocket();
  const extraFilter = kind === 30000 ? { '#d': ['pendpost'] } : null;
  let answered = 0;
  let best = null;
  const outcomes = await Promise.allSettled(relays.map((url) => fetchLatestEventOfKind(url, keys.pubHex, kind, extraFilter)));
  for (const outcome of outcomes) {
    if (outcome.status !== 'fulfilled') continue; // this relay failed to answer at all
    answered += 1;
    const ev = outcome.value;
    if (!ev) continue; // answered honestly: no list of this kind yet
    if (!verifyRelayEvent(ev) || String(ev.pubkey || '').toLowerCase() !== keys.pubHex.toLowerCase()) continue; // reject a fabricated/wrong-pubkey event
    if (kind === 30000) {
      const dTag = Array.isArray(ev.tags) ? ev.tags.find((t) => Array.isArray(t) && t[0] === 'd') : null;
      if (!dTag || dTag[1] !== 'pendpost') continue; // wrong-d candidate: a DIFFERENT client's follow-set under this pubkey - reject
    }
    if (!best || (Number(ev.created_at) || 0) > (Number(best.created_at) || 0)) best = ev;
  }
  if (!answered) {
    RUN.results.push({ platform: 'nostr', action: 'list-get', ok: false, errorCode: 'engine_failure', errorMessage: `could not reach any configured relay (0/${relays.length} answered)` });
    console.error(`[err] list-get: no relay answered (0/${relays.length}).`);
    return;
  }
  RUN.results.push({ platform: 'nostr', action: 'list-get', ok: true, kind, id: best ? best.id : null, items: best ? best.tags : [] });
  console.log(`[ok] list-get: kind-${kind} - ${best ? `${best.tags.length} tag(s)` : 'no list yet'}.`);
}

// Offline proof the in-file crypto is CORRECT before any key touches a relay:
// the official BIP340 vector, 20 random sign/verify rounds, bech32 roundtrips.
async function cmdSelftest() {
  const fail = (msg) => { console.error(`[err] selftest FAILED - ${msg}`); process.exit(1); };

  // (a) BIP340 official test vector 0: seckey 3, aux = msg = 32 zero bytes.
  const EXPECTED_PUB = 'F9308A019258C31049344F85F89D5229B531C845836F99B08601F113BCE036F9';
  const EXPECTED_SIG = 'E907831F80848D1069A5371B402410364BDF1C5F8307B0084C55F1CE2DCA821525F66A4A85EA8B71E482A74F382D2CE5EBEEE8FDB2172F477DF4900D310536C0';
  const zeros = Buffer.alloc(32);
  const pub = pubkeyBytes(3n);
  if (pub.toString('hex').toUpperCase() !== EXPECTED_PUB) fail(`pubkey(3) = ${pub.toString('hex')} (expected ${EXPECTED_PUB})`);
  const sig = schnorrSign(zeros, 3n, zeros);
  if (sig.toString('hex').toUpperCase() !== EXPECTED_SIG) fail(`sign vector mismatch: got ${sig.toString('hex')}`);
  if (!schnorrVerify(zeros, pub, sig)) fail('the official vector signature does not verify');

  // (b) 20 random keys: sign a random message, verify it, and prove a tampered
  // message does NOT verify.
  for (let i = 0; i < 20; i++) {
    let d;
    do { d = bytesToBig(crypto.randomBytes(32)); } while (d === 0n || d >= SECP_N);
    const msg = crypto.randomBytes(32);
    const pubI = pubkeyBytes(d);
    const sigI = schnorrSign(msg, d);
    if (!schnorrVerify(msg, pubI, sigI)) fail(`random sign/verify round ${i} failed`);
    const tampered = Buffer.from(msg);
    tampered[0] ^= 0xff;
    if (schnorrVerify(tampered, pubI, sigI)) fail(`tampered message verified on round ${i}`);
  }

  // (c) bech32 roundtrips: nsec/npub/note all decode back to the exact bytes.
  for (const hrp of ['nsec', 'npub', 'note']) {
    const bytes = crypto.randomBytes(32);
    const encoded = bech32Encode(hrp, bytes);
    if (!encoded.startsWith(`${hrp}1`)) fail(`bech32 ${hrp} prefix mismatch`);
    if (!bech32Decode(encoded, hrp).equals(bytes)) fail(`bech32 ${hrp} roundtrip mismatch`);
  }
  if (!bech32Decode(npubEncode(pub.toString('hex')), 'npub').equals(pub)) fail('npub(vector pubkey) roundtrip mismatch');

  console.log('[ok] selftest passed (BIP340 vector 0 + 20 random sign/verify rounds + bech32 nsec/npub/note roundtrips).');
}

// ---------- main ----------

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else args[key] = argv[++i];
    } else args._.push(a);
  }
  return args;
}

// The inbound-engagement seam (spec 02, Pattern P6): read + reply to inbound
// comments on this lane's own posts. Thin wrappers over the shared, source-agnostic
// REST in lib/comments.mjs (dynamic import so the publish hot path's module graph is
// untouched). The result is merged onto RUN so main() emits the normalized
// { items } / { id } envelope; a needs_scope degrade sets ok:false (P9).
async function cmdComments(args) {
  const { runLaneComments } = await import('../lib/comments.mjs');
  Object.assign(RUN, await runLaneComments('nostr', args));
}
async function cmdReply(args) {
  const { runLaneReply } = await import('../lib/comments.mjs');
  Object.assign(RUN, await runLaneReply('nostr', args));
}
// Spec 24: react to a comment/mention as the brand. UNLIKE the other lanes (whose react rides
// the zero-dep lib/comments.mjs) nostr is KEYPAIR-signed, so this builds+signs+publishes a
// NIP-25 kind-7 reaction event IN THE ENGINE, exactly like cmdPublishDue/cmdReply-would. The
// result object is shaped like the lib's reactOk/needs_scope/unsupported so lib/writes.mjs#
// reactToPost consumes it identically (Object.assign onto RUN -> main() emits { ok, ...RUN }).
async function cmdReact(args) {
  const reaction = typeof args.reaction === 'string' ? args.reaction.trim() : '';
  const targetId = (typeof args['comment-id'] === 'string' && args['comment-id'].trim())
    ? args['comment-id'].trim()
    : (typeof args.id === 'string' && args.id.trim() ? args.id.trim() : '');
  const authorPubkey = typeof args.pubkey === 'string' ? args.pubkey.trim() : '';
  const emoji = typeof args.emoji === 'string' ? args.emoji.trim() : '';
  const removeFlag = args.remove === true || args.remove === 'true';
  const only = typeof args.only === 'string' && args.only.trim() ? args.only.trim() : null;
  const postId = only || (targetId || null);
  const fail = (error, extra = {}) => { Object.assign(RUN, { ok: false, error, platform: 'nostr', results: [], ...extra }); };
  // GUI-honesty: nostr supports exactly like/emoji (mirror COMMENT_CAPABILITIES.nostr.react).
  if (!['like', 'emoji'].includes(reaction)) { fail('unsupported_reaction', { lane: 'nostr' }); return; }
  if (!targetId) { fail('react requires --comment-id <event-id> (or --id)', { code: 'invalid_input' }); return; }
  // The NIP-25 'p' tag needs the reacted-to note's author pubkey (64-char hex). The Studio
  // threads it from the spec-02 read (author = e.pubkey); absent/malformed, degrade to an
  // honest structured non-success rather than sign a malformed event (never a false success).
  if (!/^[0-9a-f]{64}$/i.test(authorPubkey)) { fail('needs_author', { code: 'invalid_input' }); return; }
  // Un-react: NIP-25 has no in-place retraction - it needs a NIP-09 kind-5 deletion of THAT
  // reaction event's id, which the panel does not thread back (it only knows the note id). So
  // un-react degrades honestly rather than fake a removal (a downvote '-' would be a NEW event).
  if (removeFlag) { fail('nostr un-react needs the reaction event id (NIP-09) - not retractable from the note id alone', { code: 'engine_failure' }); return; }
  // Client-signed: nostr has NO OAuth scope. A missing keypair/relays is a real not-configured
  // state, surfaced as needs_scope (scope null - nothing to authorize, just configure the key/relays).
  const keys = deriveKeys();
  if (!keys) { Object.assign(RUN, { ok: false, error: 'needs_scope', scope: null, platform: 'nostr', results: [] }); return; }
  const relays = relayUrls();
  if (!relays.length) { Object.assign(RUN, { ok: false, error: 'needs_scope', scope: null, platform: 'nostr', results: [] }); return; }
  requireWebSocket();
  const event = buildReactionEvent(keys, targetId, authorPubkey, reaction, emoji);
  const outcomes = await Promise.allSettled(relays.map((url) => publishEventToRelay(url, event)));
  const accepted = outcomes.filter((o) => o.status === 'fulfilled').length;
  if (!accepted) { fail(`no relay accepted the reaction (0/${relays.length})`, { code: 'engine_failure' }); return; }
  Object.assign(RUN, { ok: true, id: event.id, platform: 'nostr', results: [{ postId, platform: 'nostr', action: 'react', ok: true, id: event.id, reaction, removed: false }] });
}

// Radar reply-to-external (the spec 33 nostr flip; clones yt-social cmdPublishRadar).
// Nostr's general publish-due is a CLOUD lane and fires OWN notes; a Radar reply is
// a kind-1 with e/p tags answering a STRANGER's note, so it gets its own LOCAL-only
// command, routed via the scheduler's `nostr-reply` lane. It reached here only after
// a DISTINCT human approved it - a radarReplyTo post can never auto-approve
// (lib/auto-approve.mjs), and nostr is absent from RADAR_AUTO_REPLY_LANES by default.
// The parent event is resolved from the configured relays FIRST: that yields the
// author pubkey the NIP-10 'p' tag requires AND proves the target still exists on
// the relays this reply would publish to. Unresolvable => radar_target_gone
// (TERMINAL - lanesFor stops firing the lane); no relay accepting => engine_failure.
async function cmdPublishRadar(args) {
  const { abs, plan } = loadPlan(args.plan);
  const now = Date.now();
  for (const post of plan.posts || []) {
    if (args.only && post.id !== args.only) continue;
    if (!post.radarReplyTo) continue; // this lane fires ONLY Radar replies - never a general note
    const rr = post.radarReplyTo;
    // WRONG-TARGET guard: fire ONLY when the reply's source is this lane (create-time
    // validateFieldValues rejects the mismatch; this is the fire-time backstop).
    if (rr.source !== 'nostr') { RUN.results.push({ postId: post.id, platform: 'nostr', action: 'publish', ok: false, errorCode: 'invalid_input', errorMessage: `radarReplyTo.source '${rr.source}' does not match the nostr lane` }); continue; }
    if (post.executionMode !== 'fully-scheduled') continue;
    if (post.status === 'posted' || post.nostrEventId) continue; // idempotent - a fired reply never re-posts
    if (post.radarReplyState === 'target_gone') continue; // terminal - never re-attempt a dead note
    // Publish hold (lib/publish-hold.mjs): the failure cap is spent - never re-fire on
    // its own. Backstop for direct CLI runs; the scheduler's lanesOwed already drops a
    // held post from the fire loop. Reschedule or edit clears the hold.
    if (post.publishHold) {
      console.log(`[skip] ${post.id}: publish hold after repeated failures (${post.publishHold.code ?? post.publishHold.message ?? 'unknown'}) - reschedule or edit the post to retry.`);
      continue;
    }
    if ((post.approval || 'draft') !== 'approved') { console.log(`[skip] ${post.id}: approval is "${post.approval || 'draft'}" - only approved posts publish.`); continue; }
    const dueMs = Date.parse(post.scheduledAt);
    if (Number.isNaN(dueMs) || dueMs > now) continue;
    const text = String(post.nostrCaption || post.caption || '').trim();
    if (!text) { RUN.results.push({ postId: post.id, platform: 'nostr', action: 'publish', ok: false, errorCode: 'invalid_input', errorMessage: 'radar reply needs note text (nostrCaption or caption)' }); continue; }
    if (args['dry-run']) { console.log(`[dry] ${post.id}: would reply to nostr event ${rr.externalId} (${text.length} chars).`); continue; }
    // Client-signed: nostr has NO OAuth scope - a missing keypair/relays is a real
    // not-configured state (needs_scope, scope null - configure the key/relays).
    const keys = deriveKeys();
    const relays = keys ? relayUrls() : [];
    if (!keys || !relays.length) { RUN.results.push({ postId: post.id, platform: 'nostr', action: 'publish', ok: false, error: 'needs_scope', scope: null, errorMessage: keys ? 'no relays configured (NOSTR_RELAYS)' : 'no signing key configured' }); continue; }
    requireWebSocket();
    let parent = null;
    for (const url of relays) {
      try { parent = await fetchEventFromRelay(url, String(rr.externalId)); if (parent) break; } catch { /* try the next relay */ }
    }
    if (!parent || !/^[0-9a-f]{64}$/i.test(String(parent.pubkey || ''))) {
      post.radarReplyState = 'target_gone';
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'nostr', action: 'publish', ok: false, errorCode: 'radar_target_gone', errorMessage: 'parent event not found on any configured relay - cannot thread the reply', actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'nostr', action: 'publish', ok: false, errorCode: 'radar_target_gone', errorMessage: `parent event ${rr.externalId} not found on any configured relay (deleted, or never on these relays) - reply cannot thread` });
      continue;
    }
    try {
      const event = buildRadarReplyEvent(keys, rr.externalId, parent.pubkey, text);
      const outcomes = await Promise.allSettled(relays.map((url) => publishEventToRelay(url, event)));
      const accepted = outcomes.filter((o) => o.status === 'fulfilled').length;
      if (!accepted) throw new Error(`no relay accepted the reply (0/${relays.length})`);
      post.nostrEventId = event.id;
      // The reply's public address (njump) - persisted so the Radar card's
      // "Beantwortet" links the ANSWER, not the question (no bech32 in lib).
      post.externalUrl = permalinkFor(event.id);
      post.status = 'posted';
      post.postedAt = new Date(now).toISOString();
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'nostr', action: 'publish', ok: true, errorCode: null, errorMessage: null, actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'nostr', action: 'publish', ok: true, id: event.id, radarReply: rr.externalId, relaysAccepted: accepted });
      console.log(`[ok] ${post.id}: replied to nostr event ${rr.externalId} (${event.id}, ${accepted}/${relays.length} relays).`);
    } catch (err) {
      appendAttempt(post, { ts: new Date().toISOString(), platform: 'nostr', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: String(err.message || err).slice(0, 300), actor: ACTOR });
      await savePlan(abs, plan, [post.id]);
      RUN.results.push({ postId: post.id, platform: 'nostr', action: 'publish', ok: false, errorCode: 'engine_failure', errorMessage: String(err.message || err).slice(0, 300) });
      console.error(`[err] ${post.id}: nostr radar reply failed - ${err.message}`);
    }
  }
}

const COMMANDS = {
  keygen: cmdKeygen,
  auth: cmdAuth,
  connect: cmdAuth,
  comments: cmdComments,
  reply: cmdReply,
  react: cmdReact,
  refresh: cmdRefresh,
  validate: cmdValidate,
  'publish-due': cmdPublishDue,
  status: cmdStatus,
  verify: cmdVerify,
  insights: cmdInsights,
  zap: cmdZap,
  delete: cmdDelete,
  probe: cmdProbe,
  profile: cmdProfile,
  selftest: cmdSelftest,
  // Social-graph housekeeping (spec 31): NIP-65 relay list + NIP-51 mute/pin/
  // follow-set lists. None takes --plan.
  'relay-list-set': cmdRelayListSet,
  'list-set': cmdListSet,
  'list-get': cmdListGet,
  // Radar reply lane (spec 33 flip) - fired by the scheduler's LOCAL-only
  // `nostr-reply` lane, never the cloud.
  'publish-radar': cmdPublishRadar,
};

async function main() {
  const args = parseArgs(process.argv);
  await enforceCeremonyClient({ argv: args, command: args._[0], lane: 'nostr', scriptUrl: import.meta.url });
  JSON_MODE = Boolean(args.json);
  ACTOR = typeof args.actor === 'string' ? args.actor : 'cli';
  if (JSON_MODE) console.log = (...a) => console.error(...a);
  const commandName = args._[0];
  if (resolveMode('nostr') === 'mock' && isMockableCommand(commandName)) {
    const envelope = await runMockCommand({
      platform: 'nostr', command: commandName,
      planPath: typeof args.plan === 'string' ? path.resolve(String(args.plan)) : null,
      only: typeof args.only === 'string' ? args.only : null,
      // spec 24: the react verb carries its reaction/emoji/remove so the mock can branch per-lane.
      reaction: typeof args.reaction === 'string' ? args.reaction : null,
      emoji: typeof args.emoji === 'string' ? args.emoji : null,
      remove: args.remove === true,
      // spec 20: the mock `zap` needs the amount to echo + whether a wallet is
      // configured (so it can return not_configured without ever touching a wallet).
      amount: args.amount != null ? Number(args.amount) : null,
      nwcConfigured: Boolean(readEnv('NOSTR_NWC_URI')),
      // spec 28 review: the profile verb's --probe flag, so mock mode can
      // distinguish a probe (read-only tier check) from an apply.
      probe: args.probe === true,
      // spec 31: relay-list-set's --relays (JSON), list-set/list-get's --kind + list-set's --items (JSON).
      relays: typeof args.relays === 'string' ? args.relays : null,
      kind: args.kind != null ? Number(args.kind) : null,
      items: typeof args.items === 'string' ? args.items : null,
    });
    if (JSON_MODE) process.stdout.write(`${JSON.stringify(envelope)}\n`);
    else console.error(`[mock] nostr ${commandName}: ${envelope.results.length} result(s)`);
    return;
  }
  const cmd = COMMANDS[commandName];
  if (!cmd) {
    console.error(`Usage: node scripts/nostr-social.mjs <${Object.keys(COMMANDS).join('|')}> [options]`);
    process.exit(2);
  }
  if (['validate', 'publish-due', 'status', 'verify', 'insights'].includes(commandName) && !args.plan) {
    console.error(`[err] ${commandName} requires --plan <post-plan.json>`);
    process.exit(2);
  }
  await cmd(args);
  if (JSON_MODE) process.stdout.write(`${JSON.stringify({ ok: true, ...RUN })}\n`);
}

// CLI entry - only when executed directly, never when imported (unit tests reach
// gatherNoteEngagement this way). Mirrors scripts/pinterest-social.mjs's guard.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(async (err) => {
    console.error('[err]', err.message || err);
    if (JSON_MODE) process.stdout.write(`${JSON.stringify({ ok: false, error: String(err.message || err).slice(0, 300), ...RUN })}\n`);
    process.exit(1);
  });
}

// Test-only export (spec 08): gatherNoteEngagement is the real REQ/dedupe/e-tag/
// count path for one note - a unit test drives it against a stubbed global
// WebSocket that emits fabricated EVENT/EOSE frames, so the parse + dedup + tag
// guard + kind count are covered without a live relay or the mock driver.
// schnorrVerify (spec 24): the BIP340 verifier lets the reactions test PROVE a
// buildReactionEvent kind-7 is genuinely signed (sig verifies against the pubkey),
// not just shaped - without a relay round-trip.
// Spec 20 (nostr zaps): the NIP-04 encrypt/decrypt seam is exported so a unit test
// proves the AES-256-CBC-over-ECDH roundtrip AND can fabricate a wallet's kind-23195
// response for the payInvoiceOverNwc single-attempt test - with no live wallet/relay.
// buildEvent (spec 20 review): a test builds a GENUINELY-signed note / kind-0 profile so
// verifyRelayEvent's id-recompute + sig-verify pass path is exercised, and the runZap
// guards (amount_mismatch, unverified_event, insufficient_time) run in-process against
// stubbed fetch/WebSocket without a live relay, wallet, or a single real sat spent.
// Spec 28: cmdProfile + RUN + fetchProfileFromRelay are exported so a profile-edit test
// can drive the real probe/GET-merge-PUT/apply logic in-process against a stubbed
// global.WebSocket, with no live relay/network/subprocess.
// Spec 31: cmdRelayListSet/cmdListSet/cmdListGet are exported the SAME way so
// test/social-graph.test.mjs drives the real relay fan-out / kind-routing / verify-
// before-parse logic in-process against a stubbed global.WebSocket, with no live
// relay/network/subprocess.
export {
  gatherNoteEngagement, schnorrVerify, nip04Encrypt, nip04Decrypt, buildEvent,
  cmdProfile, RUN, fetchProfileFromRelay,
  cmdRelayListSet, cmdListSet, cmdListGet,
};
