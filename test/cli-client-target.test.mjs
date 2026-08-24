#!/usr/bin/env node
// test/cli-client-target.test.mjs - a hand-run credential ceremony must target the
// EXPLICIT client, never the global activeClientId by accident.
//
// The bug this guards: `node scripts/reddit-social.mjs auth` run from a shell sets no
// PENDPOST_ROOT, so activeRoot() falls to data/clients/<activeClientId>. With
// activeClientId=bondigoo, a ceremony meant for pendpost silently reads/writes
// bondigoo's .env. lib/cli-client.mjs enforceCeremonyClient closes that: an explicit
// --client is honored (and the process is re-rooted at it), and with no client and no
// TTY to confirm on the ceremony REFUSES rather than touching the active client.
//
// Both cases spawn the REAL reddit engine NON-interactively (spawnSync, piped stdio,
// so process.stdin.isTTY is undefined) for deterministic behavior. PENDPOST_ROOT is a
// throwaway workspace whose clients.json makes bondigoo the active client - exactly the
// production hazard, in a temp dir. PENDPOST_MODE=mock keeps `connect` offline (the verb
// is not mockable, so cmdConnect still runs and writes; only its live validation is skipped).

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
const SCRIPT = path.join(REPO, 'scripts', 'reddit-social.mjs');

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-cli-target-'));
const DATA = path.join(WS, 'data');
const clientEnv = (id) => path.join(DATA, 'clients', id, '.env');

function run(args, extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, PENDPOST_ROOT: WS, PENDPOST_MODE: 'mock', ...extraEnv },
  });
}

try {
  // A throwaway multi-client registry: bondigoo is ACTIVE (the wrong target).
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'clients.json'), JSON.stringify({
    activeClientId: 'bondigoo',
    clients: [
      { id: 'default', displayName: 'Default', status: 'active' },
      { id: 'bondigoo', displayName: 'bondigoo', status: 'active' },
      { id: 'pendpost', displayName: 'pendpost', status: 'active' },
    ],
  }));

  // ===== A. explicit --client is honored, even though activeClientId=bondigoo =====
  const creds = {
    REDDIT_CLIENT_ID: 'fake-client-id',
    REDDIT_CLIENT_SECRET: 'fake-secret-ends-with=', // proves '=' in a value round-trips
    REDDIT_USERNAME: 'fake-user',
    REDDIT_PASSWORD: 'fake-pass',
    REDDIT_SUBREDDIT: 'SocialMediaMarketing',
  };
  const a = run(['connect', '--client', 'pendpost', '--non-interactive'], creds);
  ok(a.status === 0, `connect --client pendpost exits 0 (got ${a.status}; stderr: ${(a.stderr || '').trim().slice(-200)})`);
  ok(fs.existsSync(clientEnv('pendpost')), 'wrote data/clients/pendpost/.env (the EXPLICIT target)');
  const written = fs.readFileSync(clientEnv('pendpost'), 'utf8');
  ok(/^REDDIT_CLIENT_ID=fake-client-id$/m.test(written), 'pendpost/.env carries REDDIT_CLIENT_ID');
  ok(/^REDDIT_CLIENT_SECRET=fake-secret-ends-with=$/m.test(written), "a secret value containing '=' round-trips");
  ok(/^REDDIT_SUBREDDIT=SocialMediaMarketing$/m.test(written), 'pendpost/.env carries the target subreddit');
  ok(!fs.existsSync(clientEnv('bondigoo')), 'the ACTIVE client bondigoo/.env was NOT written');

  // ===== B. no --client, no TTY to confirm on -> REFUSE, write nothing =====
  const b = run(['connect']); // no --client, piped stdio => not a TTY
  ok(b.status === 2, `bare connect refuses with exit 2 (got ${b.status})`);
  ok(/refus/i.test(b.stderr || ''), 'refusal names why it stopped (stderr mentions refusing)');
  ok(/bondigoo/.test(b.stderr || ''), 'refusal surfaces the active client it would have hit (bondigoo)');
  ok(!fs.existsSync(clientEnv('bondigoo')), 'still nothing written to bondigoo/.env after the refusal');

  // ===== C. NON-ceremony verbs: an explicit --client is honored, never ignored =====
  // The 2026-08-20 footgun: `set-thumbnail --client bondigoo` silently ran against
  // the repo-root workspace because only CEREMONY_VERBS re-rooted. An explicit
  // target on ANY verb must now re-root (visible via the [info] targeting line)...
  const c = run(['status', '--client', 'pendpost']);
  ok(/targeting client 'pendpost'/.test(c.stderr || ''), `non-ceremony --client pendpost re-roots (stderr carries the targeting line; got: ${(c.stderr || '').trim().slice(0, 120)})`);
  // ...an UNKNOWN client must refuse instead of silently proceeding...
  const d = run(['status', '--client', 'nope']);
  ok(d.status === 2, `non-ceremony --client with an unknown id refuses with exit 2 (got ${d.status})`);
  ok(/Unknown client 'nope'/.test(d.stderr || ''), 'the refusal names the unknown client');
  // ...and WITHOUT a flag the verb is untouched (no re-root, no targeting line).
  const e = run(['status']);
  ok(!/targeting client/.test(e.stderr || ''), 'a bare non-ceremony verb keeps its existing resolution (no re-root)');

  console.log(`[cli-client-target] OK - hand-run ceremonies target the explicit client, or refuse; non-ceremony verbs honor --client (${pass} assertions).`);
} catch (err) {
  console.error(`[cli-client-target] FAIL - ${err && err.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
