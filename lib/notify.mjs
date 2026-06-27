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

export function bootApprovalNotifier() {
  if (process.platform !== 'darwin') return;
  // Establish the baseline immediately, then poll.
  tick();
  setInterval(tick, POLL_MS).unref();
}
