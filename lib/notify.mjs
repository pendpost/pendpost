// notify.mjs - owner-facing macOS notification when NEW posts land in the
// approval queue (Phase D). Deliberately minimal: a 5-min poll over the plan
// store, one osascript notification when the queue GREW since the last check
// (a shrinking queue is the owner working, not news). State lives in
// state.json (notify.lastQueueSize) so restarts do not re-notify.
//
// Parity note: macos-notifications is a documented uiOnly exemption in
// API-CONTRACT.md - there is no MCP tool for it by design.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { loadPlanStore } from './plans.mjs';
import { loadState, saveState } from './state.mjs';
import { logLine } from './util.mjs';
import { makeT } from './i18n.mjs';
import { getPosting } from './config.mjs';

const POLL_MS = 5 * 60 * 1000;

function queueSize() {
  const { campaigns, manifestError } = loadPlanStore();
  if (manifestError) return null;
  return campaigns
    .filter((c) => c.active)
    .flatMap((c) => c.posts || [])
    .filter((p) => p.approval !== 'approved' && p.derivedState !== 'posted')
    .length;
}

// macOS attributes every notification to the bundle of the process that posts
// it - and AppleScript's `display notification` ALWAYS posts as Script Editor,
// so an osascript notification shows Script Editor's generic scroll icon, never
// ours. install.sh therefore assembles a pendpost-branded notifier app bundle
// (a re-iconed copy of terminal-notifier) at /Applications/pendpost-notifier.app;
// posting through ITS binary makes the notification carry the pendpost icon and,
// via -sender, open pendpost.app on click. We fall back to osascript when that
// bundle is absent (e.g. terminal-notifier was unavailable at install time) so a
// notification still fires, just with the generic icon.
const NOTIFIER_BIN = '/Applications/pendpost-notifier.app/Contents/MacOS/terminal-notifier';

function notifyMac(title, body) {
  if (existsSync(NOTIFIER_BIN)) {
    execFile(
      NOTIFIER_BIN,
      ['-title', title, '-message', body, '-sender', 'pendpost.app', '-group', 'pendpost'],
      (err) => { if (err) logLine('warn', `notification failed: ${err.message}`); },
    );
    return;
  }
  // Fallback: plain AppleScript (generic Script Editor icon). Escape for the
  // AppleScript string literal (quotes + backslashes).
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  execFile('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}"`], (err) => {
    if (err) logLine('warn', `notification failed: ${err.message}`);
  });
}

function tick() {
  try {
    const size = queueSize();
    if (size === null) return;
    const state = loadState();
    const last = state.notify?.lastQueueSize;
    if (typeof last === 'number' && size > last) {
      // Localize for the active client's posting language (mirrors the digest).
      // Guarded: a config hiccup must never suppress the notification.
      let locale = 'en';
      try { locale = getPosting()?.locale || 'en'; } catch { /* fall back to en */ }
      const t = makeT(locale);
      notifyMac('pendpost', t(size === 1 ? 'notify.queue.one' : 'notify.queue.many', { n: size }));
    }
    state.notify = { ...(state.notify || {}), lastQueueSize: size, checkedAt: new Date().toISOString() };
    saveState();
  } catch (err) {
    logLine('warn', `approval notifier tick failed: ${err.message}`);
  }
}

// A finished Radar research job (owner ask 2026-07-20): the scan runs for minutes and the
// owner should not babysit the panel. One notification when it settles - what it found, or
// that it failed. Same uiOnly exemption as the approval notifier; no-op off macOS. Fired by
// radarAgentScan, so it covers manual AND scheduled runs. Never throws - a notification is
// a bonus, never a risk to the job result.
export function notifyRadarScanDone(job) {
  try {
    // Mock mode covers tests and dev fixtures - a stubbed scan must never pop a real
    // notification on the machine running it.
    if (process.platform !== 'darwin' || !job || String(process.env.PENDPOST_MODE || '').toLowerCase() === 'mock') return;
    let locale = 'en';
    try { locale = getPosting()?.locale || 'en'; } catch { /* fall back to en */ }
    const t = makeT(locale);
    const body = job.state === 'done'
      ? t(job.accepted === 1 ? 'notify.radar.done.one' : 'notify.radar.done.many', { n: job.accepted })
      : t('notify.radar.failed');
    notifyMac('pendpost', body);
  } catch (err) {
    logLine('warn', `radar scan notification failed: ${err.message}`);
  }
}

