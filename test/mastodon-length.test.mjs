#!/usr/bin/env node
// test/mastodon-length.test.mjs - Mastodon status length counted the way Mastodon counts it
// (StatusLengthValidator): every http(s) URL is 23 characters whatever its real length, an
// @user@domain mention counts only as @user, and characters are graphemes. The 2026-11 blog
// drafts were 502-596 raw characters, and 4 of 6 actually fit once links count 23. Proves the
// one helper and that pre-flight, brand-lint and the engine all use it, so approval and
// publish agree.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let failures = 0;
function ok(cond, msg) {
  if (cond) { pass += 1; console.log(`  ok - ${msg}`); } else { failures += 1; console.error(`  FAIL - ${msg}`); }
}

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-masto-len-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
fs.mkdirSync(path.join(WS, 'data', 'plans', 'm'), { recursive: true });

try {
  const { mastodonLength, mastodonStatusLength, captionBlocker } = await import('../lib/caption.mjs');
  const LONG_URL = `https://pendpost.com/blog/${'a'.repeat(80)}`;
  ok(mastodonLength('a'.repeat(10)) === 10, 'plain text counts its characters');
  ok(mastodonLength(`see ${LONG_URL}`) === 4 + 23, 'an http(s) URL counts 23 whatever its length');
  ok(mastodonLength('go http://x.io now') === 3 + 23 + 4, 'a short http URL also counts 23');
  ok(mastodonLength('read https://pendpost.com/blog/x.') === 5 + 23 + 1, 'trailing sentence punctuation is not part of the URL');
  ok(mastodonLength('pendpost.com') === 12, 'a bare domain without a scheme counts as plain text');
  ok(mastodonLength('hi @alice@mastodon.social!') === '@alice'.length + 4, 'a remote mention counts as @user only');
  ok(mastodonLength('hi @bob') === 7, 'a local mention counts as written');
  ok(mastodonLength('👍🏽ok') === 3, 'characters are graphemes (a skin-toned emoji is one)');
  ok(mastodonLength('') === 0 && mastodonLength(null) === 0, 'empty text is 0');
  // Round 2: conservative. Mastodon (twitter-text) recognises fewer URLs than a loose
  // regex; undercounting near 500 means a 422 at publish, overcounting is the safe side.
  const glued = `xhttps://pendpost.com/${'g'.repeat(40)}`;
  ok(mastodonLength(glued) === glued.length, 'a link glued to a preceding word is plain text');
  ok(mastodonLength('see https://a.com/x*') === 4 + 23 + 1, 'a trailing * is not part of the link');
  for (const ch of ['*', '$', '%', '~', '&', '|', '@', '[', '(']) {
    ok(mastodonLength(`https://a.com/path${ch}`) === 23 + 1, `a trailing ${ch} counts as text`);
  }
  ok(mastodonLength('https://a.com/?q=') === 23, 'a trailing = stays in the link');
  ok(mastodonLength('https://en.wikipedia.org/wiki/Foo_(bar) end') === 23 + '(bar) end'.length, 'the link ends before a ( in its path');
  ok(mastodonLength('http://localhost/abc') === 'http://localhost/abc'.length, 'a host without a dotted name is plain text');
  ok(mastodonLength(`(https://pendpost.com/${'p'.repeat(40)})`) === 1 + 23 + 1, 'opening punctuation before a link is fine');
  ok(mastodonLength('=@alice@mastodon.social') === '=@alice@mastodon.social'.length, 'a mention glued to = is plain text');
  ok(mastodonLength('hi @a.b@mastodon.social') === 'hi @a.b@mastodon.social'.length, 'a mention the conservative rule does not recognise counts in full');
  ok(mastodonStatusLength('abc', 'cw!') === 6, 'the content warning adds its own length');
  const fits = `${'w'.repeat(400)} ${LONG_URL} ${LONG_URL}`; // 600+ raw, 400+1+23+1+23 = 448 counted
  ok(fits.length > 500 && mastodonLength(fits) === 448, `a 600+ raw-char draft with two links counts ${mastodonLength(fits)}`);
  ok(captionBlocker(fits, 'mastodon') === null, 'captionBlocker uses the Mastodon count');
  ok(/caps at 500/.test(captionBlocker('z'.repeat(501), 'mastodon') || ''), 'captionBlocker still refuses 501 counted characters');

  // ===== pre-flight and lint agree =====
  const over = 'q'.repeat(480) + ` ${LONG_URL}`; // 480 + 1 + 23 = 504
  fs.writeFileSync(path.join(WS, 'data', 'plans', 'active-plans.json'), JSON.stringify({ plans: [{ id: 'm', path: 'data/plans/m/post-plan.json', active: true }] }));
  fs.writeFileSync(path.join(WS, 'data', 'plans', 'm', 'post-plan.json'), JSON.stringify({
    campaign: 'm', timezone: 'UTC',
    posts: [
      { id: 'fits', type: 'text', platforms: ['mastodon'], caption: fits, scheduledAt: '2099-01-01T00:00:00Z', executionMode: 'fully-scheduled', status: 'planned', approval: 'draft' },
      { id: 'over', type: 'text', platforms: ['mastodon'], caption: over, scheduledAt: '2099-01-01T00:00:00Z', executionMode: 'fully-scheduled', status: 'planned', approval: 'draft' },
    ],
  }));
  const { platformValidate } = await import('../lib/writes.mjs');
  const { brandLint } = await import('../lib/lint.mjs');
  const probs = async (id) => (await platformValidate({ campaign: 'm', postId: id })).platforms.mastodon.problems;
  ok(!(await probs('fits')).some((p) => /chars - Mastodon caps/.test(p)), 'pre-flight: the link-heavy draft fits under Mastodon counting');
  const overProbs = await probs('over');
  ok(overProbs.some((p) => /is 504 chars - Mastodon caps at 500/.test(p)), `pre-flight: 504 counted characters are over (got ${JSON.stringify(overProbs)})`);
  ok(!brandLint({ text: fits, platform: 'mastodon' }).findings.some((f) => f.rule === 'caption-length'), 'brand-lint caption-length agrees: the draft fits');
  ok(brandLint({ text: over, platform: 'mastodon' }).findings.some((f) => f.rule === 'caption-length' && /^504 chars/.test(f.match)), 'brand-lint caption-length agrees: 504 is over');

  // ===== the engine counts the same way =====
  const engineSrc = fs.readFileSync(path.join(REPO, 'scripts', 'mastodon-social.mjs'), 'utf8');
  ok(/const combinedLen = \(post, text\) => mastodonStatusLength\(text, post\.spoilerText\)/.test(engineSrc), 'the Mastodon engine gate uses mastodonStatusLength');
} catch (e) {
  failures += 1;
  console.error('FAIL -', e.stack || e.message);
} finally {
  fs.rmSync(WS, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures} failed.`);
process.exit(failures ? 1 : 0);
