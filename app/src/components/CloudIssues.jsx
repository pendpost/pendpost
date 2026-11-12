// CloudIssues - the shared pieces that turn one `sync.issues[]` row (GET /api/cloud, see
// lib/cloud-client.mjs cloudSyncStatus) into something the owner can read and act on:
// the plain message, a one-line label, and exactly ONE action. Used by the header
// popover (ConnectionStatus) and the per-project rows on the Cloud page, so both faces
// say the same thing and offer the same fix.
//
// The action per kind (one at most):
//   credential                -> "Reconnect"  (Setup, focused on that lane, in that project)
//   post (terminal) / overdue -> "Open post"  (the post detail, in that project)
//   post (still retrying)     -> no button, a quiet "pendpost tries again"
//   unreachable/worker_stale  -> "Check again" (POST /api/cloud/recheck, a real probe)
// A state without an issue row says its reason with its own fix (reasonAction): a stuck
// push is sent again, a stopped sync raises the limit, the rest are checked again.
// The caller owns navigation (onAction(issue, 'reconnect' | 'open')); the fixes run here
// through FixButton, which writes the fresh sync into the query cache.
import { useState } from 'react';
import { ArrowRight, Check, Cloud as CloudIcon, CloudOff, Laptop, RefreshCw, Send } from 'lucide-react';
import { useT } from '../lib/i18n.js';
import { failedDisplayKey, fmtRelative, fmtTime } from '../lib/format.js';
import { failureKey, humanizeFailure, laneLabel } from '../lib/failureCopy.js';
import { recheckCloud, pushCloud, useSetCloudSync } from '../lib/cloud.js';
import { humanizeAction } from '../lib/failureCopy.js';
import useRecheck from '../lib/useRecheck.js';
import { Button } from './ui/Button.jsx';
import ActionButton from './ui/ActionButton.jsx';
import { Tip } from './ui/Tooltip.jsx';
import { TAP_TARGET } from './ui/recipes.js';
import InfoTip from './ui/InfoTip.jsx';

export { laneLabel };

// Connectivity rows describe the cloud as a whole (one workspace), not one project. Each is
// named by its delivery reason, the one name the sidebar card and the Needs-you tray say too.
const CONNECTIVITY_REASON = { unreachable: 'cloud_unreachable', worker_stale: 'worker_stale' };
export const CONNECTIVITY = new Set(Object.keys(CONNECTIVITY_REASON));

// The ONE cloud state behind the header dot AND the Cloud page pill now lives in
// lib/deliveryState.js (the delivery state derives from it too); re-exported so every
// existing import keeps working.
export { cloudHealth } from '../lib/deliveryState.js';

// The dot colour per health state, for the header dot AND every project row (null = no dot).
// Waiting is not a warning: yellow (a self-resolving wait) is a neutral grey dot, while amber and red
// stay warm for states that need a look. The Cloud page pill follows the same split.
const HEALTH_DOT = { red: 'bg-red-500', amber: 'bg-amber-500', yellow: 'bg-zinc-400 dark:bg-zinc-500' };
export function healthDot(state) {
  return HEALTH_DOT[state] || null;
}

// A failed post pendpost is still retrying on its own: the SAME derivation the post's banner
// and planner card use (failedDisplayKey), fed the same inputs (the engine puts terminal,
// recovery and halted on the row), so the row can never call "retrying" what the banner calls
// "needs you", or paint red what the banner paints neutral.
export function issueRetrying(issue) {
  return issue?.kind === 'post' && failedDisplayKey(issue) === 'publish-retrying';
}

// A project row's health: the roll-up's own state, except that a red caused only by posts
// pendpost still retries is the neutral wait their banners and cards show.
export function projectHealth(state, issues = []) {
  return state === 'red' && issues.length > 0 && issues.every(issueRetrying) ? 'yellow' : state;
}

// The one action an issue offers, or null when it has nothing to act on. 'retrying' is a
// note, not a button: a post the cloud still retries needs nothing from the owner.
export function issueAction(issue) {
  if (!issue) return null;
  if (issue.kind === 'credential') return issue.lane ? 'reconnect' : null;
  if (issueRetrying(issue)) return 'retrying';
  if (issue.kind === 'post' || issue.kind === 'overdue') return issue.campaign && issue.postId ? 'open' : null;
  if (CONNECTIVITY.has(issue.kind)) return 'recheck';
  return null;
}

