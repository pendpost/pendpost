#!/usr/bin/env node
/**
 * sandbox.mjs - signup-free LIVE verification of the wave-2 publish lanes.
 *
 * Drives the Docker sandboxes in ./docker-compose.yml (local Mastodon,
 * WordPress, Ghost, and a Nostr relay - all loopback-only, all dummy-credential)
 * and then proves each lane end-to-end THROUGH ITS REAL ENGINE: a real
 * publish-due against the real platform software, the minted id read back live
 * via the engine's own `verify`, plus an anonymous HTTP fetch of the permalink
 * where the platform serves one. No account is created anywhere on the
 * internet; `down` disposes of everything.
 *
 * Commands:
 *   up [lane]         start the sandbox containers (mastodon|wordpress|ghost|nostr)
 *   provision [lane]  one-time in-container setup; writes .sandbox-creds.json
 *   verify [lane]     the publish proof (default: every provisioned lane)
 *   status            container + credential overview
 *   down              stop everything and remove the volumes
 *
 * NOT part of `npm run check` (needs Docker). The credential-free mock loop
 * for the same lanes lives in test/lanes-wave2.test.mjs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(DIR, '..', '..');
const COMPOSE = path.join(DIR, 'docker-compose.yml');
const CREDS_PATH = path.join(DIR, '.sandbox-creds.json');
const MASTODON_ENV = path.join(DIR, '.mastodon.env');
const PROOFS_DIR = path.join(DIR, '.proofs');

const LANES = ['wordpress', 'ghost', 'nostr', 'mastodon'];
const SERVICES = {
  wordpress: ['wp-db', 'wordpress'],
  ghost: ['ghost'],
  nostr: ['nostr-relay'],
  mastodon: ['mastodon-db', 'mastodon-redis', 'mastodon-web', 'mastodon-sidekiq'],
};
const URLS = {
  wordpress: 'http://127.0.0.1:8085',
  ghost: 'http://127.0.0.1:8086',
  nostr: 'ws://127.0.0.1:8087',
  mastodon: 'http://127.0.0.1:8083',
};

// A tiny valid JPEG (1x1, red) so the media paths exercise a REAL upload.
const FIXTURE_JPEG_B64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigD//2Q==';

function log(line) { process.stdout.write(`${line}\n`); }
function fail(msg) { console.error(`[err] ${msg}`); process.exit(1); }

function compose(args, opts = {}) {
  return execFileSync('docker', ['compose', '-f', COMPOSE, ...args], {
    cwd: DIR, encoding: 'utf8', stdio: opts.quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'inherit'],
    ...opts,
  });
}

function readCreds() {
  try { return JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8')); } catch { return {}; }
}
function writeCreds(patch) {
  const next = { ...readCreds(), ...patch };
  fs.writeFileSync(CREDS_PATH, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

async function waitFor(label, fn, { tries = 60, delayMs = 2000 } = {}) {
  for (let i = 0; i < tries; i++) {
    try { const v = await fn(); if (v) return v; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`timed out waiting for ${label}`);
}

// ---- mastodon boot secrets ---------------------------------------------------
// Minted locally ONCE (node crypto - no docker round-trip): rails secrets, a
// real ES256 VAPID pair (webpush wire format: base64url raw keys), and the
// ActiveRecord encryption trio Mastodon 4.3+ refuses to boot without. All
// dummy-local, but minted keys still stay out of git (.mastodon.env ignored).
function ensureMastodonEnv() {
  if (fs.existsSync(MASTODON_ENV)) return;
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const b64u = (buf) => Buffer.from(buf).toString('base64url');
  const lines = [
    'LOCAL_DOMAIN=127.0.0.1:8083',
    'RAILS_ENV=production',
    'RAILS_LOG_LEVEL=warn',
    'BIND=0.0.0.0',
    'DB_HOST=mastodon-db',
    'DB_PORT=5432',
    'DB_USER=mastodon',
    'DB_NAME=mastodon_production',
    'DB_PASS=',
    'REDIS_HOST=mastodon-redis',
    'REDIS_PORT=6379',
    'ES_ENABLED=false',
    `SECRET_KEY_BASE=${crypto.randomBytes(64).toString('hex')}`,
    `OTP_SECRET=${crypto.randomBytes(64).toString('hex')}`,
    `VAPID_PRIVATE_KEY=${b64u(ecdh.getPrivateKey())}`,
    `VAPID_PUBLIC_KEY=${b64u(ecdh.getPublicKey())}`,
    `ACTIVE_RECORD_ENCRYPTION_PRIMARY_KEY=${crypto.randomBytes(32).toString('hex')}`,
    `ACTIVE_RECORD_ENCRYPTION_DETERMINISTIC_KEY=${crypto.randomBytes(32).toString('hex')}`,
    `ACTIVE_RECORD_ENCRYPTION_KEY_DERIVATION_SALT=${crypto.randomBytes(32).toString('hex')}`,
    'SMTP_SERVER=localhost',
    'SMTP_PORT=25',
    'SMTP_FROM_ADDRESS=sandbox@localhost.local',
  ];
  fs.writeFileSync(MASTODON_ENV, `${lines.join('\n')}\n`);
  log('[ok] minted .mastodon.env (local sandbox secrets)');
}

// Sandbox-only initializer mounted over the image: serve plain http on loopback
// (Mastodon production hardcodes force_ssl; the middleware honors this flag at
// stack-build time, which runs after initializers).
function ensureMastodonInitializer() {
  const p = path.join(DIR, 'mastodon-sandbox.rb');
  if (fs.existsSync(p)) return;
  fs.writeFileSync(p, [
    '# mastodon-sandbox.rb - SANDBOX ONLY: the pendpost lane verifier talks plain',
    '# http to 127.0.0.1, so drop the production force_ssl redirect. Mounted via',
    '# docker-compose into config/initializers/; never used outside the sandbox.',
    'Rails.application.config.force_ssl = false',
    '',
  ].join('\n'));
}

// ---- lifecycle ----------------------------------------------------------------

function lanesFromArg(arg) {
  if (!arg || arg === 'all') return LANES;
  if (!LANES.includes(arg)) fail(`unknown lane "${arg}" (expected ${LANES.join(' | ')} | all)`);
  return [arg];
}

function up(lanes) {
  if (lanes.includes('mastodon')) { ensureMastodonEnv(); ensureMastodonInitializer(); }
  else if (!fs.existsSync(MASTODON_ENV)) { ensureMastodonEnv(); ensureMastodonInitializer(); } // compose parses every service's env_file
  const services = lanes.flatMap((l) => SERVICES[l]);
  compose(['up', '-d', ...services]);
  log(`[ok] up: ${services.join(', ')}`);
}

function down() {
  compose(['down', '-v']);
  log('[ok] sandbox stopped, volumes removed');
}

// ---- provisioning --------------------------------------------------------------

async function provisionWordpress() {
  const wp = (args) => compose(['run', '--rm', 'wp-cli', 'wp', ...args], { quiet: true }).trim();
  await waitFor('wordpress db', () => {
    try { wp(['db', 'check']); return true; } catch { return false; }
  }, { tries: 30 });
  let installed = false;
  try { wp(['core', 'is-installed']); installed = true; } catch { /* fresh */ }
  if (!installed) {
    wp(['core', 'install', '--url=http://127.0.0.1:8085', '--title=pendpost sandbox',
      '--admin_user=admin', '--admin_password=pendpost-sandbox', '--admin_email=sandbox@localhost.local', '--skip-email']);
    wp(['rewrite', 'structure', '/%postname%/', '--hard']);
    log('[ok] wordpress core installed (admin / pendpost-sandbox)');
  } else {
    log('[ok] wordpress already installed');
  }
  const appPassword = wp(['user', 'application-password', 'create', 'admin', `pendpost-${Date.now()}`, '--porcelain']);
  writeCreds({ wordpress: { siteUrl: URLS.wordpress, username: 'admin', appPassword } });
  log('[ok] wordpress application password minted');
}

