import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  MessageSquare, Send, ExternalLink, ShieldAlert, CornerDownRight, AlertCircle,
  Shield, EyeOff, Eye, Trash2, Check, Clock, Ban, CircleSlash,
  ThumbsUp, Award, HeartHandshake, Sparkles, Lightbulb, PartyPopper, Heart, Repeat2, Smile,
} from 'lucide-react';
import { fmtRelative } from '../lib/format.js';
import { useComments, replyToComment, moderateComment, reactToPost } from '../lib/api.js';
import { PLATFORM_META, INNER_SURFACE, EYEBROW, DISABLED_PRIMARY } from './ui.jsx';
import { useLint, LintPanel } from './Composer.jsx';
import HistoryChip from './HistoryChip.jsx';
import { useT } from '../lib/i18n.js';

// The inbound-engagement (inbox) thread panel (spec 02, Pattern P6; moderation is
// spec 06). Rendered as a <Section> inside PostDetail's bodyLeft when the operator
// opens Comments on a POSTED post that reached a comment-capable lane. It reads the
// normalized comments (pull-on-demand, never persisted), lets the operator reply
// inline AND moderate each row (hide/delete/hold/approve/spam/remove) - both run
// through the same mutation -> invalidateQueries(['plans']) path as every other
// write, plus a panel refetch. Every state is icon+text (never color-only); the
// moderation overflow lists ONLY the lane's supported actions (from the read's
// moderateActions - GUI honesty), and Delete routes through an inline confirm step.
const FIELD_CLS = `w-full rounded-xl border-0 px-3 py-2 text-sm ${INNER_SURFACE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`;

// Action -> its i18n label key + glyph (icon+text, never color-only). The keys are
// the SAME the overflow renders; `done` reuses the action label for the applied badge.
const MODERATE_LABEL = {
  hide: 'postDetail.comments.moderate.hide',
  unhide: 'postDetail.comments.moderate.unhide',
  delete: 'postDetail.comments.moderate.delete',
  approve: 'postDetail.comments.moderate.approve',
  hold: 'postDetail.comments.moderate.hold',
  spam: 'postDetail.comments.moderate.spam',
  remove: 'postDetail.comments.moderate.remove',
};
const MODERATE_ICON = {
  hide: EyeOff, unhide: Eye, delete: Trash2, approve: Check, hold: Clock, spam: Ban, remove: CircleSlash,
};
// The content-SUPPRESSING actions (mirror of lib/comments.mjs DESTRUCTIVE_MODERATE_ACTIONS):
// each routes through an inline confirm step AND posts confirm:true (spec 06 review #1/#4),
// so a suppressing action is never one-click. Restorative approve/unhide/hold execute
// immediately (no confirm) and pass confirm:false.
const DESTRUCTIVE_MODERATE_ACTIONS = new Set(['delete', 'hide', 'remove', 'spam']);
// Action -> the resulting STATE badge key (spec 06 §6): the applied row shows what the
// comment now IS (hidden/held/approved/removed/…), not the imperative verb it took.
const MODERATE_STATE = {
  hide: 'postDetail.comments.state.hidden',
  unhide: 'postDetail.comments.state.shown',
  delete: 'postDetail.comments.state.removed',
  approve: 'postDetail.comments.state.approved',
  hold: 'postDetail.comments.state.held',
  spam: 'postDetail.comments.state.spam',
  remove: 'postDetail.comments.state.removed',
};

// Reaction (spec 24) -> its i18n label key + glyph (icon+text, never color-only). The
// panel renders ONLY the lane's supported reactions (from the read's reactActions - GUI
// honesty), so it can never offer a reaction the react verb cannot perform.
const REACT_LABEL = {
  like: 'postDetail.comments.react.like',
  praise: 'postDetail.comments.react.praise',
  empathy: 'postDetail.comments.react.empathy',
  appreciation: 'postDetail.comments.react.appreciation',
  interest: 'postDetail.comments.react.interest',
  entertainment: 'postDetail.comments.react.entertainment',
  favourite: 'postDetail.comments.react.favourite',
  boost: 'postDetail.comments.react.boost',
  emoji: 'postDetail.comments.react.emoji',
};
const REACT_ICON = {
  like: ThumbsUp, praise: Award, empathy: HeartHandshake, appreciation: Sparkles,
  interest: Lightbulb, entertainment: PartyPopper, favourite: Heart, boost: Repeat2, emoji: Smile,
};
// The default emoji the Studio sends for an emoji-type reaction (telegram/discord/nostr).
// The CLI/MCP accept any --emoji; the panel stays minimal with one widely-supported glyph
// rather than a full picker (the owner's less-is-more bar - a single quick-react control).
const DEFAULT_REACT_EMOJI = '👍';

