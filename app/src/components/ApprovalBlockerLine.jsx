// ApprovalBlockerLine - the approval card's ONE line for a post that cannot be approved yet
// (Freigaben error UX, 2026-11-06). It replaces the boxed "Vor der Veröffentlichung" panel:
//
//   [platform glyph] short cause [?]  [+n]           [agent] [copy brief] [turn on] [without]
//
// Glyphs carry the actions, words ride the tooltip and the accessible name (owner: "icons with
// intuitive design instead of texts wherever possible; text as hover"). Every glyph is a 40px
// target with a visible focus ring.
//   - agent: the existing IssueFixButton agent path (POST .../agent-fix), shown only when the
//     post's project has an agent and some cause is one the agent can fix (not a connection,
//     not a turned-off platform that is the post's only one);
//   - copy brief: a self-contained prompt for ANY agent session (lib/approvalBlockers.js
//     fixBrief), the glyph turns into a check for 1.5 s;
//   - a platform the project turned off (validate.fbDisabled): turn it on for THIS post's
//     project (posting.platforms, scoped by clientId), or drop it from this post. "Without" is
//     hidden when it is the post's only platform; "turn on" when an ops lock holds it off.
// A failed write says so in one line with a retry, right under the row.
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, CircleMinus, Copy, Loader2, RotateCcw, ToggleRight } from 'lucide-react';
import { setPlatformEnabled, updatePost } from '../lib/api.js';
import { useT, tCount } from '../lib/i18n.js';
import { laneLabel, humanizeAction } from '../lib/failureCopy.js';
import { shortCause, fullCause, offPlatformOf, agentCanFix, fixBrief } from '../lib/approvalBlockers.js';
import { PLATFORM_META } from './ui.jsx';
import { Tip } from './ui/Tooltip.jsx';
import InfoTip from './ui/InfoTip.jsx';
import IssueFixButton from './IssueFixButton.jsx';

export const COPY_CONFIRM_MS = 1500;

