// lib/attest.mjs - spec 51 (v1: single keypair, owner decision 2026-09-09). A PURE
// ed25519 layer plus a per-client SINGLE signing keypair. NO key ring, NO rotate, NO
// retired-key tracking (D1): rotation is a deferred future enhancement, non-breaking
// because every statement embeds its own `pub`.
//
// Zero new dependency: node:crypto ed25519 only. The key file lives at
// activeRoot()/attest-key.json, beside .env and state.json, OUTSIDE data/ (so the
// /media streamer can never reach it), mode 0600 via a tmp+rename (the writeEnvVars
// idiom in lib/util.mjs - atomicWriteJson sets no mode and must NOT be used here).
//
// A statement's canonical form is a FIXED, versioned field list per kind (R1): fixed
// order, missing values normalised to null, no free numbers except the integer `v`.
// The signer refuses any key outside the list and any non-scalar value (the receipt's
// `outcome` is the one nested object, itself a fixed list), so determinism rests on
// ECMAScript JSON.stringify string escaping alone. A domain-separation prefix binds a
// signature to its kind and to this protocol.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { activeRoot } from './context.mjs';
import { logLine } from './util.mjs';

const DOMAIN = 'pendpost-attest/1';
// The 12-byte SPKI/DER prefix for a raw ed25519 public key (RFC 8410).
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

// The fixed field list per statement kind, in signing order. Copied VERBATIM from
// spec 51 §4.2; do not reorder (the order is part of the wire contract). No mediaSha256
// in v1 (D3): media PATHS are already inside contentSha256 via POST_CONTENT_FIELDS.
const FIELDS = {
  authorization: ['v', 'kind', 'clientId', 'campaign', 'postId', 'platform', 'lane', 'account', 'approvedBy', 'approvedAt', 'approvedHash', 'finalParamsHash', 'contentSha256', 'firedAt'],
  receipt: ['v', 'kind', 'clientId', 'campaign', 'postId', 'platform', 'authSig', 'outcome', 'recordedAt'],
};
const OUTCOME_FIELDS = ['ok', 'platformId', 'errorCode'];

function invalid(message) {
  return Object.assign(new Error(message), { code: 'invalid_input' });
}

function keyFilePath() {
  return path.join(activeRoot(), 'attest-key.json');
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function rawPublicBytes(keyObject) {
  const der = keyObject.export({ format: 'der', type: 'spki' });
  return der.subarray(der.length - 32);
}

function publicKeyFromRaw(rawPub) {
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(rawPub)]), format: 'der', type: 'spki' });
}

function canonicalOutcome(outcome) {
  if (outcome === null) return null;
  if (typeof outcome !== 'object' || Array.isArray(outcome)) throw invalid('outcome must be an object or null');
  for (const k of Object.keys(outcome)) if (!OUTCOME_FIELDS.includes(k)) throw invalid(`unknown outcome field: ${k}`);
  const o = {};
  for (const k of OUTCOME_FIELDS) {
    const v = outcome[k] === undefined ? null : outcome[k];
    if (k === 'ok') { if (typeof v !== 'boolean') throw invalid('outcome.ok must be a boolean'); o.ok = v; }
    else { if (v !== null && typeof v !== 'string') throw invalid(`outcome.${k} must be a string or null`); o[k] = v; }
  }
  return o;
}

export function canonicalBytes(kind, payload) {
  const fields = FIELDS[kind];
  if (!fields) throw invalid(`unknown statement kind: ${kind}`);
  for (const k of Object.keys(payload)) if (!fields.includes(k)) throw invalid(`unknown field in ${kind} payload: ${k}`);
  const ordered = {};
  for (const k of fields) {
    const v = payload[k] === undefined ? null : payload[k];
    if (k === 'outcome') { ordered.outcome = canonicalOutcome(v); continue; }
    if (k === 'v') { if (!Number.isInteger(v)) throw invalid('v must be an integer'); ordered.v = v; continue; }
    if (v !== null && typeof v !== 'string' && typeof v !== 'boolean') throw invalid(`field ${k} must be string, boolean or null`);
    ordered[k] = v;
  }
  return Buffer.from(`${DOMAIN}\n${kind}\n${JSON.stringify(ordered)}`, 'utf8');
}

