// NeedsYouTray - the "Needs you" strip at the top of the planner (studio fix flow 2026-11-01,
// package C). It replaces the Readiness panel there: one line per thing the owner must do,
// each with its ONE fix, and nothing at all when there is nothing to do (no celebratory
// empty state; the calm planner IS the all-clear).
//
// Lines, in order:
//   1. the system rows (lib/needsYou.js systemRows), first because each one holds up every
//      post at once: the cloud needs a look -> Check again (POST /api/cloud/recheck), the
//      scheduler is off -> Start, a halted lane -> Resume, a Meta action block -> Setup, the
//      manifest or the settings file cannot be read, an approved post past due that no fix
//      covers -> Open;
//   2. one per root cause (lib/postIssue.js groupIssues, needs-you before blocked, most posts
//      first): "Bluesky not connected · 4 replies [Connect]". A lane-wide fix (connect,
//      reconnect, resume, cloud) runs ONCE for the whole group through IssueFixButton: one
//      connect ceremony releases every post held on that cause. A per-post fix (edit, manual,
//      discard) runs inline for a single post and reviews the posts one by one otherwise;
//   3. "Agent fixed N posts, ready to approve -> Review" (lib/agentFix.js doneFixes, only the
//      posts still waiting for a fresh approval).
// At scale the tray shows the first three lines and folds the rest into one "n more" row
// that expands in place (polish 2026-11-01), so a long list never pushes the planner away.
// Every line keeps its action on the same line, right-aligned, on a phone too.
// The title count is the header badge's count (format.js attentionSummary): every grouped
// post plus every system row, worn in the SAME needs-you mark as the badge (format.js
// NEEDS_YOU_MARK: the halted rose stop + TriangleAlert). The groups and rows arrive as props
// from App, which computes them once for both, so the badge and the tray can never disagree.
import { useState } from 'react';
import { useIsPhone } from '../lib/useIsPhone.js';
import { useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Bot, ChevronDown, ChevronRight, ChevronUp, CloudAlert, Cloud as CloudIcon, FileWarning, Loader2, PauseCircle, Play, ShieldAlert, TriangleAlert } from 'lucide-react';
import { setSchedulerRunning } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { laneLabel } from '../lib/failureCopy.js';
import { postDisplayTitle, NEEDS_YOU_MARK } from '../lib/format.js';
import { needsYouCount } from '../lib/needsYou.js';
import { useAgentFixes, doneFixes } from '../lib/agentFix.js';
import { canApprovePost } from '../lib/postActions.js';
import IssueFixButton from './IssueFixButton.jsx';
import { FixButton, reasonGone } from './CloudIssues.jsx';
import { PLATFORM_META } from './ui.jsx';
import { Button } from './ui/Button.jsx';
import { TAP_TARGET, PROJECT_CHIP } from './ui/recipes.js';
import { ClientAvatar } from './ClientSwitcher.jsx';

// The fixes that act on a whole cause at once; every other fix acts on one post.
const GROUP_FIXES = new Set(['connect', 'reconnect', 'resume', 'cloud']);
// The causes whose button already says the verb ("Connect", "Reconnect"): on a phone their
// line shortens to "LinkedIn · 4 posts" so the button keeps its place on the same line.
const SHORT_ON_PHONE = new Set(['connect', 'reconnect']);
// How many lines show before the rest fold into "n more".
export const TRAY_CAP = 3;

const SYSTEM_GLYPH = 'shrink-0 text-zinc-500 dark:text-zinc-400';

function LaneGlyph({ lane, fallback: Fallback = AlertCircle }) {
  const meta = PLATFORM_META[lane];
  if (meta) return <meta.Icon size={15} className={`shrink-0 ${meta.color}`} aria-hidden="true" />;
  return <Fallback size={15} className={SYSTEM_GLYPH} aria-hidden="true" />;
}

// "4 replies" when every post is a Radar reply, "4 posts" otherwise.
function countLabel(posts, t) {
  const n = posts.length;
  const replies = n > 0 && posts.every((p) => p.radarReplyTo);
  const base = replies ? 'tray.count.replies' : 'tray.count.posts';
  return n === 1 ? t(`${base}.one`) : t(base, { count: n });
}

function causeLabel(group, t) {
  const lane = laneLabel(group.lane);
  return t(`tray.cause.${group.fix?.type || 'connect'}`, { lane });
}

// One tray line: glyph, the words, then the action pushed right, on ONE line at every width
// (the words take what is left and wrap or truncate inside their own column; the action never
// drops under them).
function Row({ glyph, children, action }) {
  return (
    <li className="flex items-center gap-3 py-2">
      <span className="grid w-5 shrink-0 place-items-center">{glyph}</span>
      <div className="min-w-0 flex-1 text-sm">{children}</div>
      {action ? <div className="flex shrink-0 items-center">{action}</div> : null}
    </li>
  );
}