// The fix for a state that has no issue row (its reason line), or null. Red reasons
// (a failed post, an unreadable plan) are fixed where the post lives, not here.
const REASON_ACTION = {
  cloud_unreachable: 'recheck',
  worker_stale: 'recheck',
  subscription_failed: 'recheck',
  flag_divergence: 'recheck',
  push_stuck: 'resend',
  push_pending: 'resend',
  sync_stopped: 'raise',
};
export function reasonAction(reason) {
  return REASON_ACTION[reason] || null;
}

// "Is it gone?" predicates over a FRESH sync, so a fix can tell fixed from still.
// Connectivity is one workspace, so its kind alone identifies it.
function sameIssue(a, b) {
  if (CONNECTIVITY.has(b.kind)) return a.kind === b.kind;
  return a.kind === b.kind && a.clientId === b.clientId && (a.campaign || null) === (b.campaign || null)
    && (a.postId || null) === (b.postId || null) && (a.lane || null) === (b.lane || null);
}
export const issueGone = (issue) => (sync) => !((sync && sync.issues) || []).some((i) => sameIssue(i, issue));
export const reasonGone = (reason, clientId = null) => (sync) => (clientId
  ? !((sync && sync.clients) || []).some((c) => c.clientId === clientId && c.reason === reason)
  : !sync || sync.reason !== reason);

// red = a post did not go out; amber = connectivity, the local backstop covers it; a post
// pendpost still retries is a wait, so it wears the neutral waiting dot.
export function issueDot(issue) {
  if (CONNECTIVITY.has(issue?.kind)) return 'bg-amber-500';
  return issueRetrying(issue) ? HEALTH_DOT.yellow : 'bg-red-500';
}

// The plain sentence for an issue. Our own states (credential, overdue, connectivity) are
// localized; a platform failure goes through the shared failure humanizer (one sentence:
// what happened and why), because the raw "lane: POST /path: HTTP 500 - ..." string is
// for a tooltip, never the row. The credential sentence names the platform. For a
// connectivity row this is the handover glyph's tooltip and accessible name.
export function issueMessage(issue, t) {
  if (!issue) return '';
  if (issue.kind === 'credential') {
    const vars = { lane: laneLabel(issue.lane) || t('failure.platform') };
    const key = `connection.issue.msg.${issue.code}`;
    const s = t(key, vars);
    return s !== key ? s : t('connection.issue.msg.account_unresolved', vars);
  }
  if (issue.kind === 'overdue') return t('connection.issue.msg.overdue');
  if (CONNECTIVITY.has(issue.kind)) {
    const backstop = t(`connection.sync.reason.${CONNECTIVITY_REASON[issue.kind]}`);
    // The humanized last error, when it says more than the headline ("Cloud unreachable")
    // already does: a plain network failure would only repeat it.
    const key = issue.kind === 'unreachable' ? failureKey({ message: issue.message }) : null;
    return key && key !== 'failure.network' ? `${t(key, { lane: t('failure.cloud') })} ${backstop}` : backstop;
  }
  return humanizeFailure(issue, t).text || t('connection.issue.msg.post');
}

// The row's headline: the post's title when there is one, else a short kind label. A
// connectivity row says its state's one name (delivery.reason.*, as on the sidebar card).
export function issueLabel(issue, t) {
  if (issue?.title) return issue.title;
  if (CONNECTIVITY.has(issue?.kind)) return t(`delivery.reason.${CONNECTIVITY_REASON[issue.kind]}`);
  return t(`connection.issue.kind.${issue?.kind}`);
}

// How long a fixed row takes to fold away (spatial motion, >= 350 ms). The fresh sync is
// written to the cache only after it, so the row can animate before it unmounts.
export const COLLAPSE_MS = 400;
const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
// ActionButton's cancel sentinel: "still" is neither a success flash nor an error.
const NOT_YET = Object.freeze({ canceled: true });

