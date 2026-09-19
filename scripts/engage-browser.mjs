#!/usr/bin/env node
// scripts/engage-browser.mjs - the "Respond for me" BROWSER LOGIN CEREMONY (spec 50 P4, §8 L3).
//
// WHAT THIS IS FOR. The L3 executor drives the SYSTEM Chrome against a pendpost-owned
// persistent profile at ~/.pendpost/browser/<clientId>/. That profile starts empty, so every
// browser lane (hackernews, x, linkedin, instagram, quora) is `not_logged_in` until a human has
// signed in inside it ONCE. This is that once.
//
// WHAT IT DELIBERATELY DOES NOT DO. It never reads, prints, types, pastes or stores a
// credential. It opens Chrome on the lane's login page, hands the keyboard to the OWNER, and
// waits for them to press Enter when they are done. Then it runs the same read-only identity
// probe the engine runs before every batch and prints the handle it saw. pendpost's side of the
// ceremony is: open a window, wait, look. Everything a password touches happens between the
// owner and the platform, in a window pendpost is not typing into.
//
// WHY IT LAUNCHES CHROME DIRECTLY RATHER THAN THROUGH @playwright/mcp. The MCP server is the
// CHILD's tool; a ceremony that went through it would put an agent between the owner and a
// login form, which is the one place this feature must never put one. This is a plain
// `spawn(chrome, ['--user-data-dir=<profile>', <loginUrl>])`: the owner's own hands, in a real
// Chrome, on the real page, in the profile the executor will later reuse. Zero-dep, no
// Playwright import, no automation flags.
//
// USAGE (an explicit --client is REQUIRED; there is no implicit "active client" here, because
// the thing being armed is a real account on a real platform):
//   node scripts/engage-browser.mjs login  --client <id> --lane <lane>
//   node scripts/engage-browser.mjs status --client <id> [--lane <lane>]
import { spawn } from 'node:child_process';
import { logLine } from '../lib/util.mjs';
import { enforceCeremonyClient } from '../lib/cli-client.mjs';
import { promptLine, isInteractive } from '../lib/cli-prompt.mjs';

// The same three-line argv reader every scripts/*-social.mjs carries. Copied rather than
// shared because lib/cli-client.mjs re-execs this process and expects the SAME shape
// (`argv.client`, `argv._[0]`) the other ceremonies hand it.
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) args[key] = true;
      else args[key] = argv[++i];
    } else args._.push(a);
  }
  return args;
}

const USAGE = `pendpost "Respond for me" browser ceremony (spec 50 P4)

  node scripts/engage-browser.mjs connect --client <id> [--profile "<name>"] [--indexeddb]
  node scripts/engage-browser.mjs login   --client <id> --lane <lane>
  node scripts/engage-browser.mjs status  --client <id> [--lane <lane>]

connect Reuses the accounts you are ALREADY signed into in your real Chrome. Pick one of your
        Chrome profiles and pendpost copies its session (read-only) into its own profile, so
        every logged-in lane is ready at once with no per-lane sign-in. It never reads, prints
        or stores a cookie value, and never touches your own Chrome. Confirm each lane in the
        Studio afterwards. --indexeddb also copies IndexedDB (larger; only if a lane needs it).
login   Opens the lane's sign-in page in pendpost's OWN Chrome profile, waits for you to sign
        in by hand, then runs the read-only identity check and prints the handle it saw.
        pendpost never types, reads or stores your password.
status  Prints the Chrome bridge check and every browser platform's current state.
`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

// The ceremony arms ONE account on ONE platform. Guessing which project that is from the
// globally active client is exactly the mistake lib/cli-client.mjs exists to prevent, so this
// refuses rather than defaulting.
function requireClient(args) {
  const id = typeof args.client === 'string' ? args.client.trim() : '';
  if (id) return id;
  fail('This ceremony signs a real account in for one project, so it needs an explicit --client <id>. It will never guess from the active client.\n\n' + USAGE);
  return null;
}

