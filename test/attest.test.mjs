#!/usr/bin/env node
// test/attest.test.mjs - spec 51 pure crypto + SINGLE keypair (v1, D1: no ring, no
// rotate). Fresh temp PENDPOST_ROOT set BEFORE importing lib, zero-dep node:assert.
// No engines, no network.
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-attest-'));
process.env.PENDPOST_ROOT = WS;

const {
  ensureSigningKey, getPublicKey, keyStatus,
  canonicalBytes, signStatement, verifyStatement,
} = await import('../lib/attest.mjs');

// Authorization payload: 14 fields in v1 (no mediaSha256, D3).
const AUTH = {
  v: 1, kind: 'authorization', clientId: 'acme', campaign: 'c1', postId: 'p1',
  platform: 'x', lane: 'x', account: '12345', approvedBy: 'owner',
  approvedAt: '2026-09-09T00:00:00.000Z', approvedHash: 'abc123def456',
  finalParamsHash: 'abc123def456', contentSha256: 'f'.repeat(64),
  firedAt: '2026-09-09T00:01:00.000Z',
};
const RECEIPT = {
  v: 1, kind: 'receipt', clientId: 'acme', campaign: 'c1', postId: 'p1', platform: 'x',
  authSig: 'sig-of-auth', outcome: { ok: true, platformId: '99', errorCode: null },
  recordedAt: '2026-09-09T00:01:02.000Z',
};

try {
  // keygen idempotence + 0600 + exactly one keypair (no ring).
  const k1 = ensureSigningKey();
  const k2 = ensureSigningKey();
  ok(k1.kid === k2.kid, 'two ensureSigningKey() calls return the same kid');
  const keyFile = path.join(WS, 'attest-key.json');
  ok((fs.statSync(keyFile).mode & 0o777) === 0o600, 'the key file is mode 0600');
  const stored = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  ok(!Array.isArray(stored.keys) && stored.kid === k1.kid && stored.privateKey, 'the key file holds one flat keypair, no ring');
  ok(keyStatus(k1.kid) === 'active', 'the current kid reports active');
  ok(keyStatus('deadbeefdeadbeef') === 'unknown', 'a foreign kid reports unknown (no retired state in v1)');

  // canonical stability: key insertion order does not matter.
  const shuffled = {}; for (const key of Object.keys(AUTH).reverse()) shuffled[key] = AUTH[key];
  ok(canonicalBytes('authorization', AUTH).equals(canonicalBytes('authorization', shuffled)),
    'canonicalBytes is independent of the payload key order');
  // a missing optional field and an explicit null yield identical bytes.
  const withNull = { ...AUTH, account: null };
  const withMissing = { ...AUTH }; delete withMissing.account;
  ok(canonicalBytes('authorization', withNull).equals(canonicalBytes('authorization', withMissing)),
    'a missing field and an explicit null canonicalize identically');
  // a unicode approver string round-trips through canonical + verify.
  const uni = { ...AUTH, approvedBy: 'reviewer:acme/martina-über' };
  ok(canonicalBytes('authorization', uni).length > 0, 'a unicode approver canonicalizes');
  // an extra key throws invalid_input.
  assert.throws(() => canonicalBytes('authorization', { ...AUTH, bogus: 'x' }), (e) => e.code === 'invalid_input',
    'an unknown key throws invalid_input');
  ok(true, 'an unknown key throws invalid_input');
  // a nested object outside outcome throws.
  assert.throws(() => canonicalBytes('authorization', { ...AUTH, account: { nested: 1 } }), (e) => e.code === 'invalid_input',
    'a non-scalar value throws invalid_input');
  ok(true, 'a non-scalar value throws invalid_input');

  // sign -> verify round-trip, both kinds.
  const sa = signStatement('authorization', AUTH);
  const sr = signStatement('receipt', RECEIPT);
  ok(verifyStatement(sa).ok, 'authorization signs and verifies');
  ok(verifyStatement(sr).ok, 'receipt signs and verifies');
  // kid == first 16 hex of sha256(raw pub); pub rebuilds a key that verifies.
  const rawPub = Buffer.from(sa.pub, 'base64url');
  ok(sa.kid === crypto.createHash('sha256').update(rawPub).digest('hex').slice(0, 16), 'kid = first 16 hex of sha256(raw pub)');
  ok(verifyStatement(sa, { pub: sa.pub }).ok, 'the embedded pub rebuilds a verifying key');
  ok(getPublicKey().kid === sa.kid, 'getPublicKey() returns the signing kid');

  // tamper detection.
  const t1 = structuredClone(sr); t1.payload.outcome.platformId = '100';
  ok(verifyStatement(t1).reason === 'bad_signature', 'flipping outcome.platformId => bad_signature');
  // Flip a byte early in the raw signature (not the trailing byte: ed25519's S scalar
  // is < L (~2^252.38), so the LAST byte's top bits are always zero, which starves the
  // base64 tail characters of entropy and made a naive string-splice mutation collide
  // with the original ~25-30% of the time -- flaky by construction. XOR-flipping byte 0
  // guarantees an actual change with no such edge case.
  const t2 = structuredClone(sr);
  const flippedSig = Buffer.from(sr.sig, 'base64url'); flippedSig[0] ^= 0xff;
  t2.sig = flippedSig.toString('base64url');
  ok(verifyStatement(t2).ok === false, 'flipping sig => not ok');
  const t3 = structuredClone(sr); t3.payload.bogus = 'x';
  ok(verifyStatement(t3).reason === 'extra_keys', 'an extra key in the stored payload => extra_keys');

  // wrong key.
  const otherPub = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
  ok(verifyStatement(sa, { pub: otherPub }).reason === 'bad_signature', 'verifying with the wrong pub => bad_signature');

  // domain separation: a statement's bytes carry the kind, so relabeling kind fails.
  const relabel = structuredClone(sa); relabel.payload.kind = 'receipt';
  ok(verifyStatement(relabel).ok === false, 'a statement relabeled to another kind does not verify');
  ok(canonicalBytes('authorization', AUTH).subarray(0, 26).toString() === 'pendpost-attest/1\nauthoriz',
    'canonical bytes carry the domain-separation prefix');

  console.log(`[attest] OK - keygen, single keypair, canonical stability, sign/verify, tamper (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
