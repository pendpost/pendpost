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
 * PUBLISH - every due entry becomes ONE signed kind-1 text note (NIP-01), fanned
 * out to EVERY configured relay; the post counts as published when at least ONE
 * relay replies ["OK", <id>, true] - that is Nostr's delivery model (redundancy
 * over guarantees, per-relay acceptance is advisory). Media is NOT supported:
 * relays carry events, not files, so a media post honestly publishes its text
 * only (logged as a warning, never silently). Text comes from post.nostrCaption
 * (falls back to post.caption), the additive per-platform override pattern x
 * uses for xCaption; relays impose no hard length cap.
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
 *   status           --plan <p>                 list Nostr plan entries
 *   verify           --plan <p> [--only <id>]   read-only liveness (REQ by event id)
 *   insights         --plan <p> [--only <id>]   no-op (relays expose no per-post metrics)
 *   probe                                        read-only health probe
 *   delete           --id <eventId>              publish a NIP-09 deletion request
 *   selftest                                     offline crypto self-check (BIP340 + bech32)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveMode, isMockableCommand } from '../lib/mode.mjs';
import { runMockCommand } from '../lib/drivers/mock-driver.mjs';
import { envPath } from '../lib/util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = envPath();

// Every relay exchange (EVENT publish, REQ read-back, reachability probe) is
// wrapped in a promise with this timeout - a dead relay must never hang a tick.
const RELAY_TIMEOUT_MS = 10 * 1000;

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

// null when NOSTR_PRIVATE_KEY is unset; throws on a malformed key.
function deriveKeys() {
  const raw = readEnv('NOSTR_PRIVATE_KEY');
  if (!raw) return null;
  const { d } = parsePrivateKey(raw);
  const pubHex = pubkeyBytes(d).toString('hex');
  return { d, pubHex, npub: npubEncode(pubHex) };
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

// Reachability: a relay that answers a tiny REQ (any EVENT or the EOSE) is alive.
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
  });
}

// ---------- plan helpers (same shape as the sibling engines) ----------

function loadPlan(planPath) {
  const abs = path.resolve(planPath);
  return { abs, plan: JSON.parse(fs.readFileSync(abs, 'utf8')) };
}

const ENGINE_OWNED_FIELDS = ['fbPostId', 'fbReelId', 'igMediaId', 'liPostId', 'ytVideoId', 'xPostId', 'tgMessageId', 'dcMessageId', 'redditPostId', 'pinId', 'tiktokVideoId', 'mastodonStatusId', 'wordpressPostId', 'ghostPostId', 'nostrEventId', 'gbpPostId', 'status', 'postedAt', 'attempts'];

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
  post.attempts = Array.isArray(post.attempts) ? post.attempts : [];
  post.attempts.push(entry);
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
  if (!readEnv('NOSTR_PRIVATE_KEY')) { console.error('[err] NOSTR_PRIVATE_KEY missing in .env (nsec1... or 64-char hex - mint one with `keygen --save`).'); process.exit(2); }
  const keys = deriveKeys();
  writeEnv({ NOSTR_PUBLIC_KEY: keys.pubHex, NOSTR_NPUB: keys.npub });
  console.log(`[ok] Key valid - identity ${keys.npub} (persisted NOSTR_PUBLIC_KEY + NOSTR_NPUB).`);
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
    const text = noteText(post);
    console.log(`\n----- ${post.id} -----`);
    console.log(`[preview] type:    ${post.type}`);
    console.log(`[preview] text (${text.length} chars - relays impose no hard cap):`);
    console.log(text);
    if (!isTextPost(post)) console.log('[warn] nostr carries no media - this post will publish text only.');
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
    if ((post.approval || 'draft') !== 'approved') {
      console.log(`[skip] ${post.id}: approval is "${post.approval || 'draft'}" - only approved posts publish.`);
      continue;
    }
    const dueMs = Date.parse(post.scheduledAt);
    if (Number.isNaN(dueMs) || dueMs > now) continue;

    const text = noteText(post);
    if (!text) { console.log(`[warn] ${post.id}: due but no text (nostrCaption/caption) - skipping.`); continue; }
    if (!isTextPost(post)) console.log(`[warn] ${post.id}: nostr carries no media - publishing text only`);

    if (args['dry-run']) {
      console.log(`[dry] ${post.id}: would sign a kind-1 note (${text.length} chars) and fan it out to ${relays.length} relay(s).`);
      continue;
    }

    console.log(`[info] ${post.id}: publishing kind-1 note to ${relays.length} relay(s)...`);
    try {
      const event = buildEvent(keys, 1, [], text);
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
      RUN.results.push({ postId: post.id, platform: 'nostr', action: 'publish', ok: true, id: event.id });
      console.log(`[ok] ${post.id}: published on Nostr (${accepted}/${relays.length} relays accepted) - ${permalinkFor(event.id)}`);
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

// Relays store and forward events; they expose no view/reaction counters - honest no-op.
async function cmdInsights(args) {
  const { plan } = loadPlan(args.plan);
  void plan;
  console.log('[info] nostr relays expose no per-post metrics - insights is a no-op.');
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

const COMMANDS = {
  keygen: cmdKeygen,
  auth: cmdAuth,
  connect: cmdAuth,
  refresh: cmdRefresh,
  validate: cmdValidate,
  'publish-due': cmdPublishDue,
  status: cmdStatus,
  verify: cmdVerify,
  insights: cmdInsights,
  delete: cmdDelete,
  probe: cmdProbe,
  selftest: cmdSelftest,
};

async function main() {
  const args = parseArgs(process.argv);
  JSON_MODE = Boolean(args.json);
  ACTOR = typeof args.actor === 'string' ? args.actor : 'cli';
  if (JSON_MODE) console.log = (...a) => console.error(...a);
  const commandName = args._[0];
  if (resolveMode('nostr') === 'mock' && isMockableCommand(commandName)) {
    const envelope = await runMockCommand({
      platform: 'nostr', command: commandName,
      planPath: typeof args.plan === 'string' ? path.resolve(String(args.plan)) : null,
      only: typeof args.only === 'string' ? args.only : null,
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

main().catch(async (err) => {
  console.error('[err]', err.message || err);
  if (JSON_MODE) process.stdout.write(`${JSON.stringify({ ok: false, error: String(err.message || err).slice(0, 300), ...RUN })}\n`);
  process.exit(1);
});