// The one fix runner: an optional resend (POST /api/cloud/push), then a real probe of the
// cloud (POST /api/cloud/recheck). Resolves whether the thing is gone from the fresh sync,
// when it was checked, and commit() to write that sync into the cache.
export function useCloudFix() {
  const setSync = useSetCloudSync();
  return async (action, gone) => {
    if (action === 'resend') await pushCloud();
    const r = await recheckCloud();
    const sync = r && 'sync' in r ? r.sync : null;
    const fixed = Boolean(await gone(sync));
    return { fixed, checkedAt: (r && r.checkedAt) || new Date().toISOString(), commit: () => setSync(sync, action === 'resend') };
  };
}

// The ONE fix button (check again / send again), built on ActionButton's state machine.
// idle -> working (spinner, disabled, aria-busy, held for useRecheck's minimum; the label
// never changes, so the width holds) -> fixed (a check, then the row folds away via onFixed)
// | still ("not yet · HH:MM") | error (the known reason, else "check failed"; the button
// stays live, so it retries). A second identical still/error is dated as a new check. The
// result line is a polite live region, and every outcome is said in words, never by colour
// or motion alone.
export function FixButton({ action = 'recheck', gone, onFixed, className = '' }) {
  const t = useT();
  const fix = useCloudFix();
  const check = useRecheck();
  const [outcome, setOutcome] = useState(null); // null | { kind: 'fixed'|'still'|'error', at?, text?, raw? }
  const run = async () => {
    setOutcome(null);
    const out = await check.run(async () => {
      try {
        const r = await fix(action, gone);
        return r.fixed ? { kind: 'fixed', key: 'fixed', r } : { kind: 'still', key: 'still', r };
      } catch (err) {
        return { kind: 'error', ...humanizeAction(err, t, { fallbackKey: 'connection.issue.checkFailed' }) };
      }
    });
    if (out.kind === 'fixed') {
      setOutcome({ kind: 'fixed' });
      onFixed?.();
      await wait(COLLAPSE_MS);
      out.r.commit();
      return;
    }
    if (out.kind === 'still') {
      out.r.commit();
      setOutcome({ kind: 'still', at: out.r.checkedAt });
    } else {
      setOutcome({ kind: 'error', text: out.text, raw: out.raw });
    }
    throw NOT_YET;
  };
  const Icon = outcome?.kind === 'fixed' ? Check : action === 'resend' ? Send : RefreshCw;
  const line = outcome?.kind === 'fixed' ? t('connection.issue.fixed')
    : outcome?.kind === 'still' ? (check.again || t('connection.issue.still', { time: fmtTime(outcome.at) }))
      : outcome?.kind === 'error' ? [outcome.text, check.again].filter(Boolean).join(' ') : '';
  return (
    <div className={`flex flex-col items-start gap-1 ${className}`}>
      <ActionButton
        onAction={run}
        icon={Icon}
        labels={{ idle: action === 'resend' ? t('connection.issue.resend') : t('connection.issue.recheck') }}
        className={TAP_TARGET}
      />
      <span className="flex items-start gap-1">
        <p aria-live="polite" className={!line ? 'sr-only' : outcome?.kind === 'error' ? 'text-[11px] text-red-600 dark:text-red-300' : 'text-[11px] text-zinc-500 dark:text-zinc-400'}>{line}</p>
        {outcome?.kind === 'error' ? <InfoTip label={outcome.raw && outcome.raw !== outcome.text ? outcome.raw : null} /> : null}
      </span>
    </div>
  );
}

// The fix for a reason line (a state without an issue row), or nothing. "Raise limit" is a
// plain step to wherever the cap lives (the caller's onRaiseCap); the rest are FixButtons.
export function ReasonAction({ reason, clientId = null, gone, onRaiseCap }) {
  const t = useT();
  const action = reasonAction(reason);
  if (!action) return null;
  if (action === 'raise') {
    if (!onRaiseCap) return null;
    return (
      <Button size="sm" variant="subtle" className={TAP_TARGET} onClick={() => onRaiseCap()}>
        {t('connection.issue.raiseCap')}
        <ArrowRight size={12} aria-hidden="true" />
      </Button>
    );
  }
  return <FixButton action={action} gone={gone || reasonGone(reason, clientId)} />;
}