// --- single keypair (v1, D1: no ring) -------------------------------------
function readKey() {
  const p = keyFilePath();
  if (!fs.existsSync(p)) return null;
  try {
    const mode = fs.statSync(p).mode & 0o777;
    if (mode !== 0o600) { fs.chmodSync(p, 0o600); logLine('warn', `[attest] re-applied 0600 to ${p} (was 0${mode.toString(8)})`); }
  } catch { /* stat/chmod best-effort; the read below is the real gate */ }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeKey(entry) {
  const p = keyFilePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, p);
}

function newKeyEntry() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const rawPub = rawPublicBytes(publicKey);
  return {
    v: 1,
    kid: crypto.createHash('sha256').update(rawPub).digest('hex').slice(0, 16),
    alg: 'ed25519',
    pub: b64url(rawPub),
    privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    createdAt: new Date().toISOString(),
  };
}

// Reads the key file exactly once per call, creating it on first use. Every public
// entry point below (ensureSigningKey, getPublicKey, signStatement) calls this ONE
// time instead of each doing its own readFileSync+JSON.parse (+ statSync/chmod) pass.
function ensureKeyEntry() {
  try {
    let entry = readKey();
    if (!entry || !entry.kid || !entry.privateKey) {
      entry = newKeyEntry();
      writeKey(entry);
    }
    return entry;
  } catch (err) {
    throw Object.assign(new Error(`attest key unavailable: ${err.message}`), { code: 'engine_failure' });
  }
}

export function ensureSigningKey() {
  const entry = ensureKeyEntry();
  return { kid: entry.kid, pub: entry.pub };
}

export function getPublicKey() {
  const entry = ensureKeyEntry();
  return { kid: entry.kid, pub: entry.pub, createdAt: entry.createdAt };
}

// 'active' when kid matches the current key file, else 'unknown'. No 'retired' state in
// v1: a foreign kid (a rotated-away or someone-else's key) is simply 'unknown'.
// NOTE: the same caution applies to a statement's embedded `kid` (see verifyStatement
// below): it is informational only, never itself a basis for a trust decision.
export function keyStatus(kid) {
  const e = readKey();
  if (!e) return 'unknown';
  return e.kid === kid ? 'active' : 'unknown';
}

export function signStatement(kind, payload) {
  const entry = ensureKeyEntry();
  const msg = canonicalBytes(kind, payload);
  const sig = crypto.sign(null, msg, crypto.createPrivateKey(entry.privateKey));
  return { v: 1, alg: 'ed25519', kid: entry.kid, pub: entry.pub, payload, sig: b64url(sig) };
}

// Never throws on malformed input: returns { ok, reason? }. `pub` overrides the
// embedded key so an external verifier can check against an out-of-band anchor.
// Note: verification here checks the signature against `pub` (or the embedded
// `signed.pub`), never against `signed.kid`. The `kid` field is informational only
// and is not itself authenticated by the signature's math; a caller making a trust
// decision must recompute kid from `signed.pub` (or pass `{ pub }` explicitly), not
// read it off the statement at face value.
export function verifyStatement(signed, { pub } = {}) {
  try {
    if (!signed || typeof signed !== 'object' || !signed.payload || typeof signed.payload !== 'object') return { ok: false, reason: 'malformed' };
    if (signed.v !== 1) return { ok: false, reason: 'unsupported_version' };
    if (signed.alg !== 'ed25519') return { ok: false, reason: 'unsupported_version' };
    const kind = signed.payload.kind;
    if (!FIELDS[kind]) return { ok: false, reason: 'unknown_kind' };
    for (const k of Object.keys(signed.payload)) if (!FIELDS[kind].includes(k)) return { ok: false, reason: 'extra_keys' };
    let msg;
    try { msg = canonicalBytes(kind, signed.payload); } catch { return { ok: false, reason: 'malformed' }; }
    const rawPub = Buffer.from(pub || signed.pub || '', 'base64url');
    if (rawPub.length !== 32) return { ok: false, reason: 'malformed' };
    const sig = Buffer.from(signed.sig || '', 'base64url');
    if (sig.length !== 64) return { ok: false, reason: 'malformed' };
    return crypto.verify(null, msg, publicKeyFromRaw(rawPub), sig) ? { ok: true } : { ok: false, reason: 'bad_signature' };
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}