async function cmdLogin(args, mod) {
  const {
    BROWSER_IDENTITY, browserProfileDir, chromeExecutable, checkBrowserBridge,
    probeBrowserLane, laneLoginUrl,
  } = mod;
  const clientId = requireClient(args);
  if (!clientId) return;
  const lane = typeof args.lane === 'string' ? args.lane.trim().toLowerCase() : '';
  if (!BROWSER_IDENTITY[lane]) {
    fail(`--lane must be one of: ${Object.keys(BROWSER_IDENTITY).join(', ')}`);
    return;
  }

  const bridge = checkBrowserBridge({ clientId, force: true });
  if (!bridge.ok) { fail(bridge.detail); return; }
  const chrome = chromeExecutable();
  const profileDir = browserProfileDir(clientId);
  const loginUrl = laneLoginUrl(lane);

  process.stdout.write([
    '',
    `Signing ${clientId} in on ${lane}.`,
    '',
    `  Chrome    ${chrome}`,
    `  Profile   ${profileDir}`,
    `  Page      ${loginUrl}`,
    '',
    'A Chrome window is opening on that page. It uses pendpost\'s own profile, not your normal',
    'Chrome profile, so nothing you do here touches your own browser, bookmarks or sessions.',
    'Sign in by hand. pendpost is not typing anything into that window and never will.',
    '',
  ].join('\n'));

  // detached + unref: the ceremony's own process must not hold the window open, and the window
  // must not die when the ceremony finishes. stdio ignored so Chrome's chatter stays off the
  // ceremony's own output.
  let child = null;
  try {
    child = spawn(chrome, [`--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', loginUrl], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch (err) {
    fail(`Chrome could not be started: ${err?.message || err}`);
    return;
  }

  if (!isInteractive()) {
    process.stdout.write('There is no terminal to wait on, so the window is open and this is where the ceremony stops.\nSign in, close the window, then run this command again on a terminal (or run `status`) to check the handle.\n');
    return;
  }
  await promptLine('When you are signed in, close the Chrome window and press Enter here: ');

  process.stdout.write('\nChecking which account that profile is signed in as. This opens a second, read-only window.\n');
  const verdict = await probeBrowserLane({ lane, clientId });
  printLaneLine(lane, verdict);
  if (verdict && verdict.handleSeen && verdict.reason === 'confirm_handle') {
    process.stdout.write(`\nConfirm it in the Studio (the platform row asks "Is @${verdict.handleSeen} the ${clientId} account?"),\nor from an agent: engage_confirm_handle { lane: "${lane}", ok: true }.\n`);
  }
}

async function cmdConnect(args, mod) {
  const {
    discoverChromeProfiles, seedProfileFromChrome, chromeUserDataRoot,
    checkBrowserBridge, probeBrowserLane, BROWSER_LANES,
  } = mod;
  const clientId = requireClient(args);
  if (!clientId) return;

  const bridge = checkBrowserBridge({ clientId, force: true });
  if (!bridge.ok) { fail(bridge.detail); return; }

  const profiles = discoverChromeProfiles();
  if (!profiles.length) {
    fail(`No Chrome profiles were found under ${chromeUserDataRoot()}. Sign into your accounts in Chrome first, or set PENDPOST_CHROME_USER_DATA_DIR.`);
    return;
  }

  // Pick the source profile: --profile by name/email, else the single one, else prompt.
  const asked = typeof args.profile === 'string' ? args.profile.trim().toLowerCase() : '';
  let chosen = null;
  if (asked) {
    chosen = profiles.find((p) => p.name.toLowerCase() === asked || (p.email && p.email.toLowerCase() === asked)) || null;
    if (!chosen) { fail(`No Chrome profile matches "${args.profile}". Available: ${profiles.map((p) => p.name + (p.email ? ` (${p.email})` : '')).join(', ')}`); return; }
  } else if (profiles.length === 1) {
    chosen = profiles[0];
  } else {
    process.stdout.write('\nWhich Chrome profile is signed into your accounts?\n\n');
    profiles.forEach((p, i) => process.stdout.write(`  ${i + 1}. ${p.name}${p.email ? `  (${p.email})` : ''}${p.hasCookies ? '' : '  [no session found]'}\n`));
    if (!isInteractive()) {
      process.stdout.write(`\nNo terminal to choose on. Re-run with --profile "<name>", e.g. --profile "${profiles[0].name}".\n`);
      return;
    }
    const ans = (await promptLine('\nProfile number (or name): ')).trim().toLowerCase();
    const byNum = Number(ans);
    chosen = (Number.isInteger(byNum) && byNum >= 1 && byNum <= profiles.length)
      ? profiles[byNum - 1]
      : profiles.find((p) => p.name.toLowerCase() === ans || (p.email && p.email.toLowerCase() === ans)) || null;
    if (!chosen) { fail('That did not match a profile. Nothing was copied.'); return; }
  }

  const stores = args.indexeddb === true ? ['Cookies', 'Local Storage', 'IndexedDB'] : undefined;
  process.stdout.write(`\nCopying the session from Chrome profile "${chosen.name}"${chosen.email ? ` (${chosen.email})` : ''} into ${clientId}'s pendpost profile.\nThis is a read-only copy of your Chrome; it does not change your own browser, and no password or cookie value is read or printed.\n`);

  const res = seedProfileFromChrome({ clientId, sourceProfileDir: chosen.dir, stores });
  if (!res.ok) { fail(res.message || 'connect failed'); return; }
  process.stdout.write(`\n  Copied     ${res.copied.join(', ')}${res.skipped.length ? `\n  Not found  ${res.skipped.join(', ')}` : ''}\n  Profile    ${res.dest}\n`);

  process.stdout.write('\nChecking which lanes that session signs you into (read-only, one window per lane).\n\n');
  for (const lane of BROWSER_LANES) {
    try {
      const verdict = await probeBrowserLane({ lane, clientId });
      printLaneLine(lane, verdict);
    } catch (err) {
      process.stdout.write(`  ${lane.padEnd(12)} could not check (${err?.message || err})\n`);
    }
  }
  process.stdout.write([
    '',
    'For every lane that showed a handle, confirm it in the Studio (the platform row asks',
    `"Is @<handle> the ${clientId} account?"), then flip Radar automation to Live.`,
    'A lane that showed "not signed in" needs the one-time login instead:',
    `  node scripts/engage-browser.mjs login --client ${clientId} --lane <lane>`,
    '',
  ].join('\n'));
}

function printLaneLine(lane, rt) {
  const label = {
    ready: 'ready',
    confirm_handle: 'a handle was seen, and it still needs confirming',
    wrong_account: 'signed in as the wrong account',
    not_logged_in: 'not signed in',
    checking: 'not checked yet',
    cooling_down: 'cooling down after repeated failures',
    no_credential: 'no credential',
  }[rt && rt.reason] || (rt && rt.reason) || 'unknown';
  const handle = rt && rt.handleSeen ? ` (@${rt.handleSeen})` : '';
  process.stdout.write(`  ${lane.padEnd(12)} ${label}${handle}\n`);
  if (rt && rt.detail) process.stdout.write(`  ${' '.repeat(12)} ${rt.detail}\n`);
}

async function cmdStatus(args, mod) {
  const { BROWSER_IDENTITY, checkBrowserBridge, browserProfileDir, loginCommandFor } = mod;
  const { laneRuntimeFor } = await import('../lib/engage.mjs');
  const clientId = requireClient(args);
  if (!clientId) return;
  const only = typeof args.lane === 'string' ? args.lane.trim().toLowerCase() : '';

  const bridge = checkBrowserBridge({ clientId, force: true });
  process.stdout.write([
    '',
    `Browser executor for ${clientId}`,
    `  Chrome    ${bridge.chromePath || 'not found'}`,
    `  Profile   ${browserProfileDir(clientId)}`,
    `  Bridge    ${bridge.ok ? 'ok' : 'blocked'} - ${bridge.detail}`,
    '',
    'Platforms',
  ].join('\n') + '\n');

  for (const lane of Object.keys(BROWSER_IDENTITY)) {
    if (only && lane !== only) continue;
    const rt = laneRuntimeFor(lane);
    printLaneLine(lane, rt);
    if (!rt || rt.reason === 'not_logged_in' || rt.reason === 'checking') {
      process.stdout.write(`  ${' '.repeat(12)} Run: ${loginCommandFor(lane, clientId)}\n`);
    }
  }
  process.stdout.write('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const command = args._[0];
  if (!command || command === 'help' || args.help === true) {
    process.stdout.write(USAGE);
    return;
  }
  if (command !== 'login' && command !== 'status' && command !== 'connect') {
    fail(`Unknown command "${command}".\n\n${USAGE}`);
    return;
  }
  // Re-roots the process at the named client (and refuses an unknown one), exactly like every
  // other hand-run ceremony, so ~/.pendpost/browser/<clientId> and the client's own config and
  // state all resolve to the same project.
  await enforceCeremonyClient({ argv: args, command, lane: 'engage-browser', scriptUrl: import.meta.url });

  // Imported AFTER the re-exec guard: lib/engage-browser.mjs resolves the active client at
  // module scope through activeClientId(), and the guard's whole job is to fix that first.
  const mod = await import('../lib/engage-browser.mjs');
  try {
    if (command === 'login') await cmdLogin(args, mod);
    else if (command === 'connect') await cmdConnect(args, mod);
    else await cmdStatus(args, mod);
  } catch (err) {
    logLine('error', `engage-browser ${command}: ${err?.message || err}`);
    fail(`${command} failed: ${err?.message || err}`);
  }
}

main();