async function provisionGhost() {
  const base = `${URLS.ghost}/ghost/api/admin`;
  await waitFor('ghost http', async () => (await fetch(URLS.ghost, { redirect: 'manual' })).status < 500);
  const owner = { name: 'pendpost', email: 'sandbox@localhost.local', password: 'pendpost-sandbox-pass', blogTitle: 'pendpost sandbox' };
  const setupState = await (await fetch(`${base}/authentication/setup/`)).json();
  if (!setupState?.setup?.[0]?.status) {
    const res = await fetch(`${base}/authentication/setup/`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: URLS.ghost },
      body: JSON.stringify({ setup: [owner] }),
    });
    if (!res.ok) throw new Error(`ghost setup failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    log('[ok] ghost owner created');
  } else {
    log('[ok] ghost already set up');
  }
  // Session login (CSRF wants a matching Origin), then mint a custom integration.
  const sess = await fetch(`${base}/session/`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: URLS.ghost },
    body: JSON.stringify({ username: owner.email, password: owner.password }),
  });
  if (!sess.ok && sess.status !== 201) throw new Error(`ghost session failed: HTTP ${sess.status} ${(await sess.text()).slice(0, 200)}`);
  const cookie = (sess.headers.getSetCookie?.() || [sess.headers.get('set-cookie')]).filter(Boolean).map((c) => c.split(';')[0]).join('; ');
  const name = `pendpost-sandbox-${Date.now()}`;
  const integ = await fetch(`${base}/integrations/?include=api_keys`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: URLS.ghost, Cookie: cookie },
    body: JSON.stringify({ integrations: [{ name }] }),
  });
  if (!integ.ok) throw new Error(`ghost integration failed: HTTP ${integ.status} ${(await integ.text()).slice(0, 200)}`);
  // GOTCHA (found the hard way): the CREATE response's api_keys carry a
  // truncated secret. Only the authenticated GET returns the real 64-hex admin
  // secret, so read the integration back before persisting the key.
  const list = await fetch(`${base}/integrations/?include=api_keys&limit=all`, { headers: { Origin: URLS.ghost, Cookie: cookie } });
  if (!list.ok) throw new Error(`ghost integration read-back failed: HTTP ${list.status}`);
  const data = await list.json();
  const mine = (data.integrations || []).find((i) => i.name === name);
  const adminKey = (mine?.api_keys || []).find((k) => k.type === 'admin' && String(k.secret || '').length === 64);
  if (!adminKey) throw new Error('ghost integration read-back returned no full admin api key');
  writeCreds({ ghost: { siteUrl: URLS.ghost, adminApiKey: `${adminKey.id}:${adminKey.secret}` } });
  log('[ok] ghost custom integration minted (admin api key)');
}

function provisionNostr() {
  const out = execFileSync(process.execPath, [path.join(REPO, 'scripts', 'nostr-social.mjs'), 'keygen'], { cwd: REPO, encoding: 'utf8' });
  const hex = out.match(/hex:\s*([0-9a-f]{64})/i)?.[1] || out.match(/\b([0-9a-f]{64})\b/i)?.[1];
  if (!hex) throw new Error(`keygen output carried no hex key:\n${out}`);
  writeCreds({ nostr: { privateKey: hex, relays: URLS.nostr } });
  log('[ok] nostr keypair minted for the sandbox relay');
}

async function provisionMastodon() {
  const run = (cmd) => compose(['run', '--rm', 'mastodon-web', ...cmd], { quiet: true });
  log('[..] mastodon rails db:prepare (first run takes a minute)');
  run(['bundle', 'exec', 'rails', 'db:prepare']);
  try {
    run(['bin/tootctl', 'accounts', 'create', 'pendpost', '--email', 'pendpost.sandbox@gmail.com', '--confirmed', '--approve']);
    log('[ok] mastodon account @pendpost created');
  } catch (e) {
    const msg = String(e.stderr || e.stdout || e.message);
    if (!/taken|exists/i.test(msg)) throw e;
    log('[ok] mastodon account @pendpost already exists');
  }
  const runner = `
    u = User.find_by!(email: "pendpost.sandbox@gmail.com")
    app = Doorkeeper::Application.find_or_create_by!(name: "pendpost-sandbox") { |a| a.redirect_uri = "urn:ietf:wg:oauth:2.0:oob"; a.scopes = "read write" }
    tok = Doorkeeper::AccessToken.find_by(application_id: app.id, resource_owner_id: u.id, revoked_at: nil)
    tok ||= Doorkeeper::AccessToken.create!(application_id: app.id, resource_owner_id: u.id, scopes: "read write")
    puts "PENDPOST_TOKEN=#{tok.token}"
  `;
  const out = run(['bin/rails', 'runner', runner]);
  const token = out.match(/PENDPOST_TOKEN=(\S+)/)?.[1];
  if (!token) throw new Error(`mastodon token mint failed:\n${out.slice(-400)}`);
  writeCreds({ mastodon: { instanceUrl: URLS.mastodon, accessToken: token } });
  await waitFor('mastodon web', async () => (await fetch(`${URLS.mastodon}/api/v1/instance`, { redirect: 'manual' })).ok);
  log('[ok] mastodon provisioned (@pendpost + app token)');
}

const PROVISIONERS = { wordpress: provisionWordpress, ghost: provisionGhost, nostr: provisionNostr, mastodon: provisionMastodon };

// ---- the publish proof ----------------------------------------------------------

const LANE_SPEC = {
  wordpress: {
    idField: 'wordpressPostId',
    env: (c) => ({ WORDPRESS_SITE_URL: c.siteUrl, WORDPRESS_USERNAME: c.username, WORDPRESS_APP_PASSWORD: c.appPassword }),
    post: {
      type: 'text', title: 'pendpost sandbox proof', body: '# Sandbox proof\n\nPublished by the **pendpost** wordpress lane against a local sandbox.\n\n- real REST publish\n- real read-back',
      excerpt: 'A real publish from the pendpost sandbox verifier.', tags: 'pendpost, sandbox', caption: 'sandbox proof', file: 'fixture.jpg',
    },
    media: true,
  },
  ghost: {
    idField: 'ghostPostId',
    env: (c) => ({ GHOST_SITE_URL: c.siteUrl, GHOST_ADMIN_API_KEY: c.adminApiKey }),
    post: {
      type: 'text', title: 'pendpost sandbox proof', body: 'Published by the **pendpost** ghost lane against a local sandbox.',
      excerpt: 'A real publish from the pendpost sandbox verifier.', tags: 'pendpost, sandbox', canonicalUrl: 'https://example.com/sandbox-proof',
      ghostEmail: false, caption: 'sandbox proof', file: 'fixture.jpg',
    },
    media: true,
  },
  nostr: {
    idField: 'nostrEventId',
    env: (c) => ({ NOSTR_PRIVATE_KEY: c.privateKey, NOSTR_RELAYS: c.relays }),
    post: { type: 'text', caption: 'pendpost sandbox proof - a real NIP-01 note accepted by a local relay.' },
    media: false,
  },
  mastodon: {
    idField: 'mastodonStatusId',
    env: (c) => ({ MASTODON_INSTANCE_URL: c.instanceUrl, MASTODON_ACCESS_TOKEN: c.accessToken }),
    post: { type: 'reel', caption: 'pendpost sandbox proof - a real status with real media.', file: 'fixture.jpg' },
    media: true,
  },
};

function runEngine(lane, ws, args) {
  const script = path.join(REPO, 'scripts', `${lane}-social.mjs`);
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [script, ...args, '--json', '--actor', 'sandbox'], {
      cwd: REPO, env: { ...process.env, PENDPOST_ROOT: ws }, timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      let envelope = null;
      try { envelope = JSON.parse(String(stdout).trim().split('\n').pop()); } catch { /* died before envelope */ }
      if (!envelope) return reject(new Error(`${lane} engine died: ${String(stderr).slice(-400)}`));
      resolve(envelope);
    });
  });
}

async function verifyLane(lane) {
  const creds = readCreds()[lane];
  if (!creds) fail(`${lane} is not provisioned - run: node test/integration/sandbox.mjs provision ${lane}`);
  const spec = LANE_SPEC[lane];

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), `pendpost-sbx-${lane}-`));
  try {
    const envLines = Object.entries(spec.env(creds)).map(([k, v]) => `${k}=${v}`);
    fs.writeFileSync(path.join(ws, '.env'), `${envLines.join('\n')}\n`);
    if (spec.media) fs.writeFileSync(path.join(ws, 'fixture.jpg'), Buffer.from(FIXTURE_JPEG_B64, 'base64'));
    const planPath = path.join(ws, 'plan.json');
    const post = {
      id: 'sbx-01', platforms: [lane], scheduledAt: new Date(Date.now() - 60_000).toISOString(),
      status: 'planned', executionMode: 'fully-scheduled', approval: 'approved', createdBy: 'owner', approvalBy: 'sandbox',
      ...spec.post,
    };
    fs.writeFileSync(planPath, JSON.stringify({ campaign: `sandbox-${lane}`, posts: [post] }, null, 2));

    // 1. the REAL publish
    const pub = await runEngine(lane, ws, ['publish-due', '--plan', planPath]);
    const pubRow = (pub.results || []).find((r) => r.platform === lane && /publish/.test(r.action || ''));
    if (!pub.ok || !pubRow || !pubRow.ok) throw new Error(`${lane} publish failed: ${JSON.stringify(pub).slice(0, 400)}`);
    const saved = JSON.parse(fs.readFileSync(planPath, 'utf8')).posts[0];
    const id = saved[spec.idField];
    if (!id) throw new Error(`${lane} publish returned ok but ${spec.idField} was not minted`);

    // 2. the REAL read-back through the engine's verify
    const ver = await runEngine(lane, ws, ['verify', '--plan', planPath]);
    const verRow = (ver.results || []).find((r) => r.platform === lane && r.action === 'verify');
    if (!verRow || verRow.live !== true) throw new Error(`${lane} verify did not read back live: ${JSON.stringify(ver).slice(0, 400)}`);

    // 3. anonymous permalink fetch where the platform serves http (nostr's
    //    read-back IS the relay REQ in step 2; its permalink is an external resolver).
    let permalinkFetch = 'skipped';
    if (lane !== 'nostr' && verRow.permalink) {
      // The mastodon sandbox generates https:// permalinks (production URL
      // helper); the loopback listener is plain http - rewrite for the fetch.
      const url = verRow.permalink.replace(/^https:\/\/127\.0\.0\.1:8083/, 'http://127.0.0.1:8083');
      const res = await fetch(url, { redirect: 'follow' });
      permalinkFetch = `HTTP ${res.status}`;
      if (!res.ok) throw new Error(`${lane} permalink fetch failed: ${permalinkFetch} for ${url}`);
    }

    const proof = {
      lane, at: new Date().toISOString(), id, live: true,
      permalink: verRow.permalink || null, permalinkFetch,
      mediaUploaded: Boolean(spec.media), state: verRow.state,
    };
    fs.mkdirSync(PROOFS_DIR, { recursive: true });
    fs.writeFileSync(path.join(PROOFS_DIR, `${lane}.json`), `${JSON.stringify(proof, null, 2)}\n`);
    log(`[PROOF] ${lane}: id=${id} live=${verRow.state} media=${spec.media ? 'yes' : 'no'} permalink=${verRow.permalink || '-'} (fetch: ${permalinkFetch})`);
    return proof;
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

// ---- main -----------------------------------------------------------------------

const [, , cmd, laneArg] = process.argv;
try {
  if (cmd === 'up') up(lanesFromArg(laneArg));
  else if (cmd === 'down') down();
  else if (cmd === 'status') {
    log(compose(['ps'], { quiet: true }));
    const creds = readCreds();
    for (const l of LANES) log(`  ${l.padEnd(10)} ${creds[l] ? 'provisioned' : 'NOT provisioned'}`);
  } else if (cmd === 'provision') {
    for (const l of lanesFromArg(laneArg)) await PROVISIONERS[l]();
  } else if (cmd === 'verify') {
    const lanes = lanesFromArg(laneArg).filter((l) => readCreds()[l]);
    if (!lanes.length) fail('no provisioned lane to verify - run provision first');
    const proofs = [];
    for (const l of lanes) proofs.push(await verifyLane(l));
    log(`\n[done] ${proofs.length}/${lanes.length} lane(s) proved a real publish + read-back.`);
  } else {
    log('Usage: node test/integration/sandbox.mjs <up|provision|verify|status|down> [wordpress|ghost|nostr|mastodon|all]');
    process.exit(2);
  }
} catch (err) {
  fail(err.message || String(err));
}
