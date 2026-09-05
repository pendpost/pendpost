// agent-runner.mjs - spawn the OPERATOR'S OWN agent CLI and let it do the judging
// (spec 41). Zero-dep, and deliberately at lib/radar.mjs's layer: lib/writes.mjs imports
// this, so this must NEVER import writes.mjs (that cycle is why lib/radar-sweep.mjs
// exists as its own module).
//
// THE INVARIANT THIS PRESERVES: pendpost still never constructs a model API call
// (spec 39). All intelligence and all cost live in the spawned CLI, running on the
// OPERATOR's subscription. What changed vs spec 39's posture is narrower than it looks:
// pendpost now HOLDS a CLI credential, but it still never CALLS a model with it - it
// hands it to the operator's own binary and gets out of the way.
//
// EVERY flag, value and failure mode below was proven against claude v2.1.201 on
// 2026-07-15 (spec 41 §8 step 1), not read off --help. Three things --help would have
// told you wrong; see PROVEN, below.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnv, mcpUrl } from './util.mjs';
import { activeRoot } from './context.mjs';

// ---------------------------------------------------------------------------
// PROVEN (2026-07-15, claude v2.1.201, against the live daemon + a recording proxy):
//
//  1. `--tools <list>` restricts the BUILT-IN set and, when passed at all, HIDES EVERY
//     MCP TOOL from the model - including the radar_ingest this feature exists to call.
//     The child reports "I don't have a pendpost_health tool available". Naming the MCP
//     tool in --tools does not help (it only accepts built-in names). So --tools is NOT
//     passed. Spec 41 §4.3's `--tools WebSearch,WebFetch` would have shipped a feature
//     that silently cannot work.
//  2. `--allowed-tools` + `--permission-mode dontAsk` IS a real, enforced fence, and is
//     therefore the WHOLE containment story now that --tools is gone. Proven by making a
//     child try to run Bash: it was denied, the attempt was recorded in the envelope's
//     `permission_denials`, and the canary file was never written. Unlisted tools are
//     DENIED, not prompted - `dontAsk` means "deny if not pre-approved", which is exactly
//     what a headless child with no human to answer needs. (`default`, which the spec
//     asked for, means "prompt for dangerous operations" - wrong here.)
//  3. The result envelope carries NO record of which tools were called. `is_error:false`
//     and a cheerful "OK" are both perfectly consistent with the child having called
//     NOTHING. Detecting "the tool call landed" therefore cannot be done from the
//     envelope at all - it needs a server-side witness (see witnessAgentTool()).
//     A model answering "OK" having called nothing is not hypothetical: it is what
//     happened on the first run of this probe.
//  4. The exit code is 0 even on `Not logged in`. Exit code proves nothing.
//  5. The child's auth refusal ("Not logged in · Please run /login") arrives on STDOUT,
//     not stderr - unlike every lane engine, whose probe detail comes off stderr.
//  6. The child waits 3s for stdin unless it is closed. stdio[0] must be 'ignore'.
// ---------------------------------------------------------------------------

// A research job is bounded by TIME and by maxPerRun, not by a config knob: a timeout is
// a safety property, and a safety property an agent could widen is not one.
// 15 minutes (L6, audit 2026-08-31: raised from 600s - live runs sat chronically at
// 580-600s and two died at exactly the old bound with exit 143 / reason timeout; the
// successful 2026-08-31 run had 19s of headroom). Still a hard safety cap, still not a
// config knob - a timeout an agent could widen is not a safety property.
const AGENT_TIMEOUT_MS = 900_000;
const PROBE_TIMEOUT_MS = 120_000;

// THE PER-LANE BUDGET FOLLOWS THE WORK (incident 2026-09-04, bondigoo). A manual scan isolates
// one research spawn per agent-found source, and the hard cap used to be divided evenly:
// 5 lanes -> 180s each, whatever the queries. When the saved queries grew from 4 to 7 every lane
// child was told to research all seven in three minutes, tried to fan out to subagents it does
// not have, and died at its slice: five timeouts, accepted 0, 15 minutes of operator spend for
// nothing. What one lane needs scales with the QUERY COUNT, so the planner starts from that:
//   need = max(AGENT_LANE_MIN_MS, queries x AGENT_LANE_MS_PER_QUERY)
// then packs the lanes into as many spawns as fit under AGENT_TIMEOUT_MS (spawns = cap / need).
// The cap stays the hard per-spawn safety bound AND the bound on the whole job: the packed
// spawns never sum past it, so a manual scan still finishes (or is stale-repaired) on the same
// clock as before. When not even two spawns fit, the scan is ONE combined spawn at the cap,
// exactly the shape the scheduler runs daily in ~5 minutes.
// 60s per query per lane is the measured order: on 2026-09-04 the lanes that DID finish four
// queries did so inside their 180s slice, and the two that died were the search-heavy ones.
const AGENT_LANE_MS_PER_QUERY = 60_000;
const AGENT_LANE_MIN_MS = 120_000;

/**
 * Plan the research spawns for one radar agent scan.
 * @param {object} p
 * @param {string} p.actor - who asked; kept for the caller's symmetry, NOT a packing input (see below).
 * @param {string[]} p.scanLanes - the agent-found sources to research.
 * @param {number} p.queryCount - how many saved queries every lane child must cover.
 * @param {number} [p.timeoutMs] - the hard cap (tests only; production passes nothing).
 * @returns {{ lanes: string[][], perLaneMs: number }} lanes = one entry per spawn.
 */
