#!/usr/bin/env node
// test/attest-cli.test.mjs - spec 51 Task 7: scripts/attest.mjs `pubkey` | `verify`.
//
// Spawns the REAL CLI (child_process) against a throwaway PENDPOST_ROOT so exit
// codes and stdout are genuinely exercised end to end, the same idiom as
// test/cli-client-target.test.mjs. The campaign/post fixture is built IN-PROCESS
// with the test/receipts.test.mjs harness (createCampaign/createPost/approvePost +
// runDueExclusive in mock mode) because the CLI itself never fires a post - it only
// reads what a prior fire already wrote to the plan file the CLI then verifies.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'scripts', 'attest.mjs');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-attest-cli-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';

fs.mkdirSync(path.join(WS, 'data', 'plans'), { recursive: true });
fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [] }, null, 2));

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, PENDPOST_ROOT: WS, PENDPOST_MODE: 'mock' },
  });
}

try {
  // ===== node --check sanity ================================================
  const chk = spawnSync(process.execPath, ['--check', CLI], { encoding: 'utf8' });
  ok(chk.status === 0, `node --check scripts/attest.mjs is silent (status ${chk.status}; stderr: ${(chk.stderr || '').trim()})`);

  // ===== usage / unknown subcommand =========================================
  const noArgs = run([]);
  ok(noArgs.status !== 0, 'no subcommand exits non-zero');
  ok(/[Uu]sage/.test(noArgs.stderr || ''), 'no subcommand prints usage');

  const badVerb = run(['rotate']);
  ok(badVerb.status !== 0, "unknown subcommand ('rotate', no such verb in v1) exits non-zero");
  ok(/[Uu]sage/.test(badVerb.stderr || ''), 'unknown subcommand prints usage');

  const help = run(['--help']);
  ok(help.status === 0, '--help exits 0');
  ok(/pubkey/.test(help.stderr || '') && /verify/.test(help.stderr || ''), '--help lists both subcommands');

  // ===== pubkey --json =======================================================
  const pk = run(['pubkey', '--json']);
  ok(pk.status === 0, `pubkey --json exits 0 (stderr: ${(pk.stderr || '').trim()})`);
  const pkBody = JSON.parse(pk.stdout);
  ok(pkBody.ok === true, 'pubkey --json prints ok:true');
  ok(typeof pkBody.key?.kid === 'string' && /^[0-9a-f]{16}$/.test(pkBody.key.kid), 'pubkey prints a 16-hex kid');
  ok(typeof pkBody.key?.pub === 'string' && pkBody.key.pub.length > 0, 'pubkey prints a pub');
  ok(typeof pkBody.key?.createdAt === 'string', 'pubkey prints createdAt');
  ok(!JSON.stringify(pkBody).toLowerCase().includes('private'), 'no private key material anywhere in pubkey output');

  const pkHuman = run(['pubkey']);
  ok(pkHuman.status === 0, 'pubkey (human-readable) exits 0');
  ok(pkHuman.stdout.includes(pkBody.key.kid), 'human-readable pubkey output names the kid');

  // ===== verify --statement (offline, no plan/client access) ================
  const { signStatement } = await import('../lib/attest.mjs');
  const goodPayload = {
    v: 1,
    kind: 'receipt',
    clientId: 'x',
    campaign: 'c',
    postId: 'p1',
    platform: 'x',
    authSig: 'deadbeef',
    outcome: { ok: true, platformId: '123', errorCode: null },
    recordedAt: new Date().toISOString(),
  };
  const signed = signStatement('receipt', goodPayload);
  ok(pkBody.key.kid === signed.kid, 'the statement is signed with the same key pubkey reported');

  const goodFile = path.join(WS, 'good-statement.json');
  fs.writeFileSync(goodFile, JSON.stringify(signed, null, 2));
  const vGood = run(['verify', '--statement', goodFile, '--json']);
  ok(vGood.status === 0, `verify --statement <good> exits 0 (stderr: ${(vGood.stderr || '').trim()})`);
  const vGoodBody = JSON.parse(vGood.stdout);
  ok(vGoodBody.ok === true, 'a good statement verifies with ok:true');
  ok(vGoodBody.results?.[0]?.ok === true, 'the per-statement result is ok:true');

  const vGoodHuman = run(['verify', '--statement', goodFile]);
  ok(vGoodHuman.status === 0, 'human-mode verify --statement <good> also exits 0');
  ok(/ok - /.test(vGoodHuman.stdout), 'human-mode statement verify prints an ok line');

  // Deterministic tamper: XOR one raw signature byte (never a flaky base64 char
  // splice - flipping an arbitrary character can decode to the identical byte or an
  // invalid base64url alphabet character depending on position).
  const sigBuf = Buffer.from(signed.sig, 'base64url');
  sigBuf[0] ^= 0xff;
  const tampered = { ...signed, sig: sigBuf.toString('base64url') };
  const badFile = path.join(WS, 'bad-statement.json');
  fs.writeFileSync(badFile, JSON.stringify(tampered, null, 2));
  const vBad = run(['verify', '--statement', badFile, '--json']);
  ok(vBad.status !== 0, `verify --statement <tampered> exits non-zero (got ${vBad.status})`);
  const vBadBody = JSON.parse(vBad.stdout);
  ok(vBadBody.ok === false, 'a tampered statement verifies with ok:false');
  ok(vBadBody.results?.[0]?.ok === false && vBadBody.results[0].reason === 'bad_signature', 'the tampered result names reason:bad_signature');

  // A wrong explicit --pub anchor must fail even against an otherwise-good statement.
  const wrongPub = Buffer.alloc(32, 7).toString('base64url');
  const vWrongPub = run(['verify', '--statement', goodFile, '--pub', wrongPub, '--json']);
  ok(vWrongPub.status !== 0, 'verify --statement with a wrong --pub anchor exits non-zero');

  // Malformed JSON file degrades cleanly (never a stack trace to stdout).
  const malformedFile = path.join(WS, 'malformed.json');
  fs.writeFileSync(malformedFile, '{not json');
  const vMalformed = run(['verify', '--statement', malformedFile, '--json']);
  ok(vMalformed.status !== 0, 'verify --statement <malformed JSON> exits non-zero');
  const vMalformedBody = JSON.parse(vMalformed.stdout);
  ok(vMalformedBody.ok === false && vMalformedBody.reason === 'malformed', 'malformed statement file reports reason:malformed');

  // Array-of-statements form: one good + one tampered must fail overall while still
  // reporting a distinct per-entry verdict.
  const arrFile = path.join(WS, 'arr-statement.json');
  fs.writeFileSync(arrFile, JSON.stringify([signed, tampered], null, 2));
  const vArr = run(['verify', '--statement', arrFile, '--json']);
  ok(vArr.status !== 0, 'a statement array with one tampered entry exits non-zero overall');
  const vArrBody = JSON.parse(vArr.stdout);
  ok(Array.isArray(vArrBody.results) && vArrBody.results.length === 2, 'array form reports one result per entry');
  ok(vArrBody.results[0].ok === true && vArrBody.results[1].ok === false, 'array form reports distinct per-entry verdicts');

  // ===== verify --campaign/--post (fired + signed, then content-drifted) ====
  const { createCampaign, createPost, approvePost } = await import('../lib/writes.mjs');
  const { loadPlanStore } = await import('../lib/plans.mjs');
  const { runDueExclusive } = await import('../lib/scheduler.mjs');

  const cc = await createCampaign({ id: 'cli', note: 'cli', timezone: 'UTC', actor: 'owner' });
  assert.ok(cc.ok, JSON.stringify(cc));
  const cp = await createPost({
    campaign: 'cli',
    post: { id: 'p1', type: 'text', platforms: ['x'], scheduledAt: '2020-01-01T00:00:00Z', caption: 'a calm little update' },
    actor: 'agent:claude',
  });
  assert.ok(cp.ok, JSON.stringify(cp));
  const ap = await approvePost({ campaign: 'cli', postId: 'p1', actor: 'owner' });
  assert.ok(ap.ok, JSON.stringify(ap));
  await runDueExclusive('owner', { campaign: 'cli', postId: 'p1' });

  const vFire = run(['verify', '--campaign', 'cli', '--post', 'p1', '--json']);
  ok(vFire.status === 0, `verify --campaign/--post on a fired+signed post exits 0 (stderr: ${(vFire.stderr || '').trim()})`);
  const vFireBody = JSON.parse(vFire.stdout);
  ok(vFireBody.ok === true && vFireBody.receipts?.x?.signatureValid === true, 'the fired post reports signatureValid:true');
  ok(vFireBody.receipts?.x?.contentMatchesPlan === true, 'the fired post reports contentMatchesPlan:true (nothing drifted yet)');

  const vFireHuman = run(['verify', '--campaign', 'cli', '--post', 'p1']);
  ok(vFireHuman.status === 0, 'human-mode verify on the fired post also exits 0');
  ok(/^\s*x:/m.test(vFireHuman.stdout), 'human-mode verify prints a per-platform verdict line');

  // Scoping by --platform: an unfired platform on the same post reports no receipt.
  const vScoped = run(['verify', '--campaign', 'cli', '--post', 'p1', '--platform', 'x', '--json']);
  ok(vScoped.status === 0, '--platform x scoped verify on the fired post also exits 0');
  ok(Object.keys(JSON.parse(vScoped.stdout).receipts || {}).length === 1, '--platform scoping returns exactly the named platform');

  // Drift the content on disk after the fire (tamper evidence, same class the
  // scheduler's own split fence catches on the NEXT fire): verify must now refuse.
  const { campaigns } = loadPlanStore();
  const planAbs = path.resolve(WS, campaigns.find((c) => c.id === 'cli').path);
  const raw = JSON.parse(fs.readFileSync(planAbs, 'utf8'));
  raw.posts.find((p) => p.id === 'p1').caption = 'tampered after publish';
  fs.writeFileSync(planAbs, JSON.stringify(raw, null, 2));

  const vDrift = run(['verify', '--campaign', 'cli', '--post', 'p1', '--json']);
  ok(vDrift.status !== 0, `verify on a content-drifted post exits non-zero (got ${vDrift.status})`);
  const vDriftBody = JSON.parse(vDrift.stdout);
  ok(vDriftBody.receipts?.x?.contentMatchesPlan === false, 'the drifted post reports contentMatchesPlan:false');
  ok(vDriftBody.receipts?.x?.signatureValid === true, 'the drifted post still reports signatureValid:true (the signature itself is intact, only the plan content moved)');

  // Unknown campaign / missing args surface a distinct, honest error, never a crash.
  const vUnknownCamp = run(['verify', '--campaign', 'nope', '--post', 'p1', '--json']);
  ok(vUnknownCamp.status !== 0, 'verify on an unknown campaign exits non-zero');
  const vUnknownCampBody = JSON.parse(vUnknownCamp.stdout);
  ok(vUnknownCampBody.code === 'unknown_campaign', 'unknown campaign surfaces code:unknown_campaign');

  const vMissingArgs = run(['verify']);
  ok(vMissingArgs.status !== 0, 'verify with no --campaign/--post/--statement exits non-zero');
  ok(/[Uu]sage/.test(vMissingArgs.stderr || ''), 'verify with missing args prints usage');

  console.log(`[attest-cli] OK - pubkey + verify (statement + campaign/post) exit codes and output (${pass} assertions).`);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