// The house glyph button: 40px, a visible focus ring, the name on hover and for a screen reader.
export function GlyphButton({ icon: Icon, label, onClick, busy = false, disabled = false, tone = 'neutral', className = '', ...rest }) {
  const ink = tone === 'brand'
    ? 'text-brand hover:bg-brand/10 dark:text-brand-light'
    : 'text-zinc-600 hover:bg-zinc-900/5 hover:text-brand dark:text-zinc-300 dark:hover:bg-white/10 dark:hover:text-brand-light';
  return (
    <Tip label={label}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled || busy}
        aria-label={label}
        aria-busy={busy || undefined}
        className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 ${ink} ${className}`}
        {...rest}
      >
        {busy ? <Loader2 size={16} className="motion-safe:animate-spin" aria-hidden="true" /> : <Icon size={16} aria-hidden="true" />}
      </button>
    </Tip>
  );
}

// A platform glyph, struck through when `off` (a lane that is not connected or turned off).
export function PlatformGlyph({ platform, off = false, size = 13, muted = false }) {
  const meta = PLATFORM_META[platform];
  if (!meta) return null;
  const { Icon } = meta;
  return (
    <span data-platform={platform} data-off={off ? '' : undefined} className="relative inline-flex shrink-0 items-center justify-center" aria-hidden="true">
      <Icon size={size} className={muted || off ? 'text-zinc-500 dark:text-zinc-400' : meta.color} />
      {off ? (
        <span className="absolute left-1/2 top-1/2 h-[1.5px] w-[130%] -translate-x-1/2 -translate-y-1/2 -rotate-45 rounded bg-zinc-500 ring-1 ring-white dark:bg-zinc-400 dark:ring-zinc-900" />
      ) : null}
    </span>
  );
}

// The post-detail-shaped issue an IssueFixButton needs to run the agent on a preflight cause.
export function preflightIssue(post, blocker) {
  const lane = blocker?.platform || post?.platforms?.[0] || null;
  return {
    kind: 'needs-you', lane, lanes: [lane], clientId: post?.clientId ?? null,
    cause: `edit:${lane}`, code: blocker?.code || null, fix: { type: 'edit', lane, agent: true },
  };
}

export default function ApprovalBlockerLine({ post, blockers = [], offlineLanes = [], setup = null, className = '' }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(null); // 'on' | 'without' | null
  const [failed, setFailed] = useState(null); // { text, raw, retry }
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  if (!blockers.length) return null;

  const first = blockers[0];
  const rest = blockers.slice(1);
  const short = shortCause(t, first);
  const full = fullCause(t, first);
  const off = blockers.find(offPlatformOf) || null;
  const offPlatform = off ? offPlatformOf(off) : null;
  const offName = offPlatform ? laneLabel(offPlatform) : '';
  const remaining = offPlatform ? (post.platforms || []).filter((p) => p !== offPlatform) : [];
  const canTurnOn = Boolean(offPlatform) && off.params?.locked !== true;
  const canDrop = Boolean(offPlatform) && remaining.length > 0;
  // The agent glyph only when some cause is one the agent can fix (lib/approvalBlockers.js).
  const agentBlocker = blockers.find((b) => agentCanFix(b, post)) || null;

  const refresh = () => {
    for (const key of ['platform-validate', 'config', 'pendpost-health', 'plans']) queryClient.invalidateQueries({ queryKey: [key] });
  };
  const write = async (kind, fn) => {
    setFailed(null);
    setBusy(kind);
    try {
      await fn();
      refresh();
    } catch (err) {
      setFailed({ ...humanizeAction(err, t, { fallbackKey: 'approvals.blocker.failed' }), retry: () => write(kind, fn) });
    } finally {
      setBusy(null);
    }
  };
  const turnOn = () => write('on', () => setPlatformEnabled(offPlatform, true, post.clientId || undefined));
  const drop = () => write('without', () => updatePost(post.campaign, post.id, post.rev, { platforms: remaining }, post.clientId || undefined));
  const copy = async () => {
    setFailed(null);
    try {
      await navigator.clipboard.writeText(fixBrief({ post, blockers, offlineLanes }));
    } catch (err) {
      setFailed({ text: t('approvals.blocker.copyFailed'), raw: err?.message || null, retry: copy });
      return;
    }
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPY_CONFIRM_MS);
  };
  const moreTip = rest.length ? rest.map((b) => fullCause(t, b)).join(' · ') : '';

  return (
    // Layout (live walks 2026-11-06: "Facebook is o..." in the grid, "F" at 375px, then a
    // nowrap cause running past the card edge at 375px): the cause never truncates. It claims a
    // 12rem basis, so a narrow row moves the glyph buttons below it, and its words wrap inside
    // the card instead of overflowing it.
    <div data-blocker-line="" className={`flex flex-col gap-0.5 ${className}`}>
      <div data-blocker-row="" className="flex flex-wrap items-center gap-x-1.5">
        <span className="flex min-w-0 flex-[1_1_12rem] items-center gap-x-1.5">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <PlatformGlyph platform={first.platform} off={Boolean(offPlatformOf(first))} />
            <span data-blocker-short="" className="min-w-0 break-words text-xs font-medium text-rose-700 dark:text-rose-300">{short}</span>
          </span>
          <InfoTip label={full} />
          {rest.length ? (
            <Tip label={moreTip}>
              <span tabIndex={0} aria-label={`${tCount(t, 'approvals.blocker.more', rest.length)}: ${moreTip}`} className="-ml-2 shrink-0 rounded px-1 text-[11px] font-bold tabular-nums text-zinc-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400">
                +{rest.length}
              </span>
            </Tip>
          ) : null}
        </span>
        <span data-blocker-actions="" className="ml-auto flex shrink-0 flex-wrap items-center">
          {agentBlocker ? (
            <IssueFixButton issue={preflightIssue(post, agentBlocker)} post={post} setup={setup} iconOnly agentOnly />
          ) : null}
          <GlyphButton icon={copied ? Check : Copy} label={copied ? t('approvals.blocker.copied') : t('approvals.blocker.copyBrief')} onClick={copy} aria-live="polite" />
          {canTurnOn ? (
            <GlyphButton icon={ToggleRight} label={t('approvals.blocker.platformOnTip', { platform: offName })} busy={busy === 'on'} disabled={Boolean(busy)} onClick={turnOn} data-action="platform-on" />
          ) : null}
          {canDrop ? (
            <GlyphButton icon={CircleMinus} label={t('approvals.blocker.withoutTip', { platform: offName })} busy={busy === 'without'} disabled={Boolean(busy)} onClick={drop} data-action="platform-drop" />
          ) : null}
        </span>
      </div>
      {failed ? (
        <div className="flex items-center gap-1">
          <p role="alert" className="text-[11px] text-red-600 dark:text-red-300">{failed.text}</p>
          <InfoTip label={failed.raw && failed.raw !== failed.text ? failed.raw : null} />
          <GlyphButton icon={RotateCcw} label={t('approvals.blocker.retry')} onClick={failed.retry} />
        </div>
      ) : null}
    </div>
  );
}