// THE SCHEDULER PACKS LIKE A MANUAL RUN (Wave 1 R1, 2026-09-04). The daily path used to force ONE
// combined spawn so the "1 job/day" budget label could not hide N spawns. But the budget counts
// JOBS (agentJobsToday reads rows, and a packed job is still one row), so the exception only
// bought the scheduled run the exact failure mode the packing fixes: every lane crammed into one
// child at the cap, dying at the cap. `actor` is accepted and ignored on purpose, so a caller
// that still passes it keeps compiling and the daily budget keeps counting jobs unchanged.
export function planAgentScanLanes({ actor, scanLanes, queryCount, timeoutMs = AGENT_TIMEOUT_MS } = {}) {
  void actor;
  const sources = Array.isArray(scanLanes) ? scanLanes.filter(Boolean) : [];
  if (sources.length <= 1) return { lanes: [sources], perLaneMs: timeoutMs };
  const n = Number.isInteger(queryCount) && queryCount > 0 ? queryCount : 1;
  const need = Math.max(AGENT_LANE_MIN_MS, n * AGENT_LANE_MS_PER_QUERY);
  const spawns = Math.max(1, Math.min(sources.length, Math.floor(timeoutMs / need)));
  if (spawns === 1) return { lanes: [sources], perLaneMs: timeoutMs };
  // Pack contiguously so the lane order (and thus which lane carries the GEO fold) is stable.
  const per = Math.ceil(sources.length / spawns);
  const lanes = [];
  for (let i = 0; i < sources.length; i += per) lanes.push(sources.slice(i, i + per));
  return { lanes, perLaneMs: Math.floor(timeoutMs / lanes.length) };
}
 // the liveness probe is one trivial turn; it must not hang for 10 min

// THE COMPUTER MUST STAY AWAKE FOR THE CHILD (incident 2026-09-02..04, three daily scans in a
// row dead with exit 143 / reason timeout / accepted 0). pmset's log told the story the job rows
// could not: the MacBook was ASLEEP at the scheduled hour and only surfaced for 45-180 second
// Power Nap "DarkWake" maintenance windows every ~16 minutes. The scheduler tick fired inside
// one window, spawned the child, and 60-100 seconds later the machine went back to sleep with
// the child mid-request ("API Error: Your computer went to sleep mid-response"). The 15-minute
// kill timer then fired on the NEXT wake window. Nothing was slow, nothing was stuck on auth:
// the child simply never got fifteen contiguous awake minutes.
//
// So while a child runs, pendpost holds a system-sleep assertion through the OS's own tool:
// `caffeinate -i -s -w <child pid>`. -s (PreventSystemSleep) is the one assertion macOS honours
// FROM a dark wake, and it is honoured only on AC power - on battery the OS still sleeps, and
// the honest report below is all pendpost can do. -w releases the assertion the moment the child
// exits, so there is nothing to clean up and nothing that can outlive the job. Fail-soft: no
// caffeinate (Linux, an unusual install) => the job runs exactly as before.
//
// And because a sleeping computer cannot be told apart from a stuck child by looking at stdout,
// a 5-second heartbeat measures wall-clock jumps: a tick that arrives 30+ seconds late is the
// process having been frozen. That total is reported as `sleptMs` and, on a timeout, becomes the
// job's detail - the operator reads "the computer slept" instead of "ran too long".
const HEARTBEAT_MS = 5_000;
const SLEEP_GAP_MIN_MS = 30_000;
export const KEEP_AWAKE_BIN_VAR = 'PENDPOST_KEEP_AWAKE_BIN';
const KEEP_AWAKE_DEFAULT_BIN = '/usr/bin/caffeinate';
const KILL_GRACE_MS = 5_000;      // SIGTERM, then SIGKILL - a child that ignores TERM still dies
const STDOUT_CAP = 4 * 1024 * 1024;
const STDERR_CAP = 64 * 1024;     // we only ever surface `tail`; keeping more just costs memory
export const AGENT_TAIL_MAX = 500; // spec 41 §4.5

// The agent's closing line is rendered in pendpost's own UI, so it lands under pendpost's own copy
// rules - and "no em dashes" is a Tier 1 rule here, not a preference. A model writes them freely, so
// a real tail arrived reading "(all Hacker News — Reddit/Mastodon searches...)" and put one on screen.
//
// This normalizes TYPOGRAPHY only, and that is the whole line it must not cross: an em dash becomes
// the house " - " and nothing else changes. The words stay the agent's own, verbatim, because the
// tail exists precisely so the operator reads what the agent actually said.
export const normalizeTail = (text) => String(text || '').replace(/\s*[—–]\s*/g, ' - ');

// A usage-limit refusal ("You've hit your weekly limit · resets 5am") exits non-zero and used
// to classify as a generic 'exit' - "your agent exited unexpectedly", which is wrong twice: the
// exit is neither unexpected nor a crash, and the operator's recovery (wait for the reset, or
// retry later) is nothing like a crash's. This pattern is CONSERVATIVE on purpose: it matches
// the stable words of quota refusals across CLI versions, and anything it misses falls back to
// today's 'exit' - a silent no-regression path, never a wrong 'limit'. Deliberately no bare
// "429" (URLs and ids false-positive) and no parsing of the free-text reset time (CLI-version-
// dependent prose; the operator reads it verbatim in the labeled tail).
export const AGENT_LIMIT_RE = /\b(usage|weekly|session|daily|5-hour)\s+limit\b|\brate.?limit/i;

// The child's PATH is BUILT, never inherited. Under launchd the daemon's PATH is
// /usr/bin:/bin:/usr/sbin:/sbin (verified) - no Homebrew - so an inherited PATH would
// leave `claude` unable to find git/rg and would have made resolveAgentBin fail outright.
const AGENT_PATH_DIRS = Object.freeze([
  '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
]);