// The handover glyph for a connectivity row: the cloud (crossed out when unreachable) hands
// over to this Mac, whose green dot pulses while it publishes. The full sentence rides the
// real tooltip (focus-reachable) and is the glyph's accessible name.
function Handover({ issue }) {
  const t = useT();
  const sentence = issueMessage(issue, t);
  const From = issue.kind === 'unreachable' ? CloudOff : CloudIcon;
  return (
    <Tip label={sentence}>
      <span
        role="img"
        tabIndex={0}
        aria-label={sentence}
        className="inline-flex min-h-[28px] items-center gap-1.5 rounded-lg text-[11px] text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-300"
      >
        <From size={14} className="shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
        <ArrowRight size={12} className="shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden="true" />
        <span className="relative inline-flex shrink-0">
          <Laptop size={14} aria-hidden="true" />
          <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-emerald-500 motion-safe:animate-pulse" aria-hidden="true" />
        </span>
        <span aria-hidden="true">{t('connection.issue.handover')}</span>
      </span>
    </Tip>
  );
}

// Where + when for a row. A connectivity row gets an explicit clock time (a relative
// "2 minutes ago" beside "unreachable" read as a contradiction): "last reached HH:MM" for an
// unreachable cloud, "last active HH:MM" (the worker's last heartbeat) for a stale one, whose
// cloud still answers.
function issueWhere(issue, showProject, t) {
  if (CONNECTIVITY.has(issue.kind)) {
    if (!issue.lastOkAt) return '';
    return t(issue.kind === 'worker_stale' ? 'connection.issue.lastActive' : 'connection.issue.lastReached', { time: fmtTime(issue.lastOkAt) });
  }
  const when = issue.at ? fmtRelative(issue.at) : '';
  return [showProject ? issue.clientName : null, laneLabel(issue.lane), when].filter(Boolean).join(' · ');
}

// One issue as a compact list row: headline, where + when, then either the handover glyph
// (connectivity) or the plain message (raw platform text on hover), and the single action.
// A fixed row fades (200 ms) and folds (COLLAPSE_MS) before the fresh data drops it.
export function CloudIssueRow({ issue, showProject = false, onAction }) {
  const t = useT();
  const [leaving, setLeaving] = useState(false);
  const where = issueWhere(issue, showProject, t);
  const action = issueAction(issue);
  const connectivity = CONNECTIVITY.has(issue.kind);
  const raw = issue.kind === 'post' && typeof issue.message === 'string' ? issue.message : undefined;
  return (
    <li className={`grid transition-[grid-template-rows] duration-[400ms] ease-out motion-reduce:transition-none ${leaving ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]'}`}>
      <div className={`min-h-0 overflow-hidden transition-opacity duration-200 motion-reduce:transition-none ${leaving ? 'opacity-0' : ''}`}>
        <div className="space-y-1 rounded-xl bg-zinc-100/70 px-3 py-2 dark:bg-zinc-800/50">
          <p className="flex items-center gap-1.5 text-[11px] font-bold text-zinc-700 dark:text-zinc-200">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${issueDot(issue)}`} aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate" title={issueLabel(issue, t)}>{issueLabel(issue, t)}</span>
          </p>
          {where ? <p className="truncate text-[11px] text-zinc-600 dark:text-zinc-400">{where}</p> : null}
          {connectivity ? null : (
            <p className="break-words text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-300" title={raw}>{issueMessage(issue, t)}</p>
          )}
          {issue.terminal ? <p className="text-[11px] font-bold text-red-600 dark:text-red-400">{t('connection.issue.terminal')}</p> : null}
          {connectivity ? (
            <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5 pt-0.5">
              <Handover issue={issue} />
              <FixButton gone={issueGone(issue)} onFixed={() => setLeaving(true)} />
            </div>
          ) : action === 'retrying' ? (
            <p className="text-[11px] text-zinc-600 dark:text-zinc-400">{t('connection.issue.retrying')}</p>
          ) : action && onAction ? (
            <Button size="sm" variant="subtle" className={`${TAP_TARGET} mt-0.5`} onClick={() => onAction(issue, action)}>
              {action === 'reconnect' ? t('connection.issue.reconnect') : t('connection.issue.openPost')}
              <ArrowRight size={12} aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      </div>
    </li>
  );
}
