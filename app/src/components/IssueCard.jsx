// IssueCard - what happened, why, and the ONE fix, for a post that is Blocked or Waiting on
// you (lib/postIssue.js). Promoted from the PostDetail failure banner (the same sentences, the
// same one-verb rule), so a blocked post gets the card it never had: before, it showed only a
// "Blocked: connect X" link deep in the Delivery section.
//
// Three answers in one block: what happened (the title), why (the existing plain sentence from
// lib/failureCopy.js; the platform's raw words stay a tooltip), and the one action that gets
// out of it (IssueFixButton). The engine's own facts (code, lane, last attempt, attempts) sit
// behind a "Details" disclosure for whoever wants them, never in the owner's way.
//
// One red per card (D2): a needs-you card wears the red alert frame and title, its sentences
// are neutral ink. A blocked card is amber, the blocked pill's tone: nothing has failed yet,
// the owner just has a connection to make.
import { ExternalLink, PlugZap, ShieldX } from 'lucide-react';
import { usePendpostHealth } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { fmtFull, fmtRelative, liveFailure, X_PORTAL_URL } from '../lib/format.js';
import { humanizeFailure, laneLabel } from '../lib/failureCopy.js';
import IssueFixButton from './IssueFixButton.jsx';

// The title for an issue: the gone thread, the cloud wait, a lane that is not connected, or
// the lane that refused the post.
function titleFor(issue, failure, t) {
  const type = issue.fix.type;
  if (type === 'discard') return t('postDetail.failure.targetGoneTitle');
  if (type === 'cloud') return t('postDetail.failure.cloudWaitTitle');
  if (type === 'connect') return t('issue.title.connect', { lanes: (issue.lanes || [issue.lane]).map(laneLabel).join(', ') });
  return t('postDetail.failure.title', { lane: laneLabel(failure?.lane || issue.lane) || t('postDetail.failure.laneUnknown') });
}

// The line beside the fix button: what waiting on you means for this state.
function needsFor(issue, failure, t) {
  const type = issue.fix.type;
  if (type === 'discard') return t('postDetail.failure.targetGone');
  if (type === 'resume') return t('postDetail.failure.creditsHalted');
  if (type === 'connect') return null;
  return t(`postDetail.failure.needs.${type}`, { lane: laneLabel(failure?.lane || issue.lane) || t('postDetail.failure.laneUnknown') });
}

export default function IssueCard({ post, issue, onNavigate, onEdit, onDiscard, onHandOff, onMarkPosted, handedOff }) {
  const t = useT();
  const { data: health } = usePendpostHealth(true);
  if (!post || !issue) return null;
  const failure = liveFailure(post);
  const blocked = issue.kind === 'blocked';
  const type = issue.fix.type;
  // WHY, in one plain sentence. A connect issue (never connected) has its own sentence: the
  // failure copy for it would only repeat the title. A failure nothing specific is known about
  // adds no line (it would repeat the headline).
  const copy = failure && type !== 'connect' ? humanizeFailure(failure, t) : null;
  const why = type === 'connect' ? t('issue.connect.why') : copy?.known ? copy.text : null;
  const needs = needsFor(issue, failure, t);
  // A halted lane's top-up link, single-sourced from the setup payload the Setup page reads.
  const portalUrl = type === 'resume'
    ? (health?.setup?.platforms?.find((r) => r.platform === issue.lane)?.playbook?.portalUrl || (issue.lane === 'x' ? X_PORTAL_URL : null))
    : null;
  const attempts = Array.isArray(post.attempts)
    ? post.attempts.filter((a) => a && a.ok === false && (!failure?.lane || a.platform === failure.lane)).length
    : null;
  const details = [
    issue.code ? [t('issue.details.code'), issue.code] : null,
    [t('issue.details.lane'), (issue.lanes || [issue.lane]).map(laneLabel).join(', ')],
    failure?.at ? [t('issue.details.lastAttempt'), fmtFull(failure.at)] : null,
    attempts ? [t('issue.details.attempts'), String(attempts)] : null,
  ].filter(Boolean);

  return (
    <div
      role={blocked ? 'status' : 'alert'}
      className={`space-y-2 rounded-xl px-3 py-2.5 ring-1 ${blocked ? 'bg-amber-500/10 ring-amber-500/25' : 'bg-red-500/10 ring-red-500/25'}`}
    >
      <p
        className={`flex items-start gap-1.5 text-xs font-bold ${blocked ? 'text-amber-800 dark:text-amber-300' : 'text-red-700 dark:text-red-300'}`}
        title={copy && !copy.known ? copy.raw || undefined : undefined}
      >
        {blocked
          ? <PlugZap size={13} aria-hidden="true" className="mt-px shrink-0" />
          : <ShieldX size={13} aria-hidden="true" className="mt-px shrink-0" />}
        {titleFor(issue, failure, t)}
        {/* WHEN it failed, or a day-old refusal reads as breaking news. */}
        {failure?.at ? <span className="mt-px shrink-0 font-normal opacity-70">{fmtRelative(failure.at)}</span> : null}
      </p>
      {why ? (
        <p className="text-[11px] text-zinc-600 dark:text-zinc-300" title={copy?.raw || undefined}>{why}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {needs ? <p className="min-w-0 flex-1 text-[11px] text-zinc-600 dark:text-zinc-300">{needs}</p> : <span className="flex-1" />}
        {portalUrl ? (
          <a
            href={portalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 rounded text-[11px] font-bold text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light"
          >
            <ExternalLink size={11} aria-hidden="true" /> {t('action.topUpCredits')}
          </a>
        ) : null}
        <IssueFixButton
          issue={issue}
          post={post}
          onNavigate={onNavigate}
          onEdit={onEdit}
          size="sm"
          onDiscard={onDiscard}
          onHandOff={onHandOff}
          onMarkPosted={onMarkPosted}
          handedOff={handedOff}
        />
      </div>
      <details className="group text-[11px] text-zinc-600 dark:text-zinc-300">
        <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1 rounded font-bold text-zinc-500 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-200">
          {t('issue.details')}
        </summary>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 pb-1">
          {details.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-zinc-500 dark:text-zinc-400">{k}</dt>
              <dd className="min-w-0 break-words font-mono">{v}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}