// THE REGISTRY IS THE FENCE. A config can only ever name a KEY of this frozen object;
// pendpost maps that id to a fixed bin + argv from here. pendpost NEVER executes a
// command string that came from config - that is why `provider` is an enum id and not a
// path, and it is the same reason the deleted autoScan was parameters-only.
export const AGENT_PROVIDERS = Object.freeze({
  'claude-code': Object.freeze({
    label: 'Claude Code',
    bin: 'claude',
    // Ordered candidates FIRST, PATH last: under launchd the candidates are the only
    // thing that works, and in a dev shell they resolve identically. (lib/writes.mjs:117
    // reaches for process.execPath for this same reason - but that only works for a node
    // script; an agent provider is a foreign binary, so it needs its own resolution.)
    binCandidates: Object.freeze([
      '/opt/homebrew/bin/claude',
      '/usr/local/bin/claude',
      path.join(os.homedir(), '.local/bin/claude'),
      path.join(os.homedir(), '.claude/local/claude'),
    ]),
    // The OPERATOR runs this in their own terminal; pendpost never runs it for them.
    authCmd: 'claude setup-token',
    // Whichever the owner stored via the ceremony. Injected into the CHILD's env only,
    // first match wins - never two credentials, never read back by any tool or route.
    credentialVars: Object.freeze(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY']),
    argv: ({ prompt, mcpConfigPath, allowedTools, model, stream }) => ([
      // -p FIRST: --allowed-tools/--mcp-config are variadic (<tools...>), so a trailing
      // positional prompt would be swallowed as another value.
      '-p', prompt,
      '--mcp-config', mcpConfigPath,
      // The operator's own claude config may connect servers that send email or move
      // files. A research child must never inherit them.
      '--strict-mcp-config',
      // The fence. In -p mode with dontAsk, every unlisted tool is DENIED (proven).
      '--allowed-tools', allowedTools.join(','),
      // Belt to the allow-list's braces (Wave 1 R2, 2026-09-04): the CLI's built-in Agent/Task
      // tools spawn SUBAGENTS, and a research child that tries to fan out has already lost the
      // lane (incident 2026-09-04: "tried to fan out to subagents it does not have, and died at
      // its slice"). The allow-list denies them; naming them here denies them by NAME as well,
      // so a future CLI that treats built-ins as implicitly allowed still cannot delegate.
      // Flag name verified 2026-09-04: `claude --help` prints `--disallowedTools, --disallowed-tools <tools...>`.
      '--disallowed-tools', 'Agent,Task',
      '--permission-mode', 'dontAsk',
      // stream-json emits one NDJSON event per line (assistant turns carry tool_use blocks,
      // the closing `result` event carries the same envelope fields as plain json). --verbose
      // is REQUIRED with it in -p mode - the CLI refuses the pair without it (proven
      // 2026-07-20, v2.1.201: "Error: When using --print, --output-format=stream-json
      // requires --verbose"). Plain json stays the default for the probe and any caller
      // that does not ask to observe.
      ...(stream ? ['--output-format', 'stream-json', '--verbose'] : ['--output-format', 'json']),
      // Spec C: an OPTIONAL model override. Only the DRAFT spawn passes one (drafting a reply is
      // light; research keeps the operator's default). Absent -> whatever the operator's CLI
      // defaults to, exactly as before. pendpost still never constructs a model API call.
      ...(model ? ['--model', String(model)] : []),
    ]),
    verified: '2026-07-15 (claude v2.1.201: proven end-to-end - a launchd-PATH child with the token in its env landed a real pendpost tools/call, and a Bash escalation attempt was denied and recorded)',
  }),
  // UNVERIFIED. Present so the shape is provider-agnostic, and REFUSED at config-set time
  // until a maintainer confirms the headless + MCP flags against the real binary. Guessing
  // a CLI flag is how a feature ships broken for everyone who is not the author - which is
  // precisely what --tools would have done above.
  'gemini-cli': Object.freeze({ label: 'Gemini CLI', bin: 'gemini', binCandidates: Object.freeze([]), credentialVars: Object.freeze([]), argv: null, verified: null }),
  codex: Object.freeze({ label: 'OpenAI Codex CLI', bin: 'codex', binCandidates: Object.freeze([]), credentialVars: Object.freeze([]), argv: null, verified: null }),
});

export const AGENT_PROVIDER_IDS = Object.freeze(Object.keys(AGENT_PROVIDERS));
// A provider is only offerable once someone has PROVEN its flags. isRadarAgent refuses
// the others at the door rather than letting a config name a spawn that cannot work.
export const isSupportedProvider = (id) => Boolean(AGENT_PROVIDERS[id]?.argv && AGENT_PROVIDERS[id]?.verified);

// The child's tool surface. WebSearch/WebFetch because without web tools the child could
// only re-run the regex engine and ingest its output - the exact dead end spec 41 deletes.
// radar_ingest because that is the one thing it is here to do. Nothing else: the child
// reads UNTRUSTED external threads, and a child holding pendpost's full ~96-tool surface
// could be talked into plan_delete_post by a Reddit comment. This list IS the enforcement,
// not a hint.
export const AGENT_SCAN_TOOLS = Object.freeze(['WebSearch', 'WebFetch', 'mcp__pendpost__radar_ingest']);
// The probe needs exactly one read, and must not be able to write anything at all.
export const AGENT_PROBE_TOOLS = Object.freeze(['mcp__pendpost__pendpost_health']);
// Spec 42 phase 2: the child that WRITES the replies. Deliberately NO web tools - it is handed the
// thread text as data and has nothing left to look up on the web, and a child that can fetch is a
// child that can be TOLD what to fetch by the thread it is reading. Deliberately no radar_ingest
// either: phase 2 reports nothing new.
// L1 (audit 2026-08-31): plus the two READ-ONLY lookups live tails showed it dead-ending without -
// radar_list (re-read a cached signal's fields when the brief's excerpt is not enough) and
// config_get (posting.radar context: campaign/threshold questions it otherwise guesses at). Both
// are in lib/mcp.mjs READ_TOOL_NAMES (readOnlyHint:true); the write surface stays exactly
// radar_queue_reply, and the draft fence + below_threshold gate hold regardless of what it reads.
export const AGENT_DRAFT_TOOLS = Object.freeze(['mcp__pendpost__radar_queue_reply', 'mcp__pendpost__radar_list', 'mcp__pendpost__config_get']);
// Spec 42 §7: the comparison-page drafter. Its own tool, NOT plan_create_post - see radarDraftComparison.
export const AGENT_COMPARISON_TOOLS = Object.freeze(['mcp__pendpost__radar_draft_comparison']);
// The GEO / AI-answer-visibility check (KI-Sichtbarkeit): the child asks each buying question of its
// own model access and reports back with radar_footprint_log. Web tools so it can verify a live
// answer; footprint_log is a LOCAL state append (no publish, no reach), the only write it gets. Used
// both folded into a scan (added to the scan child's tools when questions exist) and on its own for
// the per-card recheck (scope:'geo').
export const AGENT_GEO_TOOLS = Object.freeze(['WebSearch', 'WebFetch', 'mcp__pendpost__radar_footprint_log']);
// The agent-lane FOLLOW-UP reader (engagement engine, owner decision 4): the child re-reads
// the public threads our x/youtube/nostr replies sit in and reports evidence through
// radar_followup_report - web tools to read, ONE fenced local-state write to report, nothing
// else. It reads UNTRUSTED threads, so the report tool is evidence-gated server-side and
// inert outside the follow-up fence below.
export const AGENT_FOLLOWUP_TOOLS = Object.freeze(['WebSearch', 'WebFetch', 'mcp__pendpost__radar_followup_report']);

export const agentBinEnvVar = (id) => `PENDPOST_AGENT_BIN_${String(id).toUpperCase().replace(/-/g, '_')}`;

function isExecutable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile(); } catch { return false; }
}