// One comment row: author + relative time + the lane glyph, the body, a permalink,
// a per-row inline reply box, and (spec 06) a per-row moderation overflow listing
// only the lane's supported actions. Optimistically-appended local replies render
// with the same row (parentId set) so the operator sees their reply immediately.
function CommentRow({ comment, lane, laneMeta, moderateActions, reactActions, onReply, onModerate, onReact, replying, t }) {
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(null);
  // S4: anti-slop lint on the reply text (same brand-lint as the Composer), scoped to the
  // comment's lane. Null until you type; lists only findings.
  const replyLint = useLint(draft, comment.platform);
  // Moderation local state (spec 06): the overflow menu, the suppressing action awaiting
  // an inline confirm (null = none), the in-flight flag, the applied-state badge, and a
  // failed-moderate message.
  const [menuOpen, setMenuOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState(null);
  const [moderating, setModerating] = useState(false);
  const [moderatedAs, setModeratedAs] = useState(null);
  const [modError, setModError] = useState(null);
  // Reaction local state (spec 24): the active reaction (null = none), the collapsed
  // picker's open flag (the multi-reaction lanes expand behind ONE control), the in-flight
  // flag, and a failed-react message. A repeat click on the active reaction un-reacts.
  const [reactedAs, setReactedAs] = useState(null);
  const [reactMenuOpen, setReactMenuOpen] = useState(false);
  const [reacting, setReacting] = useState(false);
  const [reactError, setReactError] = useState(null);
  const submit = async () => {
    const text = draft.trim();
    if (!text) return;
    setError(null);
    try {
      await onReply(comment.commentId, text, comment.author);
      setDraft('');
      setOpen(false);
    } catch (err) {
      setError(err?.message || t('postDetail.comments.error'));
    }
  };
  // A suppressing action arrives with confirm:true (the inline confirm already cleared
  // it); a restorative action with confirm:false. moderateComment gates the suppressing
  // set server-side, so this mirrors that on the client (spec 06 review #1/#4).
  const runModerate = async (action, confirm) => {
    setModError(null);
    setModerating(true);
    try {
      await onModerate(comment.commentId, action, confirm);
      setModeratedAs(action);
      setMenuOpen(false);
      setPendingAction(null);
    } catch (err) {
      setModError(err?.error === 'unsupported_action'
        ? t('postDetail.comments.moderate.unsupported')
        : (err?.message || t('postDetail.comments.moderate.error')));
    } finally {
      setModerating(false);
    }
  };
  // React / un-react (spec 24): the SAME onReact mutation path. Clicking the active
  // reaction toggles it off (remove:true); clicking another reacts (remove:false). The
  // GUI only ever shows the lane's supported reactions, so unsupported can't be reached.
  const runReact = async (reaction) => {
    setReactError(null);
    setReacting(true);
    const wasActive = reactedAs === reaction;
    try {
      // comment.author is the reacted-to comment's author - the nostr engine needs it as
      // the NIP-25 'p' tag (it is e.pubkey there); every other lane ignores it.
      await onReact(comment.commentId, reaction, wasActive, comment.author);
      setReactedAs(wasActive ? null : reaction);
    } catch (err) {
      setReactError(err?.message || t('postDetail.comments.react.error'));
    } finally {
      setReacting(false);
    }
  };
  const LaneIcon = laneMeta?.Icon;
  const canModerate = !comment.local && Array.isArray(moderateActions) && moderateActions.length > 0;
  const canReact = !comment.local && Array.isArray(reactActions) && reactActions.length > 0;
  return (
    <li className={`space-y-2 rounded-xl px-3 py-2.5 ${INNER_SURFACE} ${moderatedAs ? 'opacity-60' : ''}`}>
      <div className="flex items-center gap-2">
        {LaneIcon ? <LaneIcon size={13} className={laneMeta.color} aria-hidden="true" /> : null}
        <span className="text-sm font-bold">{comment.author || t('postDetail.comments.unknownAuthor')}</span>
        {/* Relationship memory (spec 49 R12): a quiet "Nth exchange" chip beside the author,
            at the reply moment. Covers post comments AND gbp reviews (both ride this row via
            kind:'review'). Never on an optimistic local reply (that author is "you"). */}
        {!comment.local && lane && comment.author ? <HistoryChip lane={lane} handle={comment.author} /> : null}
        {comment.ts ? <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{fmtRelative(comment.ts)}</span> : null}
        {comment.permalink ? (
          <a
            href={comment.permalink}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-auto inline-flex items-center gap-0.5 text-[11px] text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light"
          >
            <ExternalLink size={11} aria-hidden="true" /> {t('postDetail.comments.viewOriginal')}
          </a>
        ) : null}
      </div>
      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{comment.text}</p>
      {comment.local ? (
        <p className="flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-300">
          <CornerDownRight size={11} aria-hidden="true" /> {t('postDetail.comments.sent')}
        </p>
      ) : open ? (
        <div className="space-y-1.5">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={t('postDetail.comments.reply')}
            placeholder={t('postDetail.comments.replyPlaceholder')}
            rows={2}
            className={`resize-y ${FIELD_CLS}`}
          />
          <LintPanel lint={replyLint} />
          {error ? (
            <p role="alert" className="flex items-center gap-1.5 text-[11px] text-red-600 dark:text-red-300">
              <AlertCircle size={11} aria-hidden="true" /> {error}
            </p>
          ) : null}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={submit}
              disabled={replying || !draft.trim()}
              className={`inline-flex items-center gap-1.5 rounded-xl bg-brand px-2.5 py-1.5 text-xs font-bold text-white transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${DISABLED_PRIMARY}`}
            >
              <Send size={13} aria-hidden="true" /> {t('postDetail.comments.send')}
            </button>
            <button
              type="button"
              onClick={() => { setOpen(false); setDraft(''); setError(null); }}
              className="rounded-xl px-2.5 py-1.5 text-xs font-bold text-zinc-500 transition hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              {t('postDetail.comments.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="inline-flex items-center gap-1.5 text-xs font-bold text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light"
          >
            <CornerDownRight size={12} aria-hidden="true" /> {t('postDetail.comments.reply')}
          </button>
          {/* Moderation overflow (spec 06): only the lane's supported actions render. */}
          {canModerate && !moderatedAs ? (
            <button
              type="button"
              onClick={() => { setMenuOpen((v) => !v); setPendingAction(null); setModError(null); }}
              aria-expanded={menuOpen}
              className="inline-flex items-center gap-1.5 text-xs font-bold text-zinc-500 transition hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              <Shield size={12} aria-hidden="true" /> {t('postDetail.comments.moderate.menu')}
            </button>
          ) : null}
          {moderatedAs ? (
            <span className="inline-flex items-center gap-1.5 text-[11px] font-bold text-zinc-500 dark:text-zinc-400">
              <Check size={12} aria-hidden="true" /> {t(MODERATE_STATE[moderatedAs] || 'postDetail.comments.moderate.menu')}
            </span>
          ) : null}
          {/* Reaction control (spec 24): a SINGLE react affordance per row (the owner's hard
              net-simplify bar - never six inline buttons). A lane with ONE reaction (the emoji
              lanes) is a direct one-click toggle; a lane with SEVERAL (linkedin's six,
              mastodon/nostr's two) collapses behind ONE "React" disclosure that expands the
              small picker below. aria-pressed marks the active reaction - on the button itself
              for the single case, on the picker items for the collapsed case. */}
          {canReact && reactActions.length === 1 ? (() => {
            const reaction = reactActions[0];
            const RIcon = REACT_ICON[reaction] || Smile;
            const active = reactedAs === reaction;
            return (
              <button
                type="button"
                onClick={() => runReact(reaction)}
                disabled={reacting}
                aria-pressed={active}
                title={active ? t('postDetail.comments.react.remove') : undefined}
                className={`inline-flex items-center gap-1 rounded-xl px-2 py-1 text-[11px] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${DISABLED_PRIMARY} ${active ? 'bg-brand text-white' : `${INNER_SURFACE} text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100`}`}
              >
                <RIcon size={12} aria-hidden="true" /> {t(REACT_LABEL[reaction] || 'postDetail.comments.react.menu')}
              </button>
            );
          })() : canReact ? (() => {
            const TriggerIcon = reactedAs ? (REACT_ICON[reactedAs] || Smile) : Smile;
            return (
              <button
                type="button"
                onClick={() => { setReactMenuOpen((v) => !v); setReactError(null); }}
                aria-expanded={reactMenuOpen}
                className="inline-flex items-center gap-1.5 text-xs font-bold text-zinc-500 transition hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-100"
              >
                <TriggerIcon size={12} aria-hidden="true" /> {t('postDetail.comments.react.menu')}
              </button>
            );
          })() : null}
          {reactError ? (
            <span role="alert" className="inline-flex items-center gap-1 text-[11px] text-red-600 dark:text-red-300">
              <AlertCircle size={11} aria-hidden="true" /> {reactError}
            </span>
          ) : null}
        </div>
      )}
      {/* The overflow action list + an inline confirm step for the suppressing actions (spec 06). */}
      {canModerate && menuOpen && !moderatedAs && !open ? (
        <div className="space-y-1.5">
          {pendingAction ? (
            (() => {
              const ConfirmIcon = MODERATE_ICON[pendingAction] || Shield;
              return (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] font-bold text-zinc-600 dark:text-zinc-300">{t('postDetail.comments.moderate.confirmAction')}</span>
                  <button
                    type="button"
                    onClick={() => runModerate(pendingAction, true)}
                    disabled={moderating}
                    className={`inline-flex items-center gap-1.5 rounded-xl bg-red-600 px-2.5 py-1 text-[11px] font-bold text-white transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${DISABLED_PRIMARY}`}
                  >
                    <ConfirmIcon size={12} aria-hidden="true" /> {t(MODERATE_LABEL[pendingAction] || 'postDetail.comments.moderate.menu')}
                  </button>
                  <button
                    type="button"
                    onClick={() => setPendingAction(null)}
                    className="rounded-xl px-2.5 py-1 text-[11px] font-bold text-zinc-500 transition hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-100"
                  >
                    {t('postDetail.comments.cancel')}
                  </button>
                </div>
              );
            })()
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {moderateActions.map((action) => {
                const Icon = MODERATE_ICON[action] || Shield;
                const isDestructive = DESTRUCTIVE_MODERATE_ACTIONS.has(action);
                return (
                  <button
                    key={action}
                    type="button"
                    onClick={() => (isDestructive ? setPendingAction(action) : runModerate(action, false))}
                    disabled={moderating}
                    className={`inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1 text-[11px] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 ${INNER_SURFACE} ${isDestructive ? 'text-red-600 dark:text-red-300' : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100'}`}
                  >
                    <Icon size={12} aria-hidden="true" /> {t(MODERATE_LABEL[action] || 'postDetail.comments.moderate.menu')}
                  </button>
                );
              })}
            </div>
          )}
          {modError ? (
            <p role="alert" className="flex items-center gap-1.5 text-[11px] text-red-600 dark:text-red-300">
              <AlertCircle size={11} aria-hidden="true" /> {modError}
            </p>
          ) : null}
        </div>
      ) : null}
      {/* The collapsed reaction picker (spec 24): the multi-reaction lanes expand their
          supported reactions here, each an aria-pressed toggle; clicking the active one
          un-reacts. It stays open after a pick so the active state is visible + switchable. */}
      {canReact && reactMenuOpen && reactActions.length > 1 && !open ? (
        <div className="flex flex-wrap gap-1.5">
          {reactActions.map((reaction) => {
            const RIcon = REACT_ICON[reaction] || Smile;
            const active = reactedAs === reaction;
            return (
              <button
                key={reaction}
                type="button"
                onClick={() => runReact(reaction)}
                disabled={reacting}
                aria-pressed={active}
                title={active ? t('postDetail.comments.react.remove') : undefined}
                className={`inline-flex items-center gap-1 rounded-xl px-2 py-1 text-[11px] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${DISABLED_PRIMARY} ${active ? 'bg-brand text-white' : `${INNER_SURFACE} text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100`}`}
              >
                <RIcon size={12} aria-hidden="true" /> {t(REACT_LABEL[reaction] || 'postDetail.comments.react.emoji')}
              </button>
            );
          })}
        </div>
      ) : null}
    </li>
  );
}

