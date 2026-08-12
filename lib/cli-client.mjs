// lib/cli-client.mjs - the hand-run guard for the standalone credential
// ceremonies in scripts/*-social.mjs (auth / connect / setup).
//
// THE PROBLEM. Those scripts read and write ONE client's data/clients/<id>/.env.
// When the daemon or MCP server spawns an engine it sets PENDPOST_ROOT to the
// caller's resolved client root, so the child roots at that client subtree (which
// has no clients.json) and envPath() lands on the right .env. But a bare hand-run
// from the repo shell (`node scripts/reddit-social.mjs auth`) sets NO PENDPOST_ROOT.
// The child then sees data/clients.json and activeRoot() (lib/context.mjs) falls to
// data/clients/<activeClientId>. With activeClientId=bondigoo, a ceremony meant for
// pendpost silently targets bondigoo's .env. The frozen `const ENV_PATH = envPath()`
// at module load bakes that wrong path in before any binding can help.
//
// THE GUARD. enforceCeremonyClient() runs at the top of each script's main(), for
// ceremony verbs only. It refuses to let a hand-run touch a client implicitly:
//   * an explicit --client <id> / PENDPOST_CLIENT_ID / --use-active-client is honored;
//   * otherwise, on a terminal it prints the resolved target + the global active
//     client and asks y/N before proceeding; with no terminal to ask on (piped, CI,
//     tests) it fails closed and refuses.
// It then RE-EXECS the whole process with PENDPOST_ROOT set to the chosen client
// root, so the frozen ENV_PATH (and every readEnv/writeEnv) resolves correctly in
// the child with zero changes to the engine bodies. The re-exec'd child roots at a
// client subtree (no clients.json), so readRegistry() is null and the guard is a
// no-op there - which is also exactly why every daemon/MCP spawn is untouched.
//
// SCOPE. Only credential-entry verbs are guarded. Every other engine verb
// (publish-due, probe, radar, refresh, ...) keeps its existing PENDPOST_ROOT /
// activeClientId resolution, so the daemon path and the whole test suite are
// unaffected. None of these guarded verbs are mockable, so the guard never
// interferes with the mock driver.

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { readRegistry, clientRoot, activeClientId } from './multi-client.mjs';

// The credential-entry ceremonies. Deliberately excludes `refresh` (machine-driven
// token rotation, always spawned with PENDPOST_ROOT, and mockable).
const CEREMONY_VERBS = new Set(['auth', 'connect', 'setup', 'setup-system-user']);

function banner(lines) {
  const bar = '='.repeat(60);
  process.stderr.write(`${bar}\n${lines.join('\n')}\n${bar}\n`);
}

function targetBanner({ lane, id, envFile, active }) {
  const mismatch = id !== active ? `   [!] differs from active client '${active}'` : '';
  banner([
    ' pendpost credential ceremony',
    `   lane            ${lane}`,
    `   target client   ${id}${mismatch}`,
    `   .env path       ${envFile}`,
    `   global active   ${active}`,
  ]);
}

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question(question)).trim();
    return /^y(es)?$/i.test(answer);
  } finally {
    rl.close();
  }
}

// Guard a ceremony run. Returns (proceed in this process) or exits / re-execs.
// argv is the parseArgs() result; command is argv._[0]; scriptUrl is import.meta.url.
export async function enforceCeremonyClient({ argv, command, lane, scriptUrl }) {
  if (!CEREMONY_VERBS.has(command)) return; // not a credential ceremony -> untouched
  const registry = readRegistry();
  if (!registry) return; // rooted at a specific client (daemon/MCP) or a legacy single workspace

  const active = activeClientId();
  const ids = Array.isArray(registry.clients)
    ? registry.clients.map((c) => c && c.id).filter(Boolean)
    : [];
  const avail = ids.join(', ') || '(none)';

  // `--client` with no value must never silently fall through to the active client.
  if (argv.client === true) {
    banner([` --client needs a client id. Available: ${avail}`]);
    process.exit(2);
  }

  let id = (typeof argv.client === 'string' && argv.client) || process.env.PENDPOST_CLIENT_ID || '';
  let explicit = Boolean(id);
  if (!id && argv['use-active-client']) { id = active; explicit = true; }

  if (!id) {
    // No explicit target on a multi-client workspace. Confirm interactively against
    // the active client; fail closed when there is no terminal to ask on.
    const envFile = path.join(clientRoot(active), '.env');
    targetBanner({ lane, id: active, envFile, active });
    if (!process.stdin.isTTY) {
      banner([
        ' No --client given and no terminal to confirm on.',
        ` Refusing so '${lane}' does not silently target '${active}'.`,
        ` Re-run with:  --client <id>   (available: ${avail})`,
      ]);
      process.exit(2);
    }
    const go = await confirm(`Proceed against ACTIVE client '${active}'? [y/N] `);
    if (!go) {
      process.stderr.write('Aborted. Re-run with --client <id>.\n');
      process.exit(2);
    }
    id = active;
  }

  // Validate slug + registry membership.
  let root;
  try {
    root = clientRoot(id);
  } catch {
    banner([` Invalid client id '${id}'. Available: ${avail}`]);
    process.exit(2);
  }
  if (ids.length && !ids.includes(id)) {
    banner([` Unknown client '${id}'. Available: ${avail}`]);
    process.exit(2);
  }

  const envFile = path.join(root, '.env');
  if (explicit) targetBanner({ lane, id, envFile, active });

  // Already rooted at exactly this client (PENDPOST_ROOT set by hand to it)? proceed.
  if (path.resolve(process.env.PENDPOST_ROOT || '') === path.resolve(root)) return;

  // Re-root the WHOLE process at the target client so the module-load
  // `const ENV_PATH = envPath()` and every readEnv/writeEnv resolve there.
  const self = fileURLToPath(scriptUrl);
  const res = spawnSync(process.execPath, [self, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, PENDPOST_ROOT: root },
  });
  process.exit(res.status == null ? 1 : res.status);
}