// A zero-dep PATH walk. Deliberately NOT `which`: which is itself a PATH lookup, so under
// launchd it would fail for the same reason we are here.
function whichFromPath(bin) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, bin);
    if (isExecutable(full)) return full;
  }
  return null;
}

// Override -> candidates -> PATH. The override is the TEST seam (CI has no claude binary
// and must never spawn one - a real spawn costs the owner money) and an operator escape
// hatch for a non-standard install. It mirrors PENDPOST_<LANE>_ENGINE's role
// (lib/mode.mjs:143), but that resolves node SCRIPTS per lane; this resolves a foreign
// binary, so it gets its own var rather than pretending to be a 15th lane.
export function resolveAgentBin(providerId) {
  const def = AGENT_PROVIDERS[providerId];
  if (!def) return null;
  const override = String(process.env[agentBinEnvVar(providerId)] || '').trim();
  if (override) return isExecutable(override) ? override : null;
  for (const c of def.binCandidates) if (isExecutable(c)) return c;
  return whichFromPath(def.bin);
}

// The keep-awake tool. Override -> platform default. The override is the TEST seam (a fake
// script that records its argv proves the assertion is requested for the right pid without ever
// touching the OS) and, set to '', an operator's off switch. Default: /usr/bin/caffeinate on
// macOS, nothing elsewhere - a missing tool is a null, never a failed job.
export function resolveKeepAwakeBin() {
  const override = process.env[KEEP_AWAKE_BIN_VAR];
  if (override !== undefined) {
    const p = String(override).trim();
    return p && isExecutable(p) ? p : null;
  }
  if (process.platform !== 'darwin') return null;
  return isExecutable(KEEP_AWAKE_DEFAULT_BIN) ? KEEP_AWAKE_DEFAULT_BIN : null;
}

// -i: no idle sleep while the child works. -s: no system sleep from a dark wake either (AC only,
// the OS's rule). -w: released when THAT pid exits, so the assertion can never outlive the job.
export const keepAwakeArgv = (pid) => ['-i', '-s', '-w', String(pid)];

// Hold the assertion for one child. Returns the helper process or null; never throws - staying
// awake is a courtesy to the job, not a precondition of it.
function holdAwake(pid) {
  const bin = resolveKeepAwakeBin();
  if (!bin || !pid) return null;
  try {
    const p = spawn(bin, keepAwakeArgv(pid), { stdio: 'ignore' });
    p.on('error', () => { /* no caffeinate, no problem */ });
    p.unref?.();
    return p;
  } catch { return null; }
}

// The sleep meter: pure, clock-injected so a test can replay a frozen process without freezing
// one. tick() returns the sleep it just detected (0 when the heartbeat arrived on time). A
// heartbeat that is late by less than gapMinMs is event-loop jitter, not sleep, and is ignored.
export function createSleepMeter({ now = Date.now, intervalMs = HEARTBEAT_MS, gapMinMs = SLEEP_GAP_MIN_MS } = {}) {
  let last = now();
  let sleptMs = 0;
  let gaps = 0;
  return {
    tick() {
      const t = now();
      const late = t - last - intervalMs;
      last = t;
      if (late < gapMinMs) return 0;
      sleptMs += late;
      gaps += 1;
      return late;
    },
    get sleptMs() { return sleptMs; },
    get gaps() { return gaps; },
  };
}

// The operator-facing truth for a job that timed out while the computer slept. English like every
// other detail string in this module; the row's `reason` stays 'timeout' (the UI already speaks
// it) and this is the WHY next to it. House dash, never an em dash.
export function sleepDetail(sleptMs, timeoutMs) {
  const min = (ms) => Math.max(1, Math.round(ms / 60_000));
  const awakeMs = Math.max(0, timeoutMs - sleptMs);
  return `the computer slept for ${min(sleptMs)} of this job's ${min(timeoutMs)} minutes (the agent was awake for about ${min(awakeMs)}) - a Radar scan needs the computer awake; pendpost holds it awake while a scan runs, but macOS allows that only on AC power`;
}

