// lanes-wave2.test.mjs - the five wave-2 lanes (mastodon, wordpress, ghost,
// nostr, gbp) run the full mock loop end-to-end through their REAL engine
// entrypoints: publish-due mints the lane's id via the mock driver, verify
// reads back live with a permalink, insights returns the platform's metric
// shape. This is the same credential-free proof the reddit/pinterest/tiktok
// wave shipped with - the engine CLI, the mock gate, and the mock driver's
// per-platform branches are all exercised in one pass, per lane.
//
// The real-network paths are proven separately against the Docker sandboxes
// (test/integration/) - this test never touches the network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');

let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

// lane -> { script, idField, extra post fields beyond the shared baseline }
const LANES = {
  mastodon: { script: 'scripts/mastodon-social.mjs', idField: 'mastodonStatusId', fields: { mastodonCaption: 'a short note override' } },
  wordpress: { script: 'scripts/wordpress-social.mjs', idField: 'wordpressPostId', fields: { title: 'Wave-2 article', body: '# Hello\n\nA **markdown** body.', excerpt: 'A test excerpt.', tags: 'pendpost, wave2' } },
  ghost: { script: 'scripts/ghost-social.mjs', idField: 'ghostPostId', fields: { title: 'Wave-2 article', body: 'Body text.', excerpt: 'A test excerpt.', canonicalUrl: 'https://example.com/src', ghostEmail: false } },
  nostr: { script: 'scripts/nostr-social.mjs', idField: 'nostrEventId', fields: { nostrCaption: 'a nostr note override' } },
  gbp: { script: 'scripts/gbp-social.mjs', idField: 'gbpPostId', fields: { gbp: { topic: 'event', ctaType: 'LEARN_MORE', ctaUrl: 'https://example.com', eventTitle: 'Launch', eventStart: '2026-08-01', eventEnd: '2026-08-02' } } },
};

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-wave2-'));

function runEngine(script, args) {
  const out = execFileSync(process.execPath, [path.join(REPO, script), ...args], {
    cwd: REPO,
    env: { ...process.env, PENDPOST_MODE: 'mock', PENDPOST_ROOT: WS },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop());
}

try {
  for (const [lane, def] of Object.entries(LANES)) {
    const planPath = path.join(WS, `${lane}-plan.json`);
    const post = {
      id: 'w2-01',
      type: 'text',
      platforms: [lane],
      scheduledAt: new Date(Date.now() - 60_000).toISOString(), // due one minute ago
      caption: `wave-2 mock loop for ${lane}`,
      status: 'planned',
      executionMode: 'fully-scheduled',
      approval: 'approved',
      createdBy: 'owner',
      approvalBy: 'owner',
      ...def.fields,
    };
    fs.writeFileSync(planPath, JSON.stringify({ campaign: `wave2-${lane}`, posts: [post] }, null, 2));

    // publish-due mints the lane's id and flips the post to posted (mock driver).
    const pub = runEngine(def.script, ['publish-due', '--plan', planPath, '--json']);
    ok(pub.ok === true && pub.results.some((r) => r.platform === lane && r.action === 'publish' && r.ok), `${lane}: mock publish-due publishes the due post`);
    const saved = JSON.parse(fs.readFileSync(planPath, 'utf8')).posts[0];
    ok(typeof saved[def.idField] === 'string' && saved[def.idField].startsWith('mock_'), `${lane}: ${def.idField} is minted on the plan`);
    ok(saved.status === 'posted', `${lane}: the post flips to posted`);

    // verify reads the fabricated id back live with a permalink.
    const ver = runEngine(def.script, ['verify', '--plan', planPath, '--json']);
    const row = ver.results.find((r) => r.platform === lane && r.action === 'verify');
    ok(row && row.live === true && typeof row.permalink === 'string' && row.permalink.startsWith('https://'), `${lane}: mock verify reads back live with a permalink`);

    // insights returns the lane's metric shape (or is an honest engine no-op).
    const ins = runEngine(def.script, ['insights', '--plan', planPath, '--json']);
    const irow = ins.results.find((r) => r.platform === lane && r.action === 'insights');
    ok(irow && irow.metrics && Object.keys(irow.metrics).length > 0, `${lane}: mock insights carries metrics`);

    // A second publish-due is a no-op: the id already exists (idempotent loop).
    const again = runEngine(def.script, ['publish-due', '--plan', planPath, '--json']);
    ok(again.ok === true && !again.results.some((r) => r.platform === lane && r.action === 'publish'), `${lane}: a second publish-due does not double-publish`);
  }

  if (failures) {
    console.error(`[lanes-wave2] FAIL - ${failures} assertion(s) failed`);
    process.exitCode = 1;
  } else {
    console.log(`[lanes-wave2] OK - all five wave-2 lanes run the mock loop (publish -> id -> verify live -> insights, idempotent) through their real engine CLIs (${pass} assertions).`);
  }
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}