// The daily digest delivery (ux-audit 2026-08-04 R2, dim-3 gap 8). The digest was
// pull-only: renderable on every face, PUSHED on none. This pushes ONE notification
// after the daily insights sweep completes, through the SAME uiOnly seam the approval
// + radar notifiers use (a documented API-CONTRACT exemption; no MCP tool by design).
//
// Owner-configurable OFF via posting.digest.notify (default ON - delivery is the
// default, silence is the opt-in). A notification PREFERENCE, not autonomy, so it is
// deliberately not owner-gated in setConfig.
//
// Delivery ALSO stamps state.notify.lastDigestAt - the window anchor the digest's
// autonomy report reads to answer "what did the policies do since I last saw this?".
// So the stamp advances even in mock mode / off macOS (where no real popup fires):
// the report window must track WHEN the owner was last told, not whether a native
// notification happened to render. Never throws - a notification is a bonus, never a
// risk to the sweep that called it.
// `outliers` (optional, R8 follow-on dim-3 M3) is { breakout, slump } from the day's
// sweep - when present and non-empty the body NAMES the counts ("2 breaking out, 1
// slumping") so the owner acts on a standout post the day it happens, rather than the
// generic "digest ready". Absent/empty falls back to the plain ready line, so every
// existing caller/test is byte-unchanged. Same posting.digest.notify gate covers it -
// the outlier line is a richer digest notification, not a new channel.
export async function notifyDailyDigest({ outliers } = {}) {
  try {
    let posting = {};
    try { posting = getPosting() || {}; } catch { /* fall back to defaults */ }
    // Gate OFF: no delivery, and crucially no window stamp - a silenced digest must
    // not advance the anchor, or the next delivered digest would under-report.
    if (posting.digest && posting.digest.notify === false) {
      return { delivered: false, reason: 'disabled' };
    }
    const locale = posting.locale || 'en';
    const t = makeT(locale);
    const up = outliers?.breakout?.length || 0;
    const down = outliers?.slump?.length || 0;
    let body;
    if (up && down) body = t('notify.digest.outliers.both', { up, down });
    else if (up) body = t('notify.digest.outliers.breakout', { n: up });
    else if (down) body = t('notify.digest.outliers.slump', { n: down });
    else body = t('notify.digest.ready');
    // Mock mode covers tests/fixtures; off darwin there is no notification center -
    // in both cases skip the real popup but STILL stamp + report delivered.
    const isMock = String(process.env.PENDPOST_MODE || '').toLowerCase() === 'mock';
    if (process.platform === 'darwin' && !isMock) notifyMac('pendpost', body);
    const state = loadState();
    state.notify = { ...(state.notify || {}), lastDigestAt: new Date().toISOString() };
    saveState();
    return { delivered: true, body };
  } catch (err) {
    logLine('warn', `daily digest notification failed: ${err.message}`);
    return { delivered: false, reason: 'error' };
  }
}

// ---- spec 50 P5b: the auto-engage push (§7.7, row 9) ------------------------------------
//
// The macOS half of the urgent push. Its Telegram twin is lib/telegram-owner.mjs; both are
// driven once per (key, channel) by pushSweep() in lib/engage-asks.mjs, which owns the
// "exactly once" ledger. This function's only job is delivery, and it is deliberately dumb
// about WHEN: a notifier that also decided urgency would be a second policy nobody can read.
//
// The deep link is the whole point. A notification that only says "something needs you" makes
// the owner hunt through the Studio for which thread; `pendpost://radar?client=<id>&ask=<id>`
// lands them on the row. terminal-notifier's `-open` takes any URL and hands it to the OS,
// which routes the pendpost:// scheme to pendpost.app (the same bundle install.sh registers
// for the `-sender` attribution above).
//
// The osascript fallback CANNOT open a URL - AppleScript's `display notification` has no such
// verb - so on a machine without the notifier bundle the notification still fires, just
// without the click-through. That is a real degradation and it is silent by design: a missing
// deep link is worth less than a missing notification.
const NOTIFIER_TIMEOUT_MS = 10000;