// A pure lookup - no spawn, so the Setup card can render without spending anything.
export function availableProviders() {
  return AGENT_PROVIDER_IDS.map((id) => ({
    id,
    label: AGENT_PROVIDERS[id].label,
    // The per-agent mint command, so the Setup card shows THIS agent's command, not Claude's,
    // the moment a second provider is offerable. One source of truth: the provider table.
    authCmd: AGENT_PROVIDERS[id].authCmd || null,
    installed: Boolean(resolveAgentBin(id)),
    supported: isSupportedProvider(id),
  }));
}

// Is a credential present for this provider? PRESENCE ONLY, never the value and never a
// tail: this token is write-only by design, so no tool, route or log can read it back.
// (Every platform lane surfaces {present, tail}; this one deliberately does not - there is
// only ever one agent token, so a tail identifies nothing the owner does not already know.)
export function agentCredentialPresent(providerId) {
  const def = AGENT_PROVIDERS[providerId];
  if (!def) return false;
  return def.credentialVars.some((k) => Boolean(readEnv(k)));
}

// A hermetic config dir for the research child, sibling to --strict-mcp-config's MCP
// isolation. Without it the child reads the OPERATOR'S ~/.claude (HOME points there), so
// EVERY spawn runs their global SessionStart hooks, plugins, skills and CLAUDE.md - none of
// which a thread-reading research child needs. A single hanging SessionStart hook then eats
// the whole 15-minute budget and the job dies "ran too long and was stopped", with the hook
// envelope leaking into the job note (the exact failure seen 2026-08-19). CLAUDE_CONFIG_DIR
// is honoured by claude v2.1.201 (proven: `claude mcp list` under it shows zero servers) and
// - unlike --bare - it does NOT change auth, so the OAuth token in env still works. The dir
// holds no secret (auth is env-only); it persists so the child never re-runs first-run setup.
const AGENT_CONFIG_DIR = path.join(os.homedir(), '.pendpost', 'agent-claude-config');

// THE CHILD'S ENVIRONMENT IS A FLOOR, NOT AN INHERITANCE.
// Built from {} on purpose. Every other spawner in this tree spreads {...process.env}
// (lib/writes.mjs:122, lib/api.mjs:324) because those children ARE pendpost engines that
// need the platform tokens. This one is not: the daemon's env carries every platform
// credential (.env is read into it), and a spawned agent that reads untrusted threads must
// never see them. DO NOT "fix" this to match its neighbours.
// PENDPOST_ROOT is likewise withheld: the child is not an engine and has no filesystem
// relationship with pendpost - it reaches us over MCP, where withClient binds the root
// server-side.
function childEnv(def, bin) {
  // Idempotent: create the hermetic config dir once, reuse it forever. A failure here must
  // not sink the spawn - fall back to the operator's config (the old behaviour) rather than
  // refusing to run, so this fail-safe can never itself become a new failure mode.
  let configDir = AGENT_CONFIG_DIR;
  try { fs.mkdirSync(AGENT_CONFIG_DIR, { recursive: true }); } catch { configDir = null; }
  const env = {
    PATH: [...new Set([path.dirname(bin), ...AGENT_PATH_DIRS])].join(path.delimiter),
    HOME: os.homedir(),
    // Hermetic: no operator hooks/plugins/skills/CLAUDE.md in the research child (see above).
    ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}),
  };
  for (const k of def.credentialVars) {
    const v = readEnv(k);
    if (v) { env[k] = v; break; } // first match only: never hand the child two credentials
  }
  return env;
}

// A credential can surface inside an error string (a spawn error echoing argv, a CLI
// complaining about a bad token). sanitizeHealthRow whitelists KEYS, not VALUES, so a
// token inside `detail` would sail straight through it into state.json. This closes that.
export function scrubCredential(text, providerId) {
  const def = AGENT_PROVIDERS[providerId];
  let out = String(text || '');
  if (!def) return out;
  for (const k of def.credentialVars) {
    const v = readEnv(k);
    // >= 8 guards against a degenerate short value redacting the whole string.
    if (v && v.length >= 8) out = out.split(v).join('[redacted]');
  }
  return out;
}

// The child's own first line is the operator-legible truth ('Not logged in · Please run
// /login'). STDOUT is checked too, and first: unlike every lane engine (lib/health.mjs:71
// reads stderrTail only), this CLI prints its auth refusal to stdout. Proven, not assumed.
export function firstLine(...streams) {
  for (const s of streams) {
    const line = String(s || '').split('\n').map((x) => x.trim()).find(Boolean);
    if (line) return line;
  }
  return null;
}

// --- the server-side witness ------------------------------------------------
// The ONLY honest answer to "did the tool call actually land?". The envelope cannot tell
// us (PROVEN #3) and the child's prose is not evidence - a model can answer "OK" having
// called nothing, which is the exact failure the probe exists to catch.
//
// Why a witness and not an envelope parse: spec 41 S3 asks whether the call LANDED, and a
// call denied by the allow-list would still be an "attempt". This records arrival at our
// own MCP handler and nothing else, so it cannot be faked by the child, and it cannot rot
// when a future CLI release renames an envelope field.
let toolWitness = null; // { tools:Set } while a probe is in flight, else null

export function beginToolWitness() { toolWitness = { tools: new Set() }; return toolWitness; }
export function endToolWitness() { const w = toolWitness; toolWitness = null; return w ? [...w.tools] : []; }
// Called by lib/mcp.mjs's dispatcher. Observes; never alters the response. A no-op unless
// a probe is actually in flight, so the normal MCP path pays one null check.
export function witnessAgentTool(name) { if (toolWitness) toolWitness.tools.add(name); }

