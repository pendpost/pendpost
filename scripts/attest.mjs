#!/usr/bin/env node
// scripts/attest.mjs - spec 51 operator ceremony (v1: verify | pubkey; NO rotate,
// single keypair, D1/D4). `pubkey` is CLI-ONLY (no MCP tool, no API route): exporting
// the public signing key is an operator ceremony, like credential handling
// (threat-model.md sec 6.3), recorded as a parity exemption in API-CONTRACT.md.
// `verify` has two modes: `--campaign/--post` reads a fired post's on-disk
// attestation/receipt maps via lib/receipts.mjs verifyReceipt (needs a plan, so it
// rides --client / enforceCeremonyClient like every other engine CLI); `--statement
// <file>` is the OFFLINE/EXTERNAL path - a verifier holding only the two statements
// and the operator's published pubkey, no plan or client access at all.
//
// No secret is ever printed by this script: only kid/pub (public) and verdict
// booleans ever reach stdout.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enforceCeremonyClient } from '../lib/cli-client.mjs';
import { getPublicKey, verifyStatement } from '../lib/attest.mjs';
import { verifyReceipt } from '../lib/receipts.mjs';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else args[key] = argv[(i += 1)];
    } else args._.push(a);
  }
  return args;
}

const USAGE = `Usage: node scripts/attest.mjs <verify|pubkey> [options]

  pubkey [--client <id>] [--json]
      Print the active signing key's public identity: kid, pub, createdAt.
      This is the out-of-band trust anchor an external verifier pins.

  verify --campaign <c> --post <p> [--platform <lane>] [--client <id>] [--json]
      Verify a fired post's on-disk receipts against the local plan.
      Exit 0 only when every checked platform is signatureValid, chainValid,
      placementValid, contentMatchesPlan and platformIdMatches.

  verify --statement <file.json> [--pub <b64url>] [--json]
      OFFLINE verification: check one signed statement (or a JSON array of
      them) with no plan or client access, against the statement's embedded
      pub or an explicit --pub trust anchor. Exit 0 only when every
      statement in the file verifies.

No 'rotate' verb in v1 (single keypair). No secret is ever printed.
`;

function printUsage() {
  process.stderr.write(USAGE);
}

function out(json, obj) {
  if (json) console.log(JSON.stringify(obj, null, 2));
  return obj;
}

function loadStatements(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function cmdPubkey(args) {
  const json = Boolean(args.json);
  const key = getPublicKey();
  out(json, { ok: true, key });
  if (!json) {
    console.log(`kid   ${key.kid}`);
    console.log(`pub   ${key.pub}`);
    console.log(`since ${key.createdAt}`);
  }
  process.exit(0);
}

function cmdVerifyStatement(args) {
  const json = Boolean(args.json);
  let statements;
  try {
    statements = loadStatements(args.statement);
  } catch (e) {
    out(json, { ok: false, reason: 'malformed', message: e.message });
    if (!json) console.log(`invalid - could not read/parse ${args.statement}: ${e.message}`);
    process.exit(2);
    return;
  }
  const pub = typeof args.pub === 'string' ? args.pub : undefined;
  const results = statements.map((signed) => {
    const v = verifyStatement(signed, pub ? { pub } : {});
    return { kind: signed?.payload?.kind ?? null, kid: signed?.kid ?? null, ...v };
  });
  const allOk = results.length > 0 && results.every((r) => r.ok);
  out(json, { ok: allOk, results });
  if (!json) {
    results.forEach((r, i) => {
      console.log(r.ok ? `  [${i}] ok - ${r.kind || 'statement'} verified` : `  [${i}] invalid - ${r.reason} (${r.kind || 'statement'})`);
    });
    if (!results.length) console.log('  no statements found in file');
  }
  process.exit(allOk ? 0 : 1);
}

async function cmdVerifyReceipt(args) {
  const json = Boolean(args.json);
  const res = await verifyReceipt({
    campaign: args.campaign,
    postId: args.post,
    platform: typeof args.platform === 'string' ? args.platform : null,
    actor: 'owner',
  });
  out(json, res);
  if (res.ok !== true) {
    if (!json) console.log(`error - ${res.code}: ${res.message}`);
    process.exit(2);
    return;
  }
  const verdicts = Object.entries(res.receipts || {});
  if (!json) {
    if (!verdicts.length) console.log(`no receipts (${res.reason || 'none'})`);
    else {
      for (const [p, v] of verdicts) {
        console.log(`  ${p}: sig=${v.signatureValid} chain=${v.chainValid} place=${v.placementValid} content=${v.contentMatchesPlan} id=${v.platformIdMatches} key=${v.keyStatus}`);
      }
    }
  }
  const allGood = verdicts.length > 0
    && verdicts.every(([, v]) => v.signatureValid && v.chainValid && v.placementValid && v.contentMatchesPlan && v.platformIdMatches);
  process.exit(allGood ? 0 : 1);
}

async function main() {
  const args = parseArgs(process.argv);
  const verb = args._[0];

  if (args.help) {
    printUsage();
    process.exit(0);
  }
  if (verb !== 'pubkey' && verb !== 'verify') {
    if (verb) console.error(`Unknown subcommand: ${verb}`);
    printUsage();
    process.exit(2);
  }

  // Scope the ceremony to the named client (or, for a hand-run credential
  // ceremony verb, refuse an untargeted run); pubkey/verify are read-only, so
  // like every other engine CLI's non-ceremony verb they simply honor an
  // explicit --client and otherwise keep the existing activeRoot() resolution.
  await enforceCeremonyClient({ argv: args, command: verb, lane: 'attest', scriptUrl: import.meta.url });

  if (verb === 'pubkey') {
    cmdPubkey(args);
    return;
  }

  // verb === 'verify'
  if (typeof args.statement === 'string') {
    cmdVerifyStatement(args);
    return;
  }
  if (!args.campaign || !args.post) {
    console.error('verify needs --campaign and --post, or --statement <file>');
    printUsage();
    process.exit(2);
    return;
  }
  await cmdVerifyReceipt(args);
}

// CLI entry - only when executed directly, never when imported (mirrors the
// mastodon-social.mjs / x-social.mjs guard so a test importing this module's
// exports, if any, never races main() against the importing process's own argv).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(2);
  });
}