export default function NeedsYouTray({
  groups = [], system = [], posts = [], setupReady, allClients = false, activeClientId = null,
  onNavigate, onOpenPost, onEdit, onReview,
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [starting, setStarting] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const phone = useIsPhone();
  const { data: fixData } = useAgentFixes({ all: allClients });
  // The agent changed these posts and they wait for a fresh approval. A fix the owner already
  // approved (or a post that is gone) no longer asks for anything.
  const fixed = doneFixes(fixData).filter((f) => {
    const post = posts.find((p) => p.campaign === f.campaign && p.id === f.postId && (!f.clientId || !p.clientId || p.clientId === f.clientId));
    return post && canApprovePost(post);
  });
  const count = needsYouCount(groups, system);
  if (!groups.length && !system.length && !fixed.length) return null;

  const startScheduler = async () => {
    if (starting) return;
    setStarting(true);
    try {
      await setSchedulerRunning(true);
    } finally {
      setStarting(false);
      queryClient.invalidateQueries({ queryKey: ['pendpost-health'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['plans'] });
    }
  };

  // The project is named when it is not obvious: in All-projects mode, or for a cause that
  // belongs to a project other than the one in view.
  const projectChip = (post) => (post?.clientName && (allClients || (post.clientId && post.clientId !== activeClientId)) ? (
    <span className={`${PROJECT_CHIP} ml-2 max-w-[8rem] align-middle`}>
      <ClientAvatar client={{ displayName: post.clientName, accent: post.accent, logo: null }} size={14} />
      <span className="truncate">{post.clientName}</span>
    </span>
  ) : null);

  const reviewButton = (label, aria, onClick) => (
    <Button size="sm" variant="subtle" className={TAP_TARGET} onClick={onClick} aria-label={aria}>
      {label}
      <ChevronRight size={13} aria-hidden="true" />
    </Button>
  );

  // The same fix component and variant as the List row's status line (IssueFixButton, its
  // default subtle look, size sm), so a fix looks the same wherever it sits.
  const groupAction = (group) => {
    const issue = { ...group, lanes: group.lanes || [group.lane], code: null };
    if (GROUP_FIXES.has(group.fix?.type) || group.posts.length === 1) {
      // The group's project rides along, so App re-scopes before Setup opens for it.
      const nav = group.clientId ? (p, platform, opts) => onNavigate?.(p, platform, opts, group.clientId) : onNavigate;
      return <IssueFixButton issue={issue} post={group.posts[0]} onNavigate={nav} onEdit={onEdit} size="sm" />;
    }
    return reviewButton(t('tray.review'), t('tray.reviewAria', { count: group.posts.length }), () => onOpenPost?.(group.posts[0], group.posts));
  };

  const systemRow = (row) => {
    switch (row.type) {
      case 'cloud': {
        // The cloud holds up every always-on project at once: its short reason, the projects
        // it affects, and the one fix a probe can give (Check again, POST /api/cloud/recheck).
        const reasonKey = `delivery.reason.${row.reason}`;
        const reasonText = t(reasonKey) !== reasonKey ? t(reasonKey) : t(row.health === 'red' ? 'delivery.reason.red' : 'delivery.reason.amber');
        return (
          <Row
            key={row.key}
            glyph={<CloudAlert size={15} className={SYSTEM_GLYPH} aria-hidden="true" />}
            action={<FixButton action="recheck" gone={reasonGone(row.reason)} />}
          >
            <span className="block truncate">
              <span className="font-medium">{reasonText}</span>
              {row.names.length ? (
                <span className="text-zinc-500 dark:text-zinc-400"> · {t('tray.cloud.affects', { names: row.names.join(', ') })}</span>
              ) : null}
            </span>
          </Row>
        );
      }
      case 'scheduler': {
        // The same gate as the sidebar toggle (US-ONB-10): with Setup unfinished the scheduler
        // waits, so the row's one step is Setup, said in words, never a greyed-out Start.
        if (setupReady === false) {
          return (
            <Row
              key={row.key}
              glyph={<PauseCircle size={15} className={SYSTEM_GLYPH} aria-hidden="true" />}
              action={reviewButton(t('tray.system.openSetup'), undefined, () => onNavigate?.('setup'))}
            >
              {t('tray.system.schedulerWaiting')}
            </Row>
          );
        }
        return (
          <Row
            key={row.key}
            glyph={<PauseCircle size={15} className={SYSTEM_GLYPH} aria-hidden="true" />}
            action={(
              <Button size="sm" variant="subtle" className={TAP_TARGET} onClick={startScheduler} disabled={starting} aria-busy={starting || undefined}>
                {starting ? <Loader2 size={13} className="motion-safe:animate-spin" aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}
                {t('tray.system.start')}
              </Button>
            )}
          >
            {t('tray.system.scheduler')}
          </Row>
        );
      }
      case 'resume': {
        const issue = { kind: 'needs-you', lane: row.lane, lanes: [row.lane], clientId: null, cause: `resume:${row.lane}`, code: null, fix: { type: 'resume', lane: row.lane, agent: false } };
        return (
          <Row key={row.key} glyph={<LaneGlyph lane={row.lane} />} action={<IssueFixButton issue={issue} post={null} onNavigate={onNavigate} size="sm" />}>
            {t('tray.cause.resume', { lane: laneLabel(row.lane) })}
          </Row>
        );
      }
      case 'actionBlock':
        return (
          <Row
            key={row.key}
            glyph={<ShieldAlert size={15} className={SYSTEM_GLYPH} aria-hidden="true" />}
            action={reviewButton(t('tray.system.openSetup'), undefined, () => onNavigate?.('setup', 'meta'))}
          >
            {t('tray.system.actionBlock', { label: row.label })}
          </Row>
        );
      case 'manifest':
      case 'config':
        return (
          <Row key={row.key} glyph={<FileWarning size={15} className="shrink-0 text-red-700 dark:text-red-300" aria-hidden="true" />}>
            {t(`tray.system.${row.type}`)}
          </Row>
        );
      case 'post': {
        const post = row.post || { campaign: row.campaign, id: row.postId };
        return (
          <Row
            key={row.key}
            glyph={<LaneGlyph lane={row.post?.platforms?.[0]} />}
            action={reviewButton(t('tray.system.open'), undefined, () => onOpenPost?.(post))}
          >
            <span className="block truncate">{t('tray.system.post', { title: postDisplayTitle(row.post, row.postId) })}</span>
          </Row>
        );
      }
      default:
        return null;
    }
  };

  const groupRow = (group) => {
    const short = SHORT_ON_PHONE.has(group.fix?.type);
    return (
      <Row
        key={`${group.clientId ?? ''}|${group.cause}`}
        glyph={group.fix?.type === 'cloud' ? <CloudIcon size={15} className={SYSTEM_GLYPH} aria-hidden="true" /> : <LaneGlyph lane={group.lane} />}
        action={groupAction(group)}
      >
        <span className="block truncate">
          {/* On a phone a connect cause reads "LinkedIn · 4 posts": the button beside it says
              the verb. From sm up the full cause. */}
          {short ? <span className="font-medium sm:hidden">{laneLabel(group.lane)}</span> : null}
          <span className={`font-medium ${short ? 'hidden sm:inline' : ''}`}>{causeLabel(group, t)}</span>
          <span className="text-zinc-500 dark:text-zinc-400"> · {countLabel(group.posts, t)}</span>
          {projectChip(group.posts[0])}
        </span>
      </Row>
    );
  };

  const lines = [
    ...system.map(systemRow).filter(Boolean),
    ...groups.map(groupRow),
    fixed.length ? (
      <Row
        key="agent-done"
        glyph={<Bot size={15} className="shrink-0 text-brand dark:text-brand-light" aria-hidden="true" />}
        action={reviewButton(t('tray.review'), undefined, () => onReview?.())}
      >
        {fixed.length === 1 ? t('tray.agent.done.one') : t('tray.agent.done', { count: fixed.length })}
      </Row>
    ) : null,
  ].filter(Boolean);
  const foldable = lines.length > TRAY_CAP;
  const hidden = foldable && !expanded ? lines.length - TRAY_CAP : 0;
  const phoneFolded = phone && !expanded && lines.length > 0;
  const shown = phoneFolded ? [] : hidden ? lines.slice(0, TRAY_CAP) : lines;

  return (
    <section id="planner-tray" aria-labelledby="planner-tray-title" className="glass-panel scroll-mt-4 rounded-2xl px-4 py-2.5">
      <div className="flex items-center gap-2">
        <h2 id="planner-tray-title" className="flex items-center gap-2 pt-0.5 text-sm font-bold tracking-tight">
          {t('tray.title')}
          {count ? (
            <span data-needs-you-mark="" className={`${NEEDS_YOU_MARK} rounded-full px-2 py-0.5`}>
              <TriangleAlert size={12} aria-hidden="true" />
              <span className="text-xs font-bold tabular-nums">{count}</span>
            </span>
          ) : null}
        </h2>
        {phoneFolded ? (
          <button
            type="button"
            aria-expanded={false}
            aria-controls="planner-tray-list"
            data-tray-unfold=""
            onClick={() => setExpanded(true)}
            className={`${TAP_TARGET} ml-auto flex items-center gap-1 rounded-lg px-1 py-1 text-xs font-semibold text-zinc-600 transition hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-300 dark:hover:text-white`}
          >
            {t('tray.show')}
            <ChevronDown size={13} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      <ul id="planner-tray-list" className="divide-y divide-zinc-900/[0.06] dark:divide-white/10">
        {shown}
        {(foldable && !phoneFolded) || (phone && expanded) ? (
          <li className="py-1">
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls="planner-tray-list"
              onClick={() => setExpanded((v) => !v)}
              className={`${TAP_TARGET} flex items-center gap-1.5 rounded-lg px-1 py-1 text-xs font-semibold text-zinc-600 transition hover:text-zinc-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-300 dark:hover:text-white`}
            >
              {expanded ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}
              {expanded ? t('tray.less') : t('tray.more', { count: lines.length - TRAY_CAP })}
            </button>
          </li>
        ) : null}
      </ul>
    </section>
  );
}