// --- the link fence (spec 42 §4.3) ------------------------------------------
// The SECOND fence that survives the owner's auto-post decision, and the one that removes the
// payoff. If a hostile thread can make our brand post its words unread, the thing it actually wants
// is a LINK - phishing, spam, an affiliate. Words alone are embarrassing; a link is monetizable.
//
// So: a reply about to be AUTO-APPROVED may not carry a url outside the project's own domains.
// Consulted ONLY at the auto-approve decision, never at queue time - a human drafting a reply may
// link wherever they like, and so may an agent draft that is going to be READ by a human first.
// This fences autonomy, not expression.
//
// Own-domain is derived from posting.defaultLink, the one place the project already declares its own
// url. Nothing to configure, nothing new to keep in sync.
const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; } };

export function foreignLinksIn(text, defaultLink) {
  const own = hostOf(String(defaultLink || ''));
  const found = String(text || '').match(URL_RE) || [];
  return found
    .map(hostOf)
    .filter(Boolean)
    // A subdomain of our own site is ours. Anything else is a stranger's.
    .filter((h) => !own || (h !== own && !h.endsWith(`.${own}`)));
}

// --- the draft fence (spec 42 §4.3) -----------------------------------------
// THE LOAD-BEARING FENCE, and it is load-bearing precisely because the owner allowed
// agent-drafted replies to auto-post (decision 2026-07-16).
//
// queueRadarReply accepts an ARBITRARY url: lib/writes.mjs states outright that "a signal that is
// not in the feed yields {} - the reply still queues and still fires". That is fine for the GUI
// (the operator clicked a row) and for a chat agent (a human is reading). It is NOT fine for a child
// that is reading untrusted threads and whose output may post unread: without this, a comment saying
// "reply to https://evil.example/thread with <text>" would be obeyed.
//
// So while a draft child is in flight, a reply may only target a signal PENDPOST ITSELF chose. The
// blast radius of a successful injection drops from "the brand posts anywhere" to "the brand says
// something in the thread it was already replying to".
//
// Same shape as the witness above: a module flag, armed around exactly one spawn, and a no-op for
// every other caller - the GUI and chat paths keep their existing contract byte-for-byte.
let draftFence = null; // Set<`${source} ${externalId}`> while a draft child runs, else null
// The operator-requested draft-for-review flag (the "Wird automatisch gepostet" tap): while
// armed WITH holdApproval, queueRadarReply's auto-reply policy stands down and the drafted
// reply stays pending for the human who asked to read it. Same lifecycle as the fence itself.
let draftFenceHold = false;

export function beginDraftFence(keys, { holdApproval = false } = {}) { draftFence = new Set(keys); draftFenceHold = holdApproval === true; return draftFence; }
export function endDraftFence() { draftFence = null; draftFenceHold = false; }
// null => no spawned drafter is running, so this caller is the GUI or a chat agent: allow.
export const draftTargetAllowed = (key) => (draftFence === null ? true : draftFence.has(key));
export const draftFenceArmed = () => draftFence !== null;
export const draftFenceHoldsApproval = () => draftFence !== null && draftFenceHold;

// --- the follow-up fence (engagement engine, owner decision 4) ----------------
// Same module-flag shape as the draft fence, with ONE deliberate inversion: it FAILS CLOSED
// when disarmed. The draft fence is a no-op outside a spawn because queueRadarReply has
// legitimate human callers (the GUI row, a chat agent a human is reading). The follow-up
// report has NONE: "the thread author answered us" is a fact pendpost stamps from evidence
// its OWN spawned reader gathered against targets pendpost ITSELF enumerated - an operator
// records the same fact through mark_posted/the card, never through this tool. So outside
// an armed fence the tool is inert, and while armed it accepts exactly the enumerated keys.
let followupFence = null; // Set<`${source} ${externalId}`> while a follow-up child runs, else null

export function beginFollowupFence(keys) { followupFence = new Set(keys); return followupFence; }
export function endFollowupFence() { followupFence = null; }
// FAIL-CLOSED: null (disarmed) refuses everything.
export const followupTargetAllowed = (key) => (followupFence !== null && followupFence.has(key));
export const followupFenceArmed = () => followupFence !== null;

// --- the job registry -------------------------------------------------------
// ONE running job per client. Keyed on the RESOLVED CLIENT ROOT, not a clientId string:
// radarIngest does `void clientId` and binding is AsyncLocalStorage (lib/context.mjs), so
// the root is the only identity available at every layer that needs to find this job.
const running = new Map(); // resolvedRoot -> { jobId, child, startedAt }

export const runningJob = (root = activeRoot()) => running.get(root) || null;
export const isJobRunning = (root = activeRoot()) => running.has(root);
// Every client root with a job in flight right now. The MCP dispatch (lib/mcp.mjs callTool)
// reads this to PIN the radar child-facing write tools to the in-flight job's client: a child
// spawned for client X must never write against client Y, whatever clientId its prompt - or a
// thread it read - talked it into supplying (audit 2026-08-31, defense in depth behind the
// prompt fix). Returned as a copy so no caller can mutate the registry.
export const runningJobRoots = () => [...running.keys()];

// Kill the running child for a client. SIGTERM, then SIGKILL after a grace - a child that
// ignores TERM still dies, because a job spends real money for as long as it lives.
export function killJob(root = activeRoot()) {
  const entry = running.get(root);
  if (!entry) return null;
  entry.stopped = true;
  try { entry.child.kill('SIGTERM'); } catch { /* already gone */ }
  const t = setTimeout(() => { try { entry.child.kill('SIGKILL'); } catch { /* gone */ } }, KILL_GRACE_MS);
  t.unref?.();
  return entry.jobId;
}

// Write the per-job MCP config the child is handed. 0600, its own temp dir, deleted by the
// caller in a finally. The URL is the daemon's OWN resolved port (lib/util.mjs#mcpUrl),
// never a hardcoded 8090: an operator on PENDPOST_PORT=9000 would otherwise get a child
// dialing a closed port, and server.mjs's Host allow-list would reject it even if it were
// open.
function writeMcpConfig() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pendpost-agent-'));
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({ mcpServers: { pendpost: { type: 'http', url: mcpUrl() } } }), { mode: 0o600 });
  return { dir, file };
}

