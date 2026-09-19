#!/usr/bin/env node
// test/engage-keychain.test.mjs - guards the ONE launch flag every browser lane depends on.
//
// Playwright launches Chromium with a default arg list that includes --use-mock-keychain. On
// macOS that makes the launched Chrome derive its cookie-encryption key from an in-memory mock,
// not the real "Chrome Safe Storage" login-keychain item. So a profile whose session was written
// by the owner's real Chrome (the login ceremony, or a `connect` copy) reads back logged-out on
// every browser lane. lib/engage-browser.mjs removes exactly that one default arg via the child's
// --config file. If a refactor ever drops that, every browser lane silently stops working - so
// this asserts it directly, at the two layers a regression could hit.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let failures = 0;
const ok = (c, m) => { if (c) { pass += 1; console.log(`  ok - ${m}`); } else { failures += 1; console.error(`  FAIL - ${m}`); } };

const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-engage-keychain-'));
process.env.PENDPOST_ROOT = WS;
process.env.PENDPOST_MODE = 'mock';
process.env.HOME = WS;

try {
  const { writeBrowserLaunchConfig, BROWSER_LAUNCH_CONFIG, browserMcpServers, playwrightMcpArgv, seedProfileFromChrome, browserProfileDir } = await import('../lib/engage-browser.mjs');

  const p = writeBrowserLaunchConfig();
  ok(fs.existsSync(p), 'writeBrowserLaunchConfig writes the launch config file');
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  const ignored = cfg.browser && cfg.browser.launchOptions && cfg.browser.launchOptions.ignoreDefaultArgs;
  ok(Array.isArray(ignored) && ignored.includes('--use-mock-keychain'),
    'the launch config drops --use-mock-keychain, so the launched Chrome uses the real macOS Keychain key and a copied session decrypts');
  assert.deepStrictEqual(BROWSER_LAUNCH_CONFIG.browser.launchOptions.ignoreDefaultArgs, ['--use-mock-keychain']);
  ok(true, 'and the constant it comes from is exactly that one arg, nothing wider (dropping more default args could weaken the sandbox)');

  const flat = JSON.stringify(browserMcpServers({ clientId: 'acme' }));
  ok(flat.includes('--config'), 'the child mcp-config passes --config so the launch config reaches the browser');
  const argv = playwrightMcpArgv({ profileDir: '/tmp/p', configPath: '/tmp/cfg.json' });
  const i = argv.indexOf('--config');
  ok(i !== -1 && argv[i + 1] === '/tmp/cfg.json', 'playwrightMcpArgv threads the config path through when given one');
  ok(playwrightMcpArgv({ profileDir: '/tmp/p' }).indexOf('--config') === -1, 'and omits it when none is given (pure, testable)');

  // The SingletonLock guard must see Chrome's DANGLING symlink (existsSync follows the link and
  // returns false, which is why the guard uses lstat). Plant a dangling link and expect a refusal.
  const src = path.join(WS, 'src-profile');
  fs.mkdirSync(src, { recursive: true });
  const dest = browserProfileDir('locktest');
  fs.mkdirSync(dest, { recursive: true });
  fs.symlinkSync('some-host.local-99999', path.join(dest, 'SingletonLock')); // target does not exist
  const locked = seedProfileFromChrome({ clientId: 'locktest', sourceProfileDir: src });
  ok(locked.ok === false && /open right now/.test(locked.message || ''),
    'seeding refuses while the profile is open - it sees Chrome\'s dangling SingletonLock via lstat, not existsSync');
} catch (err) {
  failures += 1;
  console.error(`  FAIL - threw: ${err && err.stack ? err.stack : err}`);
}

fs.rmSync(WS, { recursive: true, force: true });
console.log(`\nengage-keychain: ${pass} checks passed${failures ? `, ${failures} FAILED` : ''}`);
if (failures) process.exit(1);
assert.ok(pass > 0);
