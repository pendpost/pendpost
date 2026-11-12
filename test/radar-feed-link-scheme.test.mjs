#!/usr/bin/env node
// test/radar-feed-link-scheme.test.mjs - security audit 2026-11. A feed item's <link> is author
// controlled. It becomes signal.url, which the Studio renders as a target=_blank link and the
// desktop shell hands to the OS. Only http(s) may survive; smb:, vscode:, file:, javascript: and
// custom schemes are dropped (radar_ingest applies the same rule).
import assert from 'node:assert';

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); console.log(`  ok - ${msg}`); pass += 1; };

const { parseFeed } = await import('../lib/radar-feed.mjs');
const rss = (link) => `<?xml version="1.0"?><rss><channel><title>t</title><item><title>a scheduler question</title><link>${link}</link><guid>g-${encodeURIComponent(link)}</guid><description>which tool do you use to schedule posts?</description></item></channel></rss>`;
const urlOf = (link) => { const out = parseFeed(rss(link), 'https://feed.example/rss'); const items = Array.isArray(out) ? out : (out && (out.items || out.signals)) || []; return items[0] ? items[0].url : undefined; };

try {
  ok(urlOf('https://blog.example/post/1') === 'https://blog.example/post/1', 'an https item link is kept');
  for (const bad of ['smb://198.51.100.7/share', 'vscode://file/etc/hosts', 'file:///System/Applications/Calculator.app', 'javascript:alert(1)', 'x-apple.systempreferences:com.apple.preference.security']) {
    ok(urlOf(bad) === null, `a ${bad.split(':')[0]}: item link is dropped`);
  }
  console.log(`[radar-feed-link-scheme] OK - only http(s) feed links become signal urls (${pass} assertions).`);
} catch (err) {
  console.error(`[radar-feed-link-scheme] FAIL: ${err.stack || err.message}`);
  process.exitCode = 1;
}