function notifyMacDeepLink(title, body, url) {
  if (!existsSync(NOTIFIER_BIN)) {
    // No bundle: fall back to the shared plain notifier (no click-through, see above).
    notifyMac(title, body);
    return false;
  }
  const args = ['-title', title, '-message', body, '-sender', 'pendpost.app', '-group', 'pendpost'];
  if (url) args.push('-open', url);
  execFile(NOTIFIER_BIN, args, { timeout: NOTIFIER_TIMEOUT_MS }, (err) => {
    if (err) logLine('warn', `engage notification failed: ${err.message}`);
  });
  return true;
}

/**
 * One macOS notification for an urgent open ask (spec 50 §7.7).
 *
 * Never throws and never decides anything: the caller has already established that this ask is
 * urgent and has not been pushed to this channel before. Off macOS and in mock mode it reports
 * `{ok:true, delivered:false}` - the ask WAS handled as far as this channel is concerned, so
 * the ledger still records it and no tick retries forever on a Linux box or in a test.
 *
 * @param {object} ask - the ask row: { id, kind, lane, reasonLine, question, urgent }.
 * @param {object} [opts]
 * @param {string|null} [opts.clientId] - the brand, for the deep link's `client` parameter.
 * @param {Function|null} [opts.execImpl] - injected for tests; receives (title, body, url).
 * @returns {{ok:true, delivered:boolean, body:string, url:string}|{ok:false, reason:string}}
 */
export function notifyEngage(ask, { clientId = null, execImpl = null } = {}) {
  try {
    if (!ask || !ask.id) return { ok: false, reason: 'no_ask' };
    const body = engagePushText(ask);
    const url = engageDeepLink(ask, clientId);
    if (typeof execImpl === 'function') {
      execImpl('pendpost', body, url);
      return { ok: true, delivered: true, body, url };
    }
    // A real popup only where there is a notification centre and nobody is running fixtures.
    const isMock = String(process.env.PENDPOST_MODE || '').toLowerCase() === 'mock';
    if (process.platform !== 'darwin' || isMock) return { ok: true, delivered: false, body, url };
    notifyMacDeepLink('pendpost', body, url);
    return { ok: true, delivered: true, body, url };
  } catch (err) {
    logLine('warn', `engage notification failed: ${err.message}`);
    return { ok: false, reason: 'error' };
  }
}

/**
 * `pendpost://radar?client=<id>&ask=<id>` (§7.7). Both values are encoded: an ask id is a
 * UUID today, but a client id is operator-chosen and a stray `&` would silently truncate the
 * link rather than fail loudly.
 */
export function engageDeepLink(ask, clientId = null) {
  const parts = [];
  const cid = String(clientId || '').trim();
  if (cid) parts.push(`client=${encodeURIComponent(cid)}`);
  if (ask && ask.id) parts.push(`ask=${encodeURIComponent(String(ask.id))}`);
  return `pendpost://radar${parts.length ? `?${parts.join('&')}` : ''}`;
}

// The one sentence the owner reads on their lock screen. Plain words, no enum, no em dash
// (house rule), and it names the platform because "something needs you" on a three-brand
// instance is not actionable. `reasonLine` and `question` are already clipped plain text on
// the ask row, so this only has to choose between them and keep the result short enough that
// macOS does not truncate it mid-word.
const PUSH_LINE_LIMIT = 180;

export function engagePushText(ask) {
  const lane = String((ask && ask.lane) || '').trim();
  const on = lane ? ` on ${lane}` : '';
  const detail = String((ask && (ask.question || ask.reasonLine)) || '').trim();
  const tail = detail ? ` ${detail}` : '';
  let head;
  switch (String((ask && ask.kind) || '')) {
    case 'login': head = `You are logged out${on}, so nothing can go out there.`; break;
    case 'switchAccount': head = `The browser is on another account${on}.`; break;
    case 'handoff': head = `A reply${on} could not be posted, so it is waiting for you.`; break;
    case 'confirm': head = `A reply${on} is held for you to read before it goes out.`; break;
    default: head = `A thread${on} needs an answer only you can give.`; break;
  }
  return `${head}${tail}`.replace(/\s+/g, ' ').trim().slice(0, PUSH_LINE_LIMIT);
}

export function bootApprovalNotifier() {
  if (process.platform !== 'darwin') return;
  // Establish the baseline immediately, then poll.
  tick();
  setInterval(tick, POLL_MS).unref();
}