// onReplied (optional): called with the replied-to commentId after a successful reply. The
// per-post PostDetail usage omits it (no behaviour change); the own-post comment inbox passes
// it to mark that comment handled (comment_resolve) so it leaves the unanswered feed.
export default function CommentsPanel({ campaign, postId, enabled = true, onReplied }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useComments(campaign, postId, enabled);
  // Optimistically-rendered local replies (spec 02: the reply appears inline on
  // success). Keyed by parent comment id; each also triggers a real panel refetch.
  const [sent, setSent] = useState([]);
  const [replying, setReplying] = useState(false);

  const onReply = async (commentId, text, author) => {
    setReplying(true);
    try {
      await replyToComment(campaign, postId, commentId, text, data?.targetPlatform || undefined, author);
      setSent((prev) => [
        ...prev,
        { commentId: `local-${Date.now()}`, parentId: commentId, author: t('postDetail.comments.you'), text, ts: new Date().toISOString(), kind: 'comment', local: true },
      ]);
      // Same mutation path as every other write + a panel refetch (spec 02 §2).
      queryClient.invalidateQueries({ queryKey: ['plans'] });
      // R12 (BU-9): a reply accretes a me->them exchange server-side, so the engager
      // query (['engager', lane, handle], staleTime 15s) is now stale - without this the
      // "Nth exchange" chip keeps serving the pre-reply count for 15s and never lights
      // until a hard reload. Invalidate it here (the un-forget/link paths already do).
      queryClient.invalidateQueries({ queryKey: ['engager'] });
      // Own-post comment inbox (optional): the reply handled this comment, so let the inbox
      // mark it resolved and drop the row. Non-throwing - a resolve failure never breaks the
      // reply the operator already made.
      if (typeof onReplied === 'function') { try { onReplied(commentId); } catch { /* inbox-only */ } }
      refetch();
    } finally {
      setReplying(false);
    }
  };

  // Moderation mutation (spec 06): the SAME invalidateQueries(['plans']) + refetch
  // path. confirm rides through for the suppressing actions (server-gated). Throws on
  // failure so the row can surface the error affordance.
  const onModerate = async (commentId, action, confirm) => {
    await moderateComment(campaign, postId, commentId, action, data?.targetPlatform || undefined, confirm);
    queryClient.invalidateQueries({ queryKey: ['plans'] });
    refetch();
  };

  // Reaction mutation (spec 24): the SAME invalidateQueries(['plans']) + refetch path.
  // remove rides through to un-react; the emoji lanes get a default glyph (the CLI/MCP
  // accept any emoji); authorPubkey (the comment author) is threaded for the nostr NIP-25
  // p tag and ignored elsewhere. Throws on failure so the row can surface the error affordance.
  const onReact = async (commentId, reaction, remove, authorPubkey) => {
    const emoji = reaction === 'emoji' ? DEFAULT_REACT_EMOJI : undefined;
    await reactToPost(campaign, postId, commentId, reaction, data?.targetPlatform || undefined, emoji, remove, authorPubkey);
    queryClient.invalidateQueries({ queryKey: ['plans'] });
    refetch();
  };

  const laneMeta = data?.targetPlatform ? PLATFORM_META[data.targetPlatform] : (data?.platform ? PLATFORM_META[data.platform] : null);
  const moderateActions = Array.isArray(data?.moderateActions) ? data.moderateActions : [];
  const reactActions = Array.isArray(data?.reactActions) ? data.reactActions : [];
  const items = [...(data?.items || []), ...sent];

  return (
    <section className="space-y-1.5" aria-label={t('postDetail.section.comments')}>
      <h3 className={EYEBROW}>{t('postDetail.section.comments')}</h3>

      {isLoading ? (
        <ul className="space-y-1.5" aria-hidden="true">
          {[0, 1].map((i) => (
            <li key={i} className={`h-14 animate-pulse rounded-xl ${INNER_SURFACE}`} />
          ))}
        </ul>
      ) : isError || (data && (data.ok === false || data.error)) ? (
        <p role="alert" className={`flex flex-wrap items-center gap-1.5 rounded-xl px-3 py-2.5 text-xs text-red-600 dark:text-red-300 ${INNER_SURFACE}`}>
          <AlertCircle size={13} aria-hidden="true" />
          {t('postDetail.comments.error')}
          {(data?.message || data?.error) ? <span className="text-zinc-500 dark:text-zinc-400">{data.message || data.error}</span> : null}
          {data?.code ? <span className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{data.code}</span> : null}
        </p>
      ) : data?.needsScope ? (
        <div className={`space-y-1 rounded-xl px-3 py-2.5 text-xs ${INNER_SURFACE}`}>
          <p className="flex items-center gap-1.5 font-bold text-amber-600 dark:text-amber-300">
            <ShieldAlert size={13} aria-hidden="true" /> {t('postDetail.comments.needsScope')}
          </p>
          {data.scope ? <p className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{data.scope}</p> : null}
        </div>
      ) : items.length === 0 ? (
        <p className={`flex items-center gap-1.5 rounded-xl px-3 py-2.5 text-xs text-zinc-500 dark:text-zinc-400 ${INNER_SURFACE}`}>
          <MessageSquare size={13} aria-hidden="true" /> {t('postDetail.comments.empty')}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((c) => (
            <CommentRow key={c.commentId} comment={c} lane={c.platform || data?.targetPlatform || data?.platform} laneMeta={laneMeta} moderateActions={moderateActions} reactActions={reactActions} onReply={onReply} onModerate={onModerate} onReact={onReact} replying={replying} t={t} />
          ))}
        </ul>
      )}
    </section>
  );
}