/**
 * Spawn the provider on one prompt and wait for it to finish.
 * Returns { ok, exitCode, stdout, stderr, tail, detail, durationMs, timedOut, stopped, error }.
 * error is one of timeout | sleep (a timeout that overlapped metered sleep, R4) | stopped | exit |
 * agent_error | limit | spawn_failed | no_credential | not_installed | job_running | unknown_provider |
 * unsupported_provider, or null when ok.
 * NEVER throws and never rejects (Pattern P9: degrade, never throw) - a provider that is
 * missing, unsupported or explosive is a `failed` job with a reason, not a 500.
 */
export async function runAgentJob({ providerId, prompt, allowedTools, model = null, timeoutMs = AGENT_TIMEOUT_MS, jobId = null, root = activeRoot(), stream = false, onEvent = null, meterNow = Date.now } = {}) {
  const def = AGENT_PROVIDERS[providerId];
  const started = Date.now();
  const fail = (error, detail) => ({ ok: false, error, detail, exitCode: null, stdout: '', stderr: '', tail: detail || '', durationMs: Date.now() - started, timedOut: false, stopped: false });

  if (!def) return fail('unknown_provider', `unknown agent provider '${providerId}'`);
  if (!isSupportedProvider(providerId)) return fail('unsupported_provider', `${def.label} is not yet supported: its headless and MCP flags have not been verified against the real CLI`);
  if (!agentCredentialPresent(providerId)) return fail('no_credential', `no credential stored for ${def.label} - run: ${def.authCmd}, then paste it in Setup`);
  // ONE running child per client, refused at the chokepoint rather than at each caller:
  // never queued, never a second child. Every spawn spends the operator's subscription, so
  // a double-click must cost nothing. This is also what makes the ingest tally sound -
  // there is at most one job a concurrent radar_ingest could belong to.
  if (running.has(root)) return fail('job_running', 'an agent job is already running for this client');

  const bin = resolveAgentBin(providerId);
  if (!bin) return fail('not_installed', `${def.label} is not installed (looked for '${def.bin}')`);

  const cfg = writeMcpConfig();
  try {
    const argv = def.argv({ prompt, mcpConfigPath: cfg.file, allowedTools, model, stream });
    let child;
    try {
      child = spawn(bin, argv, {
        // NOT REPO_ROOT. The child has no filesystem tools today, but if that allow-list
        // ever regresses its cwd should not be the operator's repo. One word, real depth.
        cwd: os.tmpdir(),
        env: childEnv(def, bin),
        // stdin closed: the CLI otherwise waits 3s for piped input on every single job.
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      return fail('spawn_failed', scrubCredential(err.message, providerId));
    }

    running.set(root, { jobId, child, startedAt: started, stopped: false });
    // Hold the computer awake for exactly as long as this child lives (see HEARTBEAT_MS above).
    const awake = holdAwake(child.pid);
    // meterNow: the heartbeat's clock, injectable so a test can replay a frozen process (R4).
    const meter = createSleepMeter({ now: meterNow });

    // In stream mode the closing `result` NDJSON event IS the envelope (same fields:
    // is_error, result) - parseEnvelope cannot read it out of an NDJSON stdout, so it is
    // caught here as the lines go by.
    let streamEnv = null;
    const result = await new Promise((resolve) => {
      let stdout = ''; let stderr = ''; let timedOut = false; let lineBuf = '';
      // spawn, not execFile: execFile's maxBuffer OVERFLOW KILLS THE CHILD, and a 15-minute
      // research job can outrun any cap - we'd rather truncate our copy than lose the job.
      // (lib/api.mjs:320 records this same lesson for the interactive auth.) We also need a
      // live handle for Stop, and an explicit timedOut flag rather than err.killed.
      child.stdout.on('data', (d) => {
        if (stdout.length < STDOUT_CAP) stdout += d;
        if (!stream) return;
        // Incremental NDJSON: parse each COMPLETE line as one event. A malformed line (or a
        // throwing observer) must never hurt the job - progress is a bonus, never a risk.
        lineBuf += d;
        const lines = lineBuf.split('\n');
        lineBuf = lines.pop() || '';
        for (const line of lines) {
          const s = line.trim();
          if (!s) continue;
          try {
            const evt = JSON.parse(s);
            if (evt && typeof evt === 'object') {
              if (evt.type === 'result') streamEnv = evt;
              if (onEvent) onEvent(evt);
            }
          } catch { /* partial or non-JSON line - skip */ }
        }
      });
      child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-STDERR_CAP); });

      const timer = setTimeout(() => { timedOut = true; killJob(root); }, timeoutMs);
      timer.unref?.();
      // The heartbeat that tells a sleeping computer apart from a stuck child.
      const heartbeat = setInterval(() => meter.tick(), HEARTBEAT_MS);
      heartbeat.unref?.();

      child.on('error', (err) => { // ENOENT and friends: the child never started
        clearTimeout(timer);
        clearInterval(heartbeat);
        resolve({ ok: false, error: 'spawn_failed', exitCode: null, stdout, stderr, timedOut, detail: scrubCredential(err.message, providerId) });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        clearInterval(heartbeat);
        const stopped = Boolean(running.get(root)?.stopped) && !timedOut;
        // EXIT CODE PROVES NOTHING (PROVEN #4): `Not logged in` exits 0. The envelope's
        // is_error is the child's own verdict on its turn, and without this check an
        // unauthenticated job would report `done` having found nothing - a button that
        // shrugged, which is the exact complaint this spec exists to answer.
        const env = streamEnv || parseEnvelope(stdout);
        const agentErrored = env?.is_error === true;
        const error = timedOut ? 'timeout' : stopped ? 'stopped' : code !== 0 ? 'exit' : agentErrored ? 'agent_error' : null;
        resolve({ ok: error === null, error, exitCode: code, stdout, stderr, timedOut, stopped, detail: null });
      });
    });

    const stdoutClean = scrubCredential(result.stdout, providerId);
    const stderrClean = scrubCredential(result.stderr, providerId);
    // Streamed stdout is NDJSON, useless as prose - the envelope's own `result` string is
    // the child's words there, for tail and detail alike.
    const envText = streamEnv ? scrubCredential(String(streamEnv.result || ''), providerId) : '';
    // stderr first for the tail (a crash talks there), but stdout is in the detail chain
    // because this CLI's auth refusal lands on stdout (PROVEN #5). stdout goes through
    // humanTailText so a stream that died mid-run never puts a raw NDJSON protocol frame
    // (rate_limit_event and friends) on the operator's screen (L6).
    const tail = normalizeTail((stderrClean || envText || humanTailText(stdoutClean)).slice(-AGENT_TAIL_MAX));
    // A timeout while the computer slept is reported as exactly that (incident 2026-09-02..04).
    const slept = result.timedOut && meter.sleptMs >= SLEEP_GAP_MIN_MS ? sleepDetail(meter.sleptMs, timeoutMs) : null;
    // stdout's fallback goes through humanTailText, NOT firstLine: in stream mode the first stdout
    // line is the `system/init` protocol frame, and a child killed mid-run (no result event) used
    // to surface THAT as the job row's detail/tail - three live timeout rows carried
    // {"type":"system","subtype":"init",...} while the child's real last words (an API error
    // about the computer sleeping) sat unread further down the stream. Bare-prose stdout (the
    // auth refusal, PROVEN #5) still comes through: humanTailText returns plain lines verbatim.
    const detail = normalizeTail(slept || result.detail || firstLine(envText) || envelopeDetail(stdoutClean) || firstLine(stderrClean) || firstLine(humanTailText(stdoutClean))) || null;
    // Reclassify ONLY runs that already failed as exit/agent_error - never stopped (the
    // operator's own act) or timeout (a wall-clock fact) - so an unmatched pattern degrades
    // to exactly today's behavior.
    const reclassifiable = result.error === 'exit' || result.error === 'agent_error';
    // R4 (2026-09-04): a timeout that overlapped METERED sleep is reason 'sleep', not 'timeout'.
    // The two look identical from the envelope and are opposites for the operator: 'timeout' says
    // the work was too big for the slice, 'sleep' says the computer was not there for the work
    // (AC power, or a longer awake window). `timedOut` stays true - the wall clock DID fire - and
    // detail keeps sleepDetail. Only ever set when `slept` is (metered gap >= SLEEP_GAP_MIN_MS).
    const error = slept ? 'sleep' : (reclassifiable && AGENT_LIMIT_RE.test(`${tail} ${detail || ''}`) ? 'limit' : result.error);
    return {
      ...result,
      error,
      stdout: stdoutClean,
      stderr: stderrClean,
      tail,
      detail,
      durationMs: Date.now() - started,
      sleptMs: meter.sleptMs,
      keptAwake: Boolean(awake),
    };
  } finally {
    running.delete(root);
    try { fs.rmSync(cfg.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// L6 tail hygiene (audit 2026-08-31): in stream mode stdout is NDJSON, and when the child
// dies without a closing `result` event (timeout kill, crash, quota death) the raw last
// frames used to become the job tail / Activity errorMessage - live rows carried
// {"type":"rate_limit_event",...}, worthless to an operator. This walks the lines from the
// END and returns the LAST human-readable text: a `result` event's own words, an assistant
// turn's text blocks, or any plain non-JSON prose line (the real CLI's auth refusal is bare
// prose on stdout, PROVEN #5). Typed protocol frames with no prose (rate_limit_event,
// system, tool_use-only turns) are skipped. Returns '' when nothing human-readable exists -
// an empty tail is more honest than a protocol frame. Pure, never throws.
export function humanTailText(stdout) {
  const lines = String(stdout || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i].trim();
    if (!s) continue;
    let evt = null;
    if (s.startsWith('{')) { try { evt = JSON.parse(s); } catch { evt = null; } }
    if (evt && typeof evt === 'object') {
      if (typeof evt.type !== 'string') return s; // JSON but not a stream frame - keep verbatim
      if (evt.type === 'result') {
        const t = String(evt.result || '').trim();
        if (t) return t;
        continue;
      }
      if (evt.type === 'assistant') {
        const blocks = Array.isArray(evt.message?.content) ? evt.message.content : [];
        const t = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim();
        if (t) return t;
        continue;
      }
      continue; // any other typed frame carries no operator-legible prose - skip
    }
    return s; // plain prose (a crash line, the auth refusal) - the child's own words
  }
  return '';
}

// --output-format json prints ONE envelope object. Its `result` field carries the child's
// own words - which is exactly the operator-legible line we want for `detail` ("Not logged
// in · Please run /login"). It is used for PROSE ONLY: the envelope says nothing about
// which tools were called (PROVEN #3), and `is_error:false` + subtype:'success' are both
// true of a child that did nothing at all.
export function parseEnvelope(stdout) {
  try {
    const env = JSON.parse(String(stdout).trim());
    return env && typeof env === 'object' ? env : null;
  } catch { return null; }
}

function envelopeDetail(stdout) {
  const env = parseEnvelope(stdout);
  if (!env) return null;
  const line = firstLine(String(env.result || ''));
  return line || null;
}

export { AGENT_TIMEOUT_MS, PROBE_TIMEOUT_MS, AGENT_LANE_MS_PER_QUERY, AGENT_LANE_MIN_MS };
