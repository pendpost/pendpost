import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, XCircle, Inbox, Archive, CalendarDays, LayoutGrid, List, Combine, Info, CornerUpLeft, ExternalLink, ArrowDown, ArrowUp, Send, Bot, Copy, Check, Link2, TriangleAlert, Ban } from 'lucide-react';
import { approvePost, rejectPost, markPosted, useAccounts, usePendpostHealth, useConfig, usePlatformValidate, agentFixPost, getAgentFixes } from '../lib/api.js';
import { fmtRowWhen, fmtFull, prettyCampaign, comparePostDate, matchesFilters, collectThread, redditPostReadiness, readinessAdvisoryText, unconnectedLanes, isActionable, nextActorOf, postDisplayState, effectiveLaneText, handOffTarget, isAbsoluteHttpUrl, postPublishedTitle, postCaptionRun, gridDisplayAspect, isImageMedia, hasVisual, rowTypeLabel } from '../lib/format.js';
import { postIssue } from '../lib/postIssue.js';
import IssueFixButton, { fixLabel, agentAvailable } from './IssueFixButton.jsx';
import { CoverThumb, LaneTile, LinkCardPreview, showsLinkedinCard, PlatformIcons, NextActorChip, StatusPill, PLATFORM_META, INNER_SURFACE, Skeleton, SelectAllControl } from './ui.jsx';
import { ClientAvatar } from './ClientSwitcher.jsx';
import { PROJECT_CHIP, SELECTED_TINT, TAP_TARGET } from './ui/recipes.js';
import { ShortcutList } from './ui/ShortcutList.jsx';
import { useStuck } from '../lib/useStuck.js';
import { GateMark } from './ui/GateMark.jsx';
import { IconBadge } from './ui/IconBadge.jsx';
import { HdBadge } from './ui/HdBadge.jsx';
import { RowMenu } from './ui/RowMenu.jsx';
import { usePostActions } from '../lib/usePostActions.js';
import { Tip } from './ui/Tooltip.jsx';
import BrandLintBadge from './ui/BrandLintBadge.jsx';
import { Checkbox } from './ui/Checkbox.jsx';
import ActionButton, { ONE_SOLID_APPROVE } from './ui/ActionButton.jsx';
import LinkCaptureRow from './ui/LinkCaptureRow.jsx';
import LiveLaneLinks from './ui/LiveLaneLinks.jsx';
import DestinationStrip from './ui/DestinationStrip.jsx';
import { usePrompt, useConfirm } from './ui/confirm.jsx';
import { ReviewStatusChip } from './ReviewLink.jsx';
import { useT } from '../lib/i18n.js';
import { useSetupByClient } from '../lib/setupByClient.js';
import { humanizeAction, laneLabel } from '../lib/failureCopy.js';
import ActionError from './ui/ActionError.jsx';
import { useSelection, selectionKey } from '../lib/useSelection.js';
import { hardBlockersOf, approveSplit, skipCauses, skipLine, agentCanTry } from '../lib/approvalBlockers.js';
import { runAgentFixQueued } from '../lib/bulkPlan.js';
import { fixFor } from '../lib/agentFix.js';
import { showToast } from './AppToast.jsx';
import ApprovalBlockerLine, { PlatformGlyph } from './ApprovalBlockerLine.jsx';
import ApprovalRunSummary from './ApprovalRunSummary.jsx';
import UnconnectedProjectsLine, { unconnectedGroups } from './UnconnectedProjectsLine.jsx';
import { problemCodeText } from '../lib/blockerText.js';
import { contentSignature, refusalKey, readRefusal, rememberRefusal } from '../lib/refusalMemo.js';
import { showApproveNotice } from '../lib/approveNotice.js';

// A failed action's lasting alert: ui/ActionError (the plain sentence, the raw line behind the
// "?", and the one recovery action inline). `guardAction` wraps a button's action so the alert
// is built from the thrown error itself (ActionButton's onError only hands over its message, or
// null when it had none), then rethrows so the button still flashes its own error state.
const actionAlert = (err, t) => humanizeAction(err, t, { fallbackKey: 'error.action' });
const guardAction = (fn, setError, t) => async () => {
  try {
    return await fn();
  } catch (err) {
    if (err?.canceled !== true) setError(actionAlert(err, t));
    throw err;
  }
};
const keyOf = (post) => `${post.campaign}-${post.id}`;

// A selected row wears the Planer's selection tint (ui/recipes.js SELECTED_TINT) over its card
// surface.
const rowSurface = (selected) => (selected ? `${INNER_SURFACE} ${SELECTED_TINT}` : INNER_SURFACE);

// Sort direction is a per-TAB preference, because the two tabs are different objects:
// "Zu pruefen" is a work queue (act on the soonest due), "Alle Beitraege" is an archive
// (find the most recent). A single shared key would destroy that split the first time
// the operator changed it on one tab.
const SORT_PREF_KEY = (mode) => `pendpost-approvals-sort:${mode}`;
const SORT_DEFAULT = { pending: 'oldest', all: 'newest' };
function readSortPref(mode) {
  try {
    const v = localStorage.getItem(SORT_PREF_KEY(mode));
    return v === 'newest' || v === 'oldest' ? v : SORT_DEFAULT[mode];
  } catch {
    return SORT_DEFAULT[mode];
  }
}
// isActionable (the "still needs a decision" predicate that scopes this queue) is the
// SHARED one in lib/format.js, imported above - App's sidebar pending badge uses the same
// function so the badge and this list can never disagree.
// Skip the approve "clearing sweep" motion for users who asked for less of it.
const prefersReduced = () =>
  typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// One approval card, authored as a <li> of sibling interactive controls (no
// interactive-in-interactive nesting): a single "open detail" <button> covers
// the meta + title + caption block (the media beside it opens the detail too, as a
// mouse target only); the selection checkbox and the Reject/
// Approve actions sit BESIDE that button, not inside it. Status (a state)
// reads as quiet ring-badges top-right; actions (things you do) read as a clear
// button group bottom-right - never interleaved.
//
// What may sit INSIDE the open-detail button is decided by ONE question: is it
// interactive? StatusPill/NextActorChip are plain <span>s, so they read top-right
// inside it. An IconBadge WITH a label is NOT: Tip wraps it in RT.Trigger asChild,
// so it renders a real <button>. Every one of those (archived / auto-approved /
// warmth advisory) therefore lives in the badge row at the bottom, beside
// BrandLintBadge - which is itself a non-interactive <span> for the same reason.
// Nesting one inside the open-detail button is invalid HTML, breaks keyboard
// traversal and screen-reader semantics, and makes the badge's click ambiguous
// (it would also fire open-detail). freigaben-approval-card.test.jsx pins this with
// a reddit-advisory fixture; an instagram/pending fixture renders no badges and
// would let the regression back in unnoticed.
function ApprovalCard({ post, posts = [], onOpen, onEdit = null, selected, onToggleSelect, onSelectThread, archived, compact = false, focused = false, registerRef, onArrowNav, onActed, setup = null, accounts = null, onNavigate = null, reviewRequired = false, lane = false, onBlockers = null }) {
  const queryClient = useQueryClient();
  const prompt = usePrompt();
  const t = useT();
  // The post's one fix (lib/postIssue.js), judged against its OWN project's setup (the
  // parent hands each card setupFor(post)): the same judge as the planner row, the post
  // detail card and the "Needs you" tray, so the four can never disagree. When there is a
  // fix, it IS the row's one action (IssueFixButton, the one place a fix runs).
  const issue = useMemo(() => postIssue(post, setup), [post, setup]);
  const hasFix = Boolean(issue?.fix?.type);
  // A lane that is not connected (issue kind 'blocked') is fixed ONCE per project, not per row
  // (Freigaben error UX, 2026-11-06): the DestinationStrip in one-project mode, the per-project
  // line in All-projects mode. The row keeps only a quiet struck-through glyph for it.
  const connectOnly = issue?.kind === 'blocked';
  const showFix = hasFix && !connectOnly;
  const fixRef = useRef(null);
  // Handed to the menu only so it drops an item that would repeat the fix (usePostActions).
  const fixDesc = hasFix ? { type: issue.fix.type, label: fixLabel(issue, t, { agent: agentAvailable(setup) }) } : null;
  // The overview action menu: the SAME actions the detail drawer offers. The row shows ONE
  // action (the fix, Approve, or the hand-off); everything else (Reject first, then the
  // hand-off when a fix leads, Editor / Park / Check / Delete) lives in the ⋯ (menuItems,
  // composed below once the card's own reject and hand-off exist).
  const { items: postActionItems } = usePostActions(post, { onEdit, fix: fixDesc, setup: setup || undefined });
  // A blocking refusal stays on this card until the post's CONTENT changes (lib/refusalMemo.js):
  // a queue refresh, an engine bookkeeping write or a remount never makes it vanish and turn
  // Approve green again. Editing the post clears it, so the next Approve is a fresh try.
  const memoKey = refusalKey(post);
  const signature = useMemo(() => contentSignature(post), [post]);
  const [error, setErrorState] = useState(() => readRefusal(memoKey, signature));
  const setError = useCallback((next) => {
    setErrorState(next);
    rememberRefusal(memoKey, signature, next);
  }, [memoKey, signature]);
  useEffect(() => { setErrorState(readRefusal(memoKey, signature)); }, [memoKey, signature]);
  // X thread membership: the whole chain this post belongs to. When it is part of
  // a thread, the card offers "select whole thread" so every tweet can be approved
  // together (each is still an independent, individually-audited approval).
  const thread = useMemo(() => (onSelectThread ? collectThread(post, posts) : [post]), [onSelectThread, post, posts]);
  const inThread = thread.length > 1;
  // Mirror ActionButton's in-flight guard for the KEYBOARD path: keys bypass the
  // button machine, so a second 'a'/'r' while one is still resolving would
  // double-submit. A ref (not state) is the guard ActionButton uses in spirit.
  const keyBusyRef = useRef(false);
  // The signature "gate release" motion: on a successful approve the card lifts
  // (the post clearing the gate). One-shot, ~750ms; skipped entirely under
  // reduced-motion. The amber->emerald pill morph from the motion kit is realised
  // here as the card clearing the queue (an approved post is non-actionable and
  // APPROVAL_META.approved is hidden), so the lift reads as the post moving on
  // without a contradicting pill.
  const [cleared, setCleared] = useState(false);
  const clearTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(clearTimerRef.current), []);
  const playClear = () => {
    if (prefersReduced()) return;
    setCleared(true);
    clearTimeout(clearTimerRef.current);
    clearTimerRef.current = setTimeout(() => setCleared(false), 750);
  };

  const actionable = isActionable(post);

  // Spec 37 (reversed 2026-07-13): every approved reddit post auto-publishes. The account-warmth
  // screening is a display-only ADVISORY (promotional / cold account / subreddit requirements),
  // shown as a passive amber badge so the operator sees the concerns before approving. Approval
  // always leads to auto-publish; a distinct human still approves every reddit post (the fence).
  const readiness = useMemo(() => redditPostReadiness(post, setup, true), [post, setup]);
  const hasAdvisory = readiness.advisories.length > 0;
  const advisoryText = hasAdvisory ? readinessAdvisoryText(t, readiness.advisories) : '';

  // The approve write. Approval is always a single, dialog-free action (button,
  // keyboard and bulk paths all approve immediately - no note). Routes through the
  // EXISTING approvePost helper (no new approve path); on success it invalidates
  // the plans query exactly like the reject path.
  const doApprove = async () => {
    setError(null);
    // Issue 6: a card in all-clients mode carries clientId (stamped by App.jsx's
    // merge) - thread it so the write lands on ITS client, not whatever the
    // active client happens to be. Single-client mode never sets it, so the call
    // stays exactly the 2-arg shape it always was.
    showApproveNotice(await (post.clientId ? approvePost(post.campaign, post.id, undefined, post.clientId) : approvePost(post.campaign, post.id)), t, { posts: [post] });
    queryClient.invalidateQueries({ queryKey: ['plans'] });
  };
  // The reject write always opens the multiline note prompt; cancel (null) is a
  // user-cancel sentinel (no write, no error flash).
  const doReject = async () => {
    setError(null);
    const note = await prompt({
      title: t('approvals.rejectPrompt.title'),
      body: t('approvals.rejectPrompt.body'),
      multiline: true,
      rememberKey: 'approvals.reject',
    });
    if (note === null) throw { canceled: true };
    await (post.clientId ? rejectPost(post.campaign, post.id, note || undefined, post.clientId) : rejectPost(post.campaign, post.id, note || undefined));
    queryClient.invalidateQueries({ queryKey: ['plans'] });
  };

  // Per-card key handler on the focusable <li>. ArrowUp/Down move focus between
  // cards (roving focus is owned by the parent via onArrowNav). a=approve,
  // r=reject act on THIS focused, actionable card. Everything is gated behind the
  // child-guard: keystrokes that bubble up from a child control (open-detail,
  // Reject/Approve buttons, the checkbox) belong to that control, not the card -
  // ignore them so 'a'/'r' on the Reject button never silently approves/rejects
  // the whole card. a/r are additionally ignored when: the card is non-actionable;
  // focus is inside a text field; or a key action is already in flight. 'a'
  // approves IMMEDIATELY (approval never opens a dialog; only reject prompts for a
  // note). On success the parent is notified (onActed) so focus
  // auto-advances to the next item, letting a reviewer clear the queue by keyboard.
  const onCardKeyDown = (e) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      onArrowNav?.(e.key === 'ArrowDown' ? 1 : -1, post);
      return;
    }
    if (!actionable) return;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const key = e.key.toLowerCase();
    if (key !== 'a' && key !== 'r') return;
    // Content blocker: the approve button is disabled, so keyboard approve is too
    // (canon: prevent at the control). Reject stays available as the way out. The keyboard
    // mirrors the row: a row whose one action is a fix or the hand-off shows no Approve, so
    // 'a' does nothing there either.
    if (key === 'a' && (hasHardBlockers || hasFix || handOffLeads)) return;
    const el = e.target;
    const tag = (el?.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.isContentEditable) return;
    if (keyBusyRef.current) return;
    e.preventDefault();
    keyBusyRef.current = true;
    const isApprove = key === 'a';
    const action = isApprove ? doApprove() : doReject();
    Promise.resolve(action)
      .then(() => {
        if (isApprove) playClear();
        onActed?.(post);
      })
      .catch((err) => {
        if (err?.canceled !== true) setError(actionAlert(err, t));
      })
      .finally(() => {
        keyBusyRef.current = false;
      });
  };
  // The row's words (the media-first row, 2026-11-05): a bold title ONLY when one of the
  // post's lanes publishes a title (postPublishedTitle), then the caption as ONE paragraph that
  // never loses its first line when there is no title. A Reel caption is one continuous text,
  // so its first sentence is never promoted to a bold "title". Where the post needs a NAME
  // (aria-labels, dialogs) the shared postDisplayTitle stays in charge.
  const title = postPublishedTitle(post);
  const captionRun = postCaptionRun(post);
  // A real picture to show (a render, a cover, an album slide, a hero image). A post without
  // one keeps the media column with a quiet lane tile, so every caption starts on the same x.
  const visual = hasVisual(post);
  // The campaign is context, not a decision input: it rides a real tooltip on the date (and
  // stays in the post detail), so the row's meta line carries only what a reviewer triages on.
  const campaignTip = t('approvals.card.campaign', { campaign: prettyCampaign(post.campaign) });
  // The lanes pendpost cannot publish to, judged by the post's own project's setup.
  const offlineLanes = unconnectedLanes(post, setup);

  // Content-readiness gate (canon: prevent at the control, not after the click). The engine
  // already refuses an over-limit post at approve (setApproval -> not_ready) - e.g. a Mastodon
  // caption over 500 chars - but the green button used to look approvable and only failed AFTER
  // the press, dead-ending on a red error. We read the SAME per-platform verdict PostDetail shows
  // and gate the button up-front. Enabled only for actionable cards (cached, 30s staleTime), and
  // scoped by the post's own clientId so an all-projects card validates ITS project, not the
  // active one. Only real `problems` block (warnings stay advisory, matching the engine's
  // ready = !problems.length); `needsSetup` lanes never carry content problems and are already
  // owned by the offline-lane swap above, so they never reach here. Loading/ok:false fails OPEN -
  // a validate hiccup never blocks a genuinely ready post; the server gate is the real fence.
  const { data: platformValidate } = usePlatformValidate(post.campaign, post.id, actionable, post.rev, post.clientId);
  const blockerReasons = useMemo(() => {
    const plats = platformValidate?.ok ? (platformValidate.platforms || {}) : {};
    return Object.entries(plats)
      .filter(([, v]) => (v?.problems?.length || 0) > 0 && v?.needsSetup !== true)
      .map(([platform, v]) => ({ platform, problem: problemCodeText(t, v.problemCodes?.[0]) }));
  }, [platformValidate, t]);
  const hasHardBlockers = blockerReasons.length > 0;
  // Every hard blocker (lib/approvalBlockers.js), the same list the toolbar's bulk approve and
  // run summary read: reported up so the bulk approve leaves this post out before the press.
  // Only a settled verdict is reported (a refetch after an edit keeps the last one), and the
  // entry leaves with the card.
  const hardBlockers = useMemo(() => hardBlockersOf(platformValidate), [platformValidate]);
  const reportKey = selectionKey(post);
  const verdictReady = platformValidate?.ok === true;
  useEffect(() => {
    if (verdictReady && onBlockers) onBlockers(reportKey, hardBlockers);
  }, [verdictReady, hardBlockers, onBlockers, reportKey]);
  useEffect(() => () => { onBlockers?.(reportKey, undefined); }, [onBlockers, reportKey]);
  // The first blocker as a one-line reason for the disabled button's tooltip/aria-label, in
  // the SAME localized words as the blocker rows below (lib/blockerText.js). The engine's
  // English line is never the reason; an uncoded problem gets a plain platform sentence.
  const blockedLane = hasHardBlockers ? (PLATFORM_META[blockerReasons[0].platform]?.label || blockerReasons[0].platform) : '';
  const blockedReason = hasHardBlockers
    ? t('approvals.card.blockedReason', { reason: blockerReasons[0].problem || t('approvals.card.blockedUncoded', { platform: blockedLane }) })
    : '';
  // The blocker line (Freigaben error UX, 2026-11-06): ONE compact line, the platform glyph and
  // the cause in a few words, the full sentence behind the "?", and the fixes as glyphs (the
  // agent, a copyable brief, and for a platform the project turned off: turn it on or drop it).
  // It replaces the boxed PlatformBlockers panel on this surface; the post detail keeps that.
  const blockerLine = hasHardBlockers ? (
    <ApprovalBlockerLine post={post} blockers={hardBlockers} offlineLanes={offlineLanes} setup={setup} />
  ) : null;

  // The copy-lane hand-off, right on the card (B2). "Selbst posten" only opened the
  // detail - one more hop before the operator could act. The card now does the whole
  // move itself: copy the lane's EFFECTIVE text, open the destination, then reveal
  // the link-capture row so "manually post" is ONE flow ending with evidence.
  // Copy FIRST, and a clipboard refusal shows the error instead of opening a tab
  // and claiming a success it did not have (the PostDetail rule).
  const [handedOff, setHandedOff] = useState(false);
  const [copied, setCopied] = useState(false);
  const [handOffUrl, setHandOffUrl] = useState('');
  const [handOffSaving, setHandOffSaving] = useState(false);
  const [handOffError, setHandOffError] = useState(null);
  const copiedTimerRef = useRef(null);
  useEffect(() => () => clearTimeout(copiedTimerRef.current), []);
  const onCardHandOff = async () => {
    setError(null);
    // The lane's effective text (same override precedence the engines publish);
    // several offline lanes falling back to the shared caption (PostDetail's rule).
    const texts = [...new Set(offlineLanes.map((p) => effectiveLaneText(post, p)))];
    const text = texts.length === 1 ? texts[0] : (post.caption || '').trim();
    try {
      if (text) await navigator.clipboard.writeText(text);
    } catch (err) {
      setError(actionAlert(err, t));
      return;
    }
    setCopied(true);
    clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 2500);
    // Where the text goes: the thread being answered, the recorded external target,
    // or the SINGLE openable hand-off destination - two candidates would mean
    // silently picking a network, so the button then opens none (PostDetail's rule,
    // same handOffTarget helper).
    const openable = offlineLanes.map((p) => handOffTarget(post, p, accounts)).filter((tgt) => tgt?.url);
    const target = post.radarReplyTo?.url || post.externalUrl || (openable.length === 1 ? openable[0].url : null);
    if (target) window.open(target, '_blank', 'noopener,noreferrer');
    setHandedOff(true);
  };
  const saveHandOffLink = async () => {
    // Client-side gate (F3): the same absolute-http(s) rule the server enforces,
    // refused with the localized message BEFORE the send - the raw English engine
    // string never leads on this surface. The typed value survives, resubmittable.
    if (!isAbsoluteHttpUrl(handOffUrl)) { setHandOffError({ text: t('radar.copyPosted.linkInvalid'), raw: null }); return; }
    setHandOffSaving(true);
    setHandOffError(null);
    try {
      // The same one-legal-re-entry write the answered-without-proof repair uses.
      await (post.clientId ? markPosted(post.campaign, post.id, handOffUrl.trim(), undefined, post.clientId) : markPosted(post.campaign, post.id, handOffUrl.trim()));
      queryClient.invalidateQueries({ queryKey: ['plans'] });
      // Close the row on success: on "Alle Beitraege" the card stays mounted
      // (unlike the pending tab, where it leaves the list), so a row left open
      // with a spinning save would sit there forever.
      setHandedOff(false);
      setHandOffUrl('');
      setHandOffSaving(false);
    } catch (e) {
      // One plain sentence; the server's own line rides the "?" beside it (humanizeAction).
      setHandOffError(humanizeAction(e, t, { fallbackKey: 'radar.copyPosted.failed' }));
      setHandOffSaving(false);
    }
  };
  // The link-capture row revealed after a successful copy: paste where it went,
  // mark it posted - the card carries the evidence contract to its end.
  const handOffCapture = handedOff ? (
    <div className={compact ? 'flex justify-end' : 'flex justify-end pt-1'}>
      <LinkCaptureRow
        value={handOffUrl}
        onChange={setHandOffUrl}
        onSave={saveHandOffLink}
        saving={handOffSaving}
        error={handOffError}
        placeholder={t('radar.copyPosted.linkPlaceholder')}
        inputLabel={t('radar.copyPosted.linkLabel')}
        label={t('radar.copyPosted.mark')}
        requireValue
      />
    </div>
  ) : null;

  // The Freigeben (approve) button. Same label, variant, icon and position always: approval is a
  // single distinct-human action that always leads to auto-publish. The warmth advisory badge
  // below is informational only - it never changes the approve path.
  const approveButton = (
    <ActionButton
      // Tonal; the list makes one row's approve solid (ONE_SOLID_APPROVE). A lane line of a
      // cross-post group stays tonal: its group's "Approve all" is that row's strong action.
      variant="success"
      data-row-approve={lane ? undefined : ''}
      className="justify-center"
      icon={reviewRequired ? Send : CheckCircle2}
      // Content-readiness gate: a post the engine would refuse (e.g. a Mastodon caption over
      // 500 chars) shows the button DISABLED with the reason a hover away, instead of letting
      // the press fail into a red error. The reason itself is rendered proactively below
      // (blockerLine), and reject stays reachable in the ⋯ as the way out.
      // A refusal that names a blocker keeps Approve disabled (pressing again cannot work);
      // the alert below carries the error and its one recovery. The button never turns into
      // a red "Error" (quietError): a button that names an error is not an action.
      disabled={hasHardBlockers || Boolean(error?.blocking)}
      quietError
      ariaLabel={hasHardBlockers ? blockedReason : undefined}
      title={hasHardBlockers ? blockedReason : undefined}
      labels={reviewRequired
        // O2: with review.required on, the operator's approve RELABELS to send for
        // sign-off, so a first-time operator sees the verb tell them the post goes to
        // the client, not live. The write is unchanged (still approvePost) - the
        // awaiting chip below is its confirmation.
        ? { idle: t('review.action.sendForSignoff'), loading: t('review.action.sending'), success: t('review.action.sent'), error: t('approvals.action.error') }
        : { idle: t('approvals.action.approve'), loading: t('approvals.action.approving'), success: t('approvals.action.approved'), error: t('approvals.action.error') }}
      onAction={guardAction(async () => {
        await doApprove();
        playClear();
        onActed?.(post);
      }, setError, t)}
    />
  );
  // The hand-off: copy the lane's text and open the destination. It is the row's one action
  // only for a post whose sole unconnected lane is a manual paste lane (Reddit): posting it by
  // hand IS the path there, and approving would publish nothing. On a Blocked post (a lane
  // meant to publish is not connected) the fix leads and this moves into the ⋯.
  const handOffLabel = post.radarReplyTo
    ? (copied ? t('radar.reply.copied') : t('radar.reply.copyOpen'))
    : (copied ? t('postDetail.handOff.copySuccess') : t('postDetail.handOff.copyIdle'));
  const handOffButton = (
    <Tip label={t('approvals.card.copyOpenTip', { platform: offlineLanes.map((p) => PLATFORM_META[p]?.label || p).join(', ') })}>
      <button
        type="button"
        onClick={onCardHandOff}
        aria-live="polite"
        className={`inline-flex shrink-0 items-center justify-center gap-1.5 rounded-xl bg-sky-500/15 px-2.5 py-1.5 text-center text-xs font-bold text-sky-700 transition hover:bg-sky-500/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-sky-300`}
      >
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        {handOffLabel}
      </button>
    </Tip>
  );
  // Posted = linked (chip 3): a posted-family card in the "Alle Beitraege" view
  // renders the same icon-only open-live-post links Published's rows use, in the
  // slot the (now moot) actions occupied - the SHARED LiveLaneLinks strip (capped
  // at 5 inline, "+n" overflow, S6). resolveLivePermalink returning null for
  // every lane renders NOTHING - never a dead control, never a fabricated link.
  const postedFamily = !actionable && ['posted', 'verified-live', 'fired-assumed', 'verify-failed'].includes(post.derivedState);
  // Wrong-pasted-link repair (S4 posted state, fresh-eyes finding 9): a hand-marked
  // post's captured URL stays correctable - markPosted allows a legal re-entry, so
  // this quiet affordance re-opens the SAME capture row prefilled with the saved
  // link and overwrites it. Mirrors Radar's AttachAnswerLink; only on a manual mark
  // (an engine-minted link is evidence, not a claim, and has nothing to repair).
  const canFixLink = postedFamily && post.publishedVia === 'manual';
  const liveLinks = postedFamily ? (
    <span className="flex shrink-0 items-center gap-1.5">
      <LiveLaneLinks post={post} />
      {canFixLink && !handedOff ? (
        <Tip label={t('approvals.card.fixLink.tip')}>
          <button
            type="button"
            onClick={() => { setHandOffUrl(post.externalUrl || ''); setHandedOff(true); }}
            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-zinc-500 transition hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-200"
          >
            <Link2 size={13} aria-hidden="true" />{t('approvals.card.fixLink')}
          </button>
        </Tip>
      ) : null}
    </span>
  ) : null;

  // ONE truthful next-actor state per card (nextActorOf), judged by the post's own project.
  const nextActor = nextActorOf(post, setup);
  // The hand-off leads only on a manual-paste-only post (no fix: postIssue never flags it).
  const handOffLeads = !hasFix && nextActor.key === 'handOff';

  // The row's ONE action. The planner List row's grammar (polish 2026-11-01), so both pages
  // read alike:
  //   - a post with a fix (Connect X, Sign in again, ...) carries it on its status line under
  //     the title: rose glyph + the reason + the fix at the trailing edge, and no status pill
  //     anywhere (statusLine below); the action slot then holds only the ⋯;
  //   - the hand-off on a manual-paste-only post (awaiting a decision or already approved);
  //   - Approve (or Send for sign-off) on a post awaiting a decision;
  //   - on a published post in the "All posts" tab, its live links.
  // An all-projects row names its project to the navigation (App re-scopes first), so Setup
  // opens for THIS post's project.
  const fixNavigate = post.clientId && typeof onNavigate === 'function'
    ? (p, platform, opts) => onNavigate(p, platform, opts, post.clientId)
    : onNavigate;
  // The hand-off leads an approved manual-lane post too ("All posts"): it still has to be
  // posted by hand, so the row keeps saying how.
  const primary = hasFix ? null : handOffLeads ? handOffButton : actionable ? approveButton : liveLinks;

  // The ⋯: everything that is not the row's one action. Reject leads it (one click away, and
  // still on the keyboard as r); the hand-off sits here when a fix leads the row; Approve sits
  // here only when the fix leads a post that can still be approved and publish (a content fix
  // the owner may skip). The fix itself is the visible button, never repeated in the menu.
  const doRejectFromMenu = () => {
    Promise.resolve(doReject())
      .then(() => onActed?.(post))
      .catch((err) => { if (err?.canceled !== true) setError(actionAlert(err, t)); });
  };
  const menuItems = [
    ...(hasFix && actionable && !offlineLanes.length ? postActionItems.filter((i) => i.key === 'approve') : []),
    actionable && { key: 'reject', label: t('approvals.action.reject'), Icon: XCircle, run: doRejectFromMenu },
    actionable && hasFix && offlineLanes.length > 0 && { key: 'hand-off', label: handOffLabel, Icon: Copy, run: onCardHandOff },
    ...postActionItems.filter((i) => i.key !== 'approve' && i.key !== 'reject' && i.key !== 'fix'),
  ].filter(Boolean);
  const menu = menuItems.length ? <RowMenu items={menuItems} label={t('postDetail.more')} /> : null;

  // Selection checkbox - only on actionable cards. A sibling control, never nested in the
  // open-detail button. It sits at the row's top edge in both layouts; a list row without one
  // (a settled post in "All posts") keeps the same slot empty, so every media column starts at
  // the same x.
  const checkbox = actionable ? (
    <span className="flex h-5 w-4 shrink-0 items-center">
      <Checkbox
        checked={selected}
        onChange={() => onToggleSelect(post)}
        aria-label={t('approvals.card.selectPost')}
      />
    </span>
  ) : compact ? <span className="w-4 shrink-0" aria-hidden="true" /> : null;

  // Contextual icon-badges (archived / warmth advisory) - rare signals worth keeping in BOTH
  // layouts. Each is a real <button> (a labelled IconBadge renders one), so each sits beside
  // the row's action, never inside the open-detail button.
  const contextBadges = (archived || hasAdvisory) ? (
    <>
      {archived ? <IconBadge icon={Archive} tone="neutral" text={t('approvals.card.archived')} label={t('approvals.card.archivedLabel')} /> : null}
      {/* Spec 37 (reversed): a display-only account-warmth advisory on a reddit post. Approving
          still auto-publishes; the tooltip carries the concerns (promotional / cold account /
          subreddit requirements). */}
      {hasAdvisory ? <IconBadge icon={Info} tone="warn" text={t('readiness.advisoryBadge')} label={advisoryText} /> : null}
    </>
  ) : null;

  // Why the post needs its fix, as one plain line under the title (the planner row's words):
  // the tray's cause for a failure. Only when the row's action is a fix, so a calm post carries
  // no status line at all. A lane that is not connected says it with the quiet glyph below.
  const reason = !showFix ? '' : t(`tray.cause.${issue.fix.type}`, { lane: laneLabel(issue.lane) });
  // The status line: the planner row's (Planner.jsx ListRow), so a Blocked post reads the
  // same on both pages. The full sentence also rides a real tooltip, since it may truncate.
  // It only SAYS why; the fix itself sits in the row's one action slot (below).
  const reasonLine = reason ? (
    <div data-row-status="" data-tone="halted" className="flex min-w-0 flex-1 items-center gap-2">
      <TriangleAlert size={13} className="shrink-0 text-rose-700 dark:text-rose-300" aria-hidden="true" />
      <Tip label={reason}>
        <p className="min-w-0 flex-1 break-words text-xs font-medium text-rose-700 line-clamp-2 md:line-clamp-1 dark:text-rose-300">{reason}</p>
      </Tip>
    </div>
  ) : null;
  // The status slot holds the fix's reason, else the blocker line; with both, the blocker line
  // reads under the row.
  const statusLine = reasonLine || blockerLine;
  const blockerBelow = reasonLine ? blockerLine : null;
  // A lane that is not connected: a quiet grey struck-through glyph per lane, its name on hover.
  // The connect fix lives once per project (DestinationStrip / UnconnectedProjectsLine).
  const offlineChip = connectOnly ? (
    <span data-offline-chip="" className="flex shrink-0 items-center gap-1">
      {issue.lanes.map((l) => {
        const tip = t('listBulk.reason.offline', { lanes: PLATFORM_META[l]?.label || l });
        return (
          <Tip key={l} label={tip}>
            <span tabIndex={0} aria-label={tip} className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-zinc-900/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-white/10">
              <PlatformGlyph platform={l} off />
            </span>
          </Tip>
        );
      })}
    </span>
  ) : null;
  // The row's ONE action slot, the same place on every row in both layouts: the fix (Sign in
  // again, ...) or Approve / the hand-off / live links, always followed by its ⋯. A fix row's
  // action used to sit on the status line while Approve sat on the title line, so the action
  // column was ragged.
  const action = showFix ? (
    <div ref={fixRef} className="-my-1 shrink-0">
      <IssueFixButton issue={issue} post={post} onNavigate={fixNavigate} onEdit={onEdit} size="sm" />
    </div>
  ) : connectOnly ? offlineChip : primary;
  const topCluster = contextBadges || action || menu ? (
    <>
      {contextBadges}
      {action}
      {menu}
    </>
  ) : null;

  // Issue 6: the project chip, shown exactly when All-projects mode stamped one (one-project
  // mode never sets post.clientName). Avatar carries the accent, the name the meaning.
  const clientChip = post.clientName ? (
    <span className={`${PROJECT_CHIP} max-w-[8rem]`}>
      <ClientAvatar client={{ displayName: post.clientName, accent: post.accent, logo: null }} size={14} />
      <span className="truncate">{post.clientName}</span>
    </span>
  ) : null;
  // The one status chip, only where it says something the row's action does not: a red
  // alarm (overdue / failed), re-approve, rejected, scheduled, posted. "Awaiting approval" is
  // what the Approve button already says, and Blocked / Post it yourself are what the fix and
  // the hand-off say, so those rows wear no chip. Plain <span>s, so they may sit inside the
  // open-detail button.
  const quietKeys = new Set(['approve', 'blocked', 'handOff']);
  const statusChip = hasFix || quietKeys.has(nextActor.key) ? null
    : nextActor.key === 'overdue' || nextActor.key === 'publish-failed'
      ? <StatusPill state={nextActor.key === 'publish-failed' ? postDisplayState(post) : nextActor.key} short />
      : <NextActorChip post={post} setup={setup} />;

  // The meta line, the same in both layouts: platform glyph · date and time · type, then the
  // project chip (All-projects mode only) and the one status chip. The date reads like speech
  // (fmtRowWhen: "Heute · 17:00", "Mo 9. Nov · 17:00"); the full stamp and the campaign ride
  // its tooltip. Every part is a plain <span>, so the line lives inside the open-detail button.
  const when = post.scheduledAt ? fmtRowWhen(post.scheduledAt) : t('approvals.card.noSchedule');
  const whenTip = post.scheduledAt ? `${fmtFull(post.scheduledAt)} · ${campaignTip}` : campaignTip;
  const metaLine = (
    <span data-row-meta="" className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-zinc-600 dark:text-zinc-300">
      <PlatformIcons platforms={post.platforms} />
      <Tip label={whenTip}>
        <span className="whitespace-nowrap font-semibold tabular-nums">{when}</span>
      </Tip>
      <span aria-hidden="true">·</span>
      <span>{rowTypeLabel(t, post.type)}</span>
      <HdBadge hdReady={post.media?.hdReady} bitrate={post.media?.bitrate} static warnOnly />
      {clientChip}
      <ReviewStatusChip post={post} />
      {statusChip}
    </span>
  );

  // The media column (mockup A): the post's real picture at its real aspect, 72px wide (56px on
  // a phone), or a quiet lane tile of the same width for a post with nothing to look at (a Radar
  // reply shows the lane it answers on). A mouse click on it opens the detail like the rest of
  // the row; it is not a second control (aria-hidden, no tab stop), the open-detail button
  // beside it is the one.
  const tilePlatform = post.radarReplyTo?.source || post.platforms?.[0];
  const mediaColumn = (
    <span data-row-media="" aria-hidden="true" onClick={() => onOpen(post)} className="block w-14 shrink-0 cursor-pointer sm:w-[72px]">
      {visual ? (
        <CoverThumb media={post.media} image={post.image} className={`block w-full ${gridDisplayAspect(post)} rounded-lg`} />
      ) : (
        <LaneTile platform={tilePlatform} className="w-full" />
      )}
    </span>
  );
  // The words: the meta line on top, then the title (only per the title rule), then the caption
  // in full text strength, three lines (two under a title, where the title carries the post and
  // the caption may go quiet). The words fill the row up to the action cluster.
  const titleLine = title ? (
    <span data-row-title="" className="min-w-0 break-words text-[15px] font-bold leading-5 line-clamp-2 sm:line-clamp-1">{title}</span>
  ) : null;
  const captionText = captionRun || (title ? '' : t('approvals.card.untitled'));
  const captionClass = `text-sm leading-relaxed ${
    !captionRun ? 'text-zinc-600 dark:text-zinc-400' : title ? 'line-clamp-2 text-zinc-600 dark:text-zinc-400' : 'line-clamp-3'
  }`;
  // A Radar reply's answer reads under the thread it answers, so it leaves the open-detail
  // button (the thread block between them holds a link, and the button holds no controls).
  const openButton = (
    <button
      type="button"
      onClick={() => onOpen(post)}
      className="flex w-full min-w-0 cursor-pointer flex-col gap-1.5 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
    >
      {metaLine}
      {titleLine}
      {captionText && !post.radarReplyTo ? <span data-row-caption="" className={captionClass}>{captionText}</span> : null}
    </button>
  );
  // The thread this reply ANSWERS, above the answer. Without it the queue asks the operator to
  // approve an answer with the question nowhere on the surface they work from. A sibling of the
  // open-detail button, never nested: the link is interactive.
  const radarThread = post.radarReplyTo ? (
    <div className={`rounded-lg px-2 py-1.5 ${INNER_SURFACE}`}>
      <div className="flex items-center gap-1.5 text-[11px]">
        {PLATFORM_META[post.radarReplyTo.source] ? (
          (() => { const M = PLATFORM_META[post.radarReplyTo.source]; return <M.Icon size={11} className={M.color} aria-hidden="true" />; })()
        ) : null}
        <span className="truncate font-bold text-zinc-600 dark:text-zinc-300">
          {post.radarReplyTo.author || post.radarReplyTo.url.replace(/^https?:\/\/(www\.)?/, '')}
        </span>
        {post.radarReplyTo.community ? (
          <span className="shrink-0 text-zinc-600 dark:text-zinc-400">{post.radarReplyTo.community}</span>
        ) : null}
        <a
          href={post.radarReplyTo.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="ml-auto inline-flex shrink-0 items-center gap-1 font-semibold text-brand hover:underline dark:text-brand-light"
        >
          {t('approvals.card.openThread')}
          <ExternalLink size={10} aria-hidden="true" />
        </a>
      </div>
      {post.radarReplyTo.excerpt ? (
        <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-400">{post.radarReplyTo.excerpt}</p>
      ) : null}
      {/* The agent's WHY (+ score in the tooltip), snapshotted at queue time: the approver
          decides on THIS surface, so the reasoning that was Radar-only rides along. A real Tip,
          never the title attribute (canon). */}
      {post.radarReplyTo.reason ? (
        <Tip label={Number.isFinite(post.radarReplyTo.intentScore) ? t('approvals.radar.reason.tip', { score: post.radarReplyTo.intentScore }) : t('approvals.radar.reason.tip.scoreless')}>
          <p className="mt-1 flex cursor-help items-start gap-1 text-[11px] leading-relaxed text-zinc-600 dark:text-zinc-400">
            <Bot size={11} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span className="line-clamp-2">{post.radarReplyTo.reason}</span>
          </p>
        </Tip>
      ) : null}
    </div>
  ) : null;
  const textColumn = (
    <div className="flex min-w-0 flex-col gap-1.5">
      {openButton}
      {radarThread}
      {post.radarReplyTo && captionRun ? <p data-row-caption="" className={captionClass}>{captionRun}</p> : null}
    </div>
  );

  // One lane line of a cross-post group (mockup B): the group row above it shows the shared
  // media and caption, so the line says only what is this lane's own: its glyph and type, its
  // title where the lane publishes one, its status chip or reason, and its own action with its
  // ⋯ (tonal: the group's "Approve all" is the row's one strong action). Every judge above (the
  // fix, the content gate, the hand-off, the refusal memo) runs exactly as on a single row.
  if (lane) {
    return (
      <li data-group-lane="" className="flex min-w-0 flex-col gap-1.5 border-t border-zinc-900/5 py-2 first:border-t-0 dark:border-white/10">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          <button
            type="button"
            onClick={() => onOpen(post)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-lg text-left text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            <PlatformIcons platforms={post.platforms} />
            <span className="shrink-0 text-zinc-600 dark:text-zinc-400">{rowTypeLabel(t, post.type)}</span>
            {title ? <span data-row-title="" className="min-w-0 truncate font-bold">{title}</span> : null}
            <ReviewStatusChip post={post} />
            {statusChip}
          </button>
          {contextBadges}
          {action || menu ? (
            <span data-row-action="" className="ml-auto flex shrink-0 items-center gap-1.5">
              {action}
              {menu}
            </span>
          ) : null}
          {statusLine ? <div className="flex basis-full">{statusLine}</div> : null}
        </div>
        {handOffCapture}
        {blockerBelow}
        <ActionError error={error} onEdit={onEdit ? () => onEdit(post) : null} onNavigate={onNavigate} />
      </li>
    );
  }

  return (
    <li
      ref={registerRef}
      // Roving tabindex: the parent-chosen focused card owns the tab stop (0);
      // every other card is -1 (still .focus()-able for arrow nav / auto-advance,
      // but out of the natural Tab order). a/r stay gated by `actionable`.
      tabIndex={focused ? 0 : -1}
      data-focused={focused ? '' : undefined}
      data-selected={selected ? '' : undefined}
      onKeyDown={onCardKeyDown}
      aria-keyshortcuts={actionable ? 'a r' : undefined}
      style={{ transform: cleared ? 'translateY(-6px) scale(.99)' : 'none', transition: 'transform .6s cubic-bezier(.32,.72,0,1)' }}
      className={`group flex items-start gap-3 transition focus-within:ring-2 focus-within:ring-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand hover:ring-brand/40 sm:gap-4 ${rowSurface(selected)} ${compact ? 'rounded-lg px-3 py-2.5' : 'rounded-xl p-3'}`}
    >
      {checkbox}
      {/* Media first (mockup A): the eye scans the left edge, and the picture is how a post
          is recognised. Checkbox | media | words | action, in both layouts. */}
      {mediaColumn}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {compact ? (
          // The list row: the words fill the row, the one action and its ⋯ sit at the trailing
          // edge. On a phone the action pair drops under the text, right-aligned.
          <div className="flex min-w-0 flex-wrap items-start gap-x-4 gap-y-2">
            <div className="min-w-0 flex-1 basis-full sm:basis-0">{textColumn}</div>
            {/* The status line reads under the text; from sm up the action slot moves up beside
                the words (order), on a phone it closes the row under the reason it fixes. */}
            {statusLine ? <div className="flex basis-full sm:order-3">{statusLine}</div> : null}
            {topCluster ? (
              <span data-row-action="" className="ml-auto flex shrink-0 items-center gap-1.5 sm:order-2">
                {topCluster}
              </span>
            ) : null}
          </div>
        ) : (
          <>
            {textColumn}
            {/* The LinkedIn card exists only where LinkedIn builds one: a LinkedIn text post WITH
                a link (the engine's article branch). Everything else (a Reddit or X text post, a
                plain LinkedIn post, a Radar reply) publishes without a card. */}
            {showsLinkedinCard(post) && !post.radarReplyTo ? <LinkCardPreview image={post.image} title={post.title} link={post.link} /> : null}
            <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
              {/* The interactive badges (archived / warmth advisory): each is an IconBadge WITH a
                  label, so each is a real <button> and belongs HERE, a SIBLING of the open-detail
                  button - never inside it. */}
              {contextBadges}
              {/* Advisory brand-lint badge: a SIBLING of the open-detail button (never
                  nested in it), mirroring the per-platform publish gate. Silent unless
                  a target platform would trip a severity:'error' rule; never gates. */}
              <BrandLintBadge caption={post.caption} platforms={post.platforms} />
              {/* Thread marker + "select whole thread": approving one tweet is not
                  approving the thread, so this both signals membership and seeds the
                  bulk selection with every tweet in the chain. */}
              {inThread ? (
                <Tip label={t('approvals.thread.selectThread')}>
                  <button
                    type="button"
                    onClick={() => onSelectThread(post)}
                    className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-bold text-zinc-600 ring-1 ring-zinc-900/10 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:ring-white/10 dark:hover:bg-zinc-700/60"
                  >
                    <CornerUpLeft size={11} aria-hidden="true" /> {t('approvals.thread.partOf', { count: thread.length })}
                  </button>
                </Tip>
              ) : null}
              {/* The card's one action and its ⋯ close the card, in the same corner on every card
                  (the fix or Approve / the hand-off), after the status line when there is one.
                  ml-auto: the pair stays at the card's trailing edge. On a
                  phone the reason takes the card's full width, from sm up it shares the line with
                  the fix. */}
              {/* No min-w-0: the slot may not shrink below its cause; the row wraps the action. */}
              {statusLine ? <div className="flex basis-full sm:basis-0 sm:flex-1">{statusLine}</div> : <span className="flex-1" />}
              {action || menu ? (
                <span data-row-action="" className="ml-auto flex shrink-0 items-center gap-1.5">
                  {action}
                  {menu}
                </span>
              ) : null}
            </div>
          </>
        )}
        {handOffCapture}
        {blockerBelow}
        <ActionError error={error} onEdit={onEdit ? () => onEdit(post) : null} onNavigate={onNavigate} />
      </div>
    </li>
  );
}

// Cross-post grouping (mockup B, an optional view, default off): a Reel and a Short of the same
// video at the same time are one decision, shown as one row with a line per lane. The rule is a
// display rule only: same project, same media file, same scheduled time. A post without media
// never groups, and a group of one is an ordinary row. Each row keeps the order of its first
// post, so the list's sort still holds.
const GROUP_PREF_KEY = 'pendpost-approvals-group';
const mediaIdentity = (post) => post?.media?.path || post?.media?.url || post?.image || '';
export function crossPostRows(items, keyFn = keyOf) {
  const byGroup = new Map();
  const rows = [];
  for (const post of items) {
    const media = mediaIdentity(post);
    const gk = media ? `${post.clientId || ''}|${media}|${post.scheduledAt || ''}` : null;
    if (gk && byGroup.has(gk)) { byGroup.get(gk).posts.push(post); continue; }
    const row = { key: keyFn(post), posts: [post], gk };
    if (gk) byGroup.set(gk, row);
    rows.push(row);
  }
  for (const row of rows) if (row.posts.length > 1) row.key = `group:${row.gk}`;
  return rows;
}

// One cross-post group row: checkbox | the shared media (88px) | the meta line, the shared
// caption and one line per lane (ApprovalCard's lane mode, so every lane keeps its own status,
// fix, approve and ⋯). "Approve all" approves every approvable member through the SAME bulk
// approve the toolbar runs (approveAll), and `a` on the focused group row does the same.
function CrossPostGroup({ posts, focused, registerRef, onArrowNav, onActed, onOpen, isSelected, onToggleGroup, approveAll, renderLane, compact }) {
  const t = useT();
  const first = posts[0];
  // The caption of the first lane that publishes no title (the caption IS that post), else the
  // first member's.
  const lead = posts.find((p) => !postPublishedTitle(p)) || first;
  const captionRun = postCaptionRun(lead);
  const approvable = posts.filter(isActionable);
  const [error, setError] = useState(null);
  const keyBusyRef = useRef(false);
  const runApproveAll = async () => {
    setError(null);
    await approveAll(approvable, setError);
    onActed?.(first);
  };
  const onKeyDown = (e) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      onArrowNav?.(e.key === 'ArrowDown' ? 1 : -1, first);
      return;
    }
    if (e.altKey || e.ctrlKey || e.metaKey || e.key.toLowerCase() !== 'a') return;
    if (!approvable.length || keyBusyRef.current) return;
    e.preventDefault();
    keyBusyRef.current = true;
    Promise.resolve(runApproveAll())
      .catch((err) => { if (err?.canceled !== true) setError(actionAlert(err, t)); })
      .finally(() => { keyBusyRef.current = false; });
  };
  const selectedCount = approvable.filter(isSelected).length;
  const groupSelected = selectedCount > 0 && selectedCount === approvable.length;
  const when = first.scheduledAt ? fmtRowWhen(first.scheduledAt) : t('approvals.card.noSchedule');
  return (
    <li
      ref={registerRef}
      data-cross-post-group=""
      tabIndex={focused ? 0 : -1}
      data-focused={focused ? '' : undefined}
      data-selected={groupSelected ? '' : undefined}
      onKeyDown={onKeyDown}
      aria-keyshortcuts={approvable.length ? 'a' : undefined}
      className={`group flex items-start gap-3 transition focus-within:ring-2 focus-within:ring-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand hover:ring-brand/40 sm:gap-4 ${rowSurface(groupSelected)} ${compact ? 'rounded-lg px-3 py-2.5' : 'rounded-xl p-3'}`}
    >
      {approvable.length ? (
        <span className="flex h-5 w-4 shrink-0 items-center">
          <Checkbox
            checked={groupSelected}
            indeterminate={selectedCount > 0 && selectedCount < approvable.length}
            onChange={() => onToggleGroup(posts)}
            aria-label={t('approvals.group.select')}
          />
        </span>
      ) : compact ? <span className="w-4 shrink-0" aria-hidden="true" /> : null}
      <span data-row-media="" aria-hidden="true" onClick={() => onOpen(lead)} className="block w-16 shrink-0 cursor-pointer sm:w-[88px]">
        <CoverThumb media={first.media} image={first.image} className={`block w-full ${gridDisplayAspect(first)} rounded-lg`} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-start gap-x-4 gap-y-2">
          <button
            type="button"
            onClick={() => onOpen(lead)}
            className="flex min-w-0 flex-1 basis-full cursor-pointer flex-col gap-1.5 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand sm:basis-0"
          >
            <span data-row-meta="" className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-zinc-600 dark:text-zinc-300">
              <span>{t(isImageMedia(first.media) ? 'type.image' : 'type.video')}</span>
              <span aria-hidden="true">·</span>
              <span className="whitespace-nowrap font-semibold tabular-nums">{when}</span>
              {first.clientName ? (
                <span className={`${PROJECT_CHIP} max-w-[8rem]`}>
                  <ClientAvatar client={{ displayName: first.clientName, accent: first.accent, logo: null }} size={14} />
                  <span className="truncate">{first.clientName}</span>
                </span>
              ) : null}
            </span>
            {captionRun ? <span data-row-caption="" className="text-sm leading-relaxed line-clamp-3">{captionRun}</span> : null}
          </button>
          {approvable.length ? (
            <span data-row-action="" className="ml-auto flex shrink-0 items-center">
              <ActionButton
                variant="success"
                data-row-approve=""
                className="justify-center"
                icon={CheckCircle2}
                quietError
                labels={{ idle: t('approvals.group.approveAll'), loading: t('approvals.action.approving'), success: t('approvals.action.approved'), error: t('approvals.action.error') }}
                onAction={guardAction(runApproveAll, setError, t)}
              />
            </span>
          ) : null}
        </div>
        <ul data-group-lanes="" className="flex min-w-0 flex-col border-t border-zinc-900/5 dark:border-white/10">
          {posts.map(renderLane)}
        </ul>
        <ActionError error={error} />
      </div>
    </li>
  );
}

// The Approvals keyboard shortcuts (a / r / arrows). They ride the filter bar's "?" popover under
// the status legend (App.jsx passes them to FilterBar on this page), so the toolbar spends no
// control on them.
export function KeyboardShortcuts() {
  const t = useT();
  return (
    <ShortcutList
      rows={[
        { keys: ['a'], label: t('approvals.keys.approve') },
        { keys: ['r'], label: t('approvals.keys.reject') },
        { keys: ['↑', '↓'], label: t('approvals.keys.navigate'), glyphs: true },
      ]}
    />
  );
}

// Header "Select all" / "Clear selection" checkbox. Indeterminate (some but
// not all actionable items selected) is cosmetic, handled by the shared Checkbox.
// The approval surface. Default mode "To review" = everything not yet approved
// (drafts + pending + rejected), unpublished, soonest due first. The "All"
// toggle shows every post chronologically (the owner asked to also see the
// full plan here, not just the queue). Approval always acts as the owner; the
// no-self-approval rule binds agents on the MCP face.
export default function Freigaben({ campaigns, onOpen, onEdit, clientName = '', onNavigate = () => {}, platformFilter = [], typeFilter = [], statusFilter = [], isLoading = false, onModeChange, allProjects = false }) {
  const [mode, setMode] = useState('pending'); // 'pending' | 'all'
  // Mirror the tab up so App can gate the shared Status filter to the "All posts" tab
  // (the Status dropdown is dead on the pending tab, which forces statusFilter to []).
  useEffect(() => { onModeChange?.(mode); }, [mode, onModeChange]);
  // Radar-replies facet on the pending tab. EPHEMERAL by design (no localStorage):
  // it is a triage move for the current sitting, not a standing view preference -
  // a persisted narrow filter would silently hide non-radar decision work on the
  // next visit.
  const [radarOnly, setRadarOnly] = useState(false);
  // Card density. Persisted grid<->compact preference, mirroring the Assets
  // grid/list idiom (read once from localStorage, persisted in an effect below);
  // a failed read in private mode just falls back to the comfortable default.
  const [density, setDensity] = useState(() => {
    try { return localStorage.getItem('pendpost-approvals-density') === 'compact' ? 'compact' : 'comfortable'; } catch { return 'comfortable'; }
  });
  // Cross-post grouping (mockup B): an optional view, OFF by default, persisted like density.
  const [grouped, setGrouped] = useState(() => {
    try { return localStorage.getItem(GROUP_PREF_KEY) === 'on'; } catch { return false; }
  });
  // Sort direction, held and persisted PER TAB. One shared key would let a choice made
  // on the archive silently reorder the work queue on the next visit, which would undo
  // the whole point of the two defaults. Same lazy-read + effect-write idiom as density
  // three lines up, so this component has one preference pattern, not two.
  const [sortByMode, setSortByMode] = useState(() => ({
    pending: readSortPref('pending'),
    all: readSortPref('all'),
  }));
  const sortOrder = sortByMode[mode];
  const setSortOrder = useCallback(
    (next) => setSortByMode((prev) => ({ ...prev, [mode]: next })),
    [mode],
  );
  const prompt = usePrompt();
  const t = useT();
  // Spec 37: the setup signal carries reddit.warmth (per client), the input the per-card
  // tier cue reads. One cached read shared by every card (no per-card fetch).
  const { data: pendpostHealth } = usePendpostHealth(true);
  const setup = pendpostHealth?.setup || null;
  // Read ONCE at the parent, exactly like the health signal above. 114 cards each
  // calling useAccounts would be 114 subscriptions re-rendering on every 60s refetch.
  const { data: accounts, isLoading: accountsLoading, isError: accountsError } = useAccounts();
  // Spec 48 R10 (V6): whether this project requires client sign-off. Read once at the
  // parent (client-scoped config) and threaded down so the approve control relabels to
  // "Send for sign-off" for every card without a per-card config subscription.
  const { data: reviewConfig } = useConfig(true);
  const reviewRequired = Boolean(reviewConfig?.posting?.review?.required);

  useEffect(() => {
    try { localStorage.setItem('pendpost-approvals-density', density); } catch { /* private mode - ignore */ }
  }, [density]);
  useEffect(() => {
    try { localStorage.setItem(GROUP_PREF_KEY, grouped ? 'on' : 'off'); } catch { /* private mode - ignore */ }
  }, [grouped]);

  useEffect(() => {
    try {
      for (const m of ['pending', 'all']) localStorage.setItem(SORT_PREF_KEY(m), sortByMode[m]);
    } catch { /* private mode - ignore */ }
  }, [sortByMode]);

  // Roving-focus controller. `focusKey` (a keyOf, not an index - an index would be
  // meaningless across the items useMemo re-sorting on every refetch) owns the tab
  // stop; `cardRefs` maps keyOf -> <li>; `didInitialFocusRef` makes first-card
  // focus a one-shot per empty->populated transition so a background react-query
  // refetch never steals focus; `pendingAdvanceRef` records the acted index so
  // focus can auto-advance to the next item after the post-refetch re-render.
  const cardRefs = useRef(new Map());
  const [focusKey, setFocusKey] = useState(null);
  const didInitialFocusRef = useRef(false);
  const pendingAdvanceRef = useRef(null);

  // EVERY campaign is in scope, archived (active:false) included: the active flag
  // is organizational only and never gates publishing (lib/scheduler.mjs), so an
  // archived campaign's draft is real decision work and its approved post still
  // fires. Owner invariant (2026-07-21): nothing awaiting a decision can hide.
  // Archived posts are badged on the card and sort after active ones in the queue.
  const activeIds = useMemo(() => new Set(campaigns.filter((c) => c.active).map((c) => c.id)), [campaigns]);
  const all = useMemo(() => campaigns.flatMap((c) => c.posts || []), [campaigns]);
  // Each card is judged by its OWN project's setup (lib/setupByClient.js): in All-projects
  // mode a pendpost X draft reads by pendpost's connections, never the active project's.
  // One fetch per project, shared by every card (react-query dedupes with App's fan-out).
  const postClientIds = useMemo(() => [...new Set(all.map((p) => p.clientId).filter(Boolean))], [all]);
  const { setupFor } = useSetupByClient(postClientIds, { activeSetup: setup });
  const actionable = useMemo(() => all.filter(isActionable), [all]);
  // Every post still awaiting a decision, filters ignored. This is the GLOBAL truth
  // ("is there open work at all?"), so it - not the visible count - keeps the
  // cleared-queue reward state honest.
  const pendingTotal = useMemo(() => actionable.length, [actionable]);
  // What the pending list ACTUALLY shows: the same actionable set through the same
  // platform/type predicate the list applies (status is already ignored in pending
  // mode, see items below). The tab chip counts THIS, so the badge and the list it
  // labels cannot disagree - a platform chip used to leave "To review (3)" sitting
  // over an empty list, which teaches the operator to distrust the badge.
  const pendingVisible = useMemo(
    () => actionable.filter((p) => matchesFilters(p, platformFilter, typeFilter, [])).length,
    [actionable, platformFilter, typeFilter],
  );
  // The radar-replies count, scoped EXACTLY like pendingVisible (same actionable set,
  // same platform/type predicate), so the chip's count and the list it narrows to can
  // never disagree.
  const radarPending = useMemo(
    () => actionable.filter((p) => p.radarReplyTo && matchesFilters(p, platformFilter, typeFilter, [])).length,
    [actionable, platformFilter, typeFilter],
  );
  // Derived, not an effect (Radar's effectiveFilter pattern): when the last radar
  // draft is decided the chip hides and the filter self-releases this very frame,
  // so a pressed chip never sits over an empty list.
  const effectiveRadarOnly = radarOnly && radarPending > 0;

  // Freigaben error UX (2026-11-06). blockerMap: each mounted card's hard blockers, keyed by
  // selectionKey (an empty list = checked and clean; no entry = not known). runReport: what the
  // last bulk approve left out or had refused, until dismissed or resolved. showOnly: the list
  // narrowed to those posts. fixProgress: the "fix all with agent" queue, {done,total} or null.
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [blockerMap, setBlockerMap] = useState(() => new Map());
  const reportBlockers = useCallback((key, list) => {
    setBlockerMap((prev) => {
      if (list === undefined) {
        if (!prev.has(key)) return prev;
        const next = new Map(prev);
        next.delete(key);
        return next;
      }
      const had = prev.get(key);
      if (had && had.length === list.length && had.every((b, i) => b.code === list[i].code && b.platform === list[i].platform && b.text === list[i].text)) return prev;
      const next = new Map(prev);
      next.set(key, list);
      return next;
    });
  }, []);
  const [runReport, setRunReport] = useState(null);
  const [showOnly, setShowOnly] = useState(false);
  const [fixProgress, setFixProgress] = useState(null);
  const offlineLanesOf = useCallback((post) => unconnectedLanes(post, setupFor(post)), [setupFor]);
  const blockersOf = useCallback((post) => blockerMap.get(selectionKey(post)) || [], [blockerMap]);
  // The run summary, judged LIVE: an entry leaves once its post is decided, edited clean or
  // connected, so the line goes away by itself when everything it named is resolved. A post
  // the list does not show right now (a filter) keeps its entry.
  const postByKey = useMemo(() => new Map(all.map((p) => [selectionKey(p), p])), [all]);
  const liveReport = useMemo(() => {
    if (!runReport) return null;
    const live = [];
    for (const e of runReport.entries) {
      const post = postByKey.get(e.key);
      if (!post || !isActionable(post)) continue;
      if (e.kind === 'blocked' && blockerMap.has(e.key) && !blockerMap.get(e.key).length) continue;
      if (e.kind === 'offline' && !offlineLanesOf(post).length) continue;
      live.push({ ...e, post });
    }
    return live.length ? { ok: runReport.ok, entries: live } : null;
  }, [runReport, postByKey, blockerMap, offlineLanesOf]);
  // The "show only these" filter releases itself once the line it belongs to is gone.
  const showKeys = useMemo(() => (showOnly && liveReport ? new Set(liveReport.entries.map((e) => e.key)) : null), [showOnly, liveReport]);

  const items = useMemo(() => {
    const base = mode === 'pending' ? actionable : all;
    const newestFirst = sortOrder === 'newest';
    // "To review" IS a status bucket, so filtering it BY status contradicts the tab
    // (and the count on it): a leftover global statusFilter - e.g. ['overdue'], which
    // the planner's Ueberfaellig chip sets and which persists across pages/clients -
    // would empty the queue while the tab still counts the posts. Status filters the
    // 'all' view only; platform/type stay (they are orthogonal to the decision).
    // Queue order: active-campaign work first, archived after (labelled, still
    // reachable, never blocking the live pipeline); within each group by date.
    // The 'all' view is purely chronological.
    //
    // The DIRECTION is the operator's, and it defaults differently per tab because the
    // two tabs are different objects: "Zu pruefen" is a work queue, so the soonest-due
    // item is the one to act on, while "Alle Beitraege" is an archive, where the most
    // recent post is the one being looked for. That default is why this list opened on
    // 11.06.26.
    const byDate = (a, b) => comparePostDate(a, b, newestFirst ? -1 : 1);
    return base
      .filter((p) => matchesFilters(p, platformFilter, typeFilter, mode === 'pending' ? [] : statusFilter, setupFor))
      // The radar-replies facet: pending tab only, one predicate, flat list - the
      // keyboard a/r triage and roving focus see an ordinary (shorter) items array.
      .filter((p) => mode !== 'pending' || !effectiveRadarOnly || p.radarReplyTo)
      // The run summary's "show only these".
      .filter((p) => !showKeys || showKeys.has(selectionKey(p)))
      .sort(mode === 'pending'
        ? (a, b) => (activeIds.has(b.campaign) - activeIds.has(a.campaign)) || byDate(a, b)
        : byDate);
  }, [all, actionable, mode, platformFilter, typeFilter, statusFilter, activeIds, sortOrder, effectiveRadarOnly, setupFor, showKeys]);

  // What the list renders: one row per post, or, with grouping on, one row per cross-post group.
  // Roving focus, arrow keys and the auto-advance walk these rows; counts stay on POSTS (items).
  const rows = useMemo(() => (grouped ? crossPostRows(items) : items.map((p) => ({ key: keyOf(p), posts: [p] }))), [grouped, items]);
  const rowKeyByPost = useMemo(() => {
    const m = new Map();
    for (const r of rows) for (const p of r.posts) m.set(keyOf(p), r.key);
    return m;
  }, [rows]);
  const rowKeyOf = useCallback((post) => rowKeyByPost.get(keyOf(post)) || keyOf(post), [rowKeyByPost]);

  // The lanes actually present in what the operator is looking at. Naming a lane the
  // list does not contain would be noise; naming one it does is the whole point.
  const visiblePlatforms = useMemo(() => {
    const seen = new Set();
    for (const p of items) for (const plat of p.platforms || []) seen.add(plat);
    return [...seen];
  }, [items]);

  // The cleared-queue reward state must MEAN it: nothing awaits review AT ALL. A
  // queue emptied merely by a platform/type filter is not an achievement, so it
  // falls through to the neutral "Keine Beitraege / Passe die Filter an" state
  // rather than claiming everything is approved while the tab still counts open work.
  const clearedQueue = mode === 'pending' && pendingTotal === 0;

  // Callback ref each card registers with - auto-cleans on unmount.
  const registerCard = useCallback((key) => (el) => {
    if (el) cardRefs.current.set(key, el);
    else cardRefs.current.delete(key);
  }, []);

  // Move the roving tab stop to a card and pull DOM focus to it. preventScroll +
  // a separate scrollIntoView({block:'nearest'}) is the anti-jank pattern: focus
  // never yanks the scroll container, and we only scroll when the card is off-view.
  const focusCardByKey = useCallback((key) => {
    if (!key) return;
    setFocusKey(key);
    const el = cardRefs.current.get(key);
    if (el) {
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: 'nearest' });
    }
  }, []);
  const focusCardAtIndex = useCallback((index) => {
    const row = rows[index];
    if (row) focusCardByKey(row.key);
  }, [rows, focusCardByKey]);

  // ArrowUp/Down from the focused card: move focus to the clamped neighbour.
  const onArrowNav = useCallback((dir, post) => {
    const idx = rows.findIndex((r) => r.key === rowKeyOf(post));
    if (idx === -1) return;
    focusCardAtIndex(Math.min(rows.length - 1, Math.max(0, idx + dir)));
  }, [rows, rowKeyOf, focusCardAtIndex]);

  // A card fires this on a SUCCESSFUL approve/reject. Record the acted index; the
  // effect below consumes it once the items list has re-rendered post-refetch.
  const onActed = useCallback((post) => {
    const actedKey = rowKeyOf(post);
    pendingAdvanceRef.current = { actedKey, index: rows.findIndex((r) => r.key === actedKey) };
  }, [rows, rowKeyOf]);

  // The single focus-orchestration effect. Runs whenever `items` changes (the
  // identity change a refetch/filter/mode flip produces) and handles, in order:
  // (1) empty queue -> reset; (2) a pending auto-advance after an action;
  // (3) first-populate -> focus the first card once; (4) steady state -> only
  // repair a dangling focusKey WITHOUT moving DOM focus (so a background refetch
  // never yanks focus from where the reviewer is).
  useEffect(() => {
    if (!rows.length) {
      didInitialFocusRef.current = false;
      pendingAdvanceRef.current = null;
      if (focusKey !== null) setFocusKey(null);
      return;
    }
    const pending = pendingAdvanceRef.current;
    if (pending) {
      pendingAdvanceRef.current = null;
      // pending mode: the acted card unmounted, so the item now AT its index is
      // the next one -> focus `index`. all mode: the acted card stays (now
      // non-actionable) -> advance to index+1. Both clamped to the last card.
      const stillThere = rows.some((r) => r.key === pending.actedKey);
      const target = stillThere ? Math.min(pending.index + 1, rows.length - 1) : Math.min(pending.index, rows.length - 1);
      const raf = requestAnimationFrame(() => focusCardAtIndex(Math.max(0, target)));
      return () => cancelAnimationFrame(raf);
    }
    if (!didInitialFocusRef.current) {
      didInitialFocusRef.current = true;
      // Pull focus to the first card so a/r work immediately on open - but only
      // if the reviewer hasn't already focused something (never yank focus away
      // from a deliberate interaction). Auto-advance below is exempt (it IS the
      // deliberate interaction).
      const raf = requestAnimationFrame(() => {
        const ae = typeof document !== 'undefined' ? document.activeElement : null;
        if (!ae || ae === document.body) focusCardAtIndex(0);
      });
      return () => cancelAnimationFrame(raf);
    }
    if (focusKey && !rows.some((r) => r.key === focusKey)) {
      setFocusKey(rows[0].key);
    }
  }, [rows, focusKey, focusCardAtIndex]);

  // The selection + bulk runner are the shared ones (lib/useSelection.js, the planner List
  // runs the same pattern). Only ACTIONABLE visible posts are selectable, and every count and
  // bulk loop reads the effective selection (selectable visible posts that are selected), never
  // the raw Set: filters/mode can hide a once-selected post.
  const {
    isSelected, toggle: toggleSelect, selectThread, toggleGroup, clear: clearSelection, selectAll,
    selectable: actionableItems, effectiveSelection, count: selCount, runBulk, bulkProgress, bulkError, setBulkError,
  } = useSelection({ items, isSelectable: isActionable, threadPool: all });

  // What bulk approve leaves out, decided BEFORE the press (Freigaben error UX, 2026-11-06,
  // owner pick A): a post with a hard blocker (its own Approve is disabled, so the server would
  // only refuse it) and a post whose lane is not connected (approving publishes nothing). Both
  // stay selected and visible with their own fix; the server never receives them. The skip
  // glyph beside Approve says how many and why, a hover away.
  const selSplit = useMemo(() => approveSplit(effectiveSelection, { blockersOf, offlineLanesOf }), [effectiveSelection, blockersOf, offlineLanesOf]);
  const selSkipped = selSplit.blocked.length + selSplit.offline.length;
  const skipTip = selSkipped ? skipLine(skipCauses(selSplit, t), selSkipped, t) : null;

  // The ONE bulk approve: the toolbar's approve runs it on the selection, a cross-post group's
  // "Approve all" on its approvable members. Only the posts that can publish are sent; what was
  // left out or refused becomes the run summary line (ApprovalRunSummary), never a red
  // paragraph of post ids. The approve notices (image not online yet, brand-rule hints) say it
  // ONCE for the whole run. A Radar reply past its time among the approved posts is named as
  // going 5 minutes after the approval.
  const approveMany = async (list) => {
    const split = approveSplit(list, { blockersOf, offlineLanesOf });
    const results = [];
    const approved = [];
    let settled = { done: [], fails: [] };
    if (split.send.length) {
      try {
        await runBulk(async (p) => { results.push(await (p.clientId ? approvePost(p.campaign, p.id, undefined, p.clientId) : approvePost(p.campaign, p.id))); approved.push(p); }, t('approvals.bulk.labelApproved'), split.send, { onSettled: (r) => { settled = r; } });
      } catch { /* the refusals are in `settled`; the summary line names their causes */ } finally {
        showApproveNotice(results, t, { posts: approved });
      }
    }
    const entries = [
      ...split.blocked.map(({ post }) => ({ key: selectionKey(post), kind: 'blocked' })),
      ...split.offline.map(({ post }) => ({ key: selectionKey(post), kind: 'offline' })),
      ...settled.fails.map((f) => ({ key: selectionKey(f.post), kind: 'failed', text: f.known ? f.text : null })),
    ];
    setRunReport(entries.length ? { ok: settled.done.length, entries } : null);
    setShowOnly(false);
    // Nothing went through: the button must not flash a success.
    if (!settled.done.length) throw { canceled: true };
  };

  const reportCauses = useMemo(() => {
    if (!liveReport) return [];
    const by = (kind) => liveReport.entries.filter((e) => e.kind === kind);
    return skipCauses({
      blocked: by('blocked').map((e) => ({ post: e.post, blockers: blockersOf(e.post) })).filter((x) => x.blockers.length),
      offline: by('offline').map((e) => ({ post: e.post, lanes: offlineLanesOf(e.post) })),
      failed: by('failed').map((e) => ({ post: e.post, text: e.text })),
    }, t);
  }, [liveReport, blockersOf, offlineLanesOf, t]);

  // "Fix all with agent": every blocked post in the current view whose project has an agent and
  // that has a cause the agent can fix (never a connection, which Connect fixes, and never a
  // turned-off platform that is the post's only one, which only turning it on fixes). The engine runs one fix
  // at a time, so it is the planner's queue (runAgentFixQueued), one post after another.
  const agentFixable = useMemo(
    () => items.filter((p) => agentCanTry(blockersOf(p), p) && agentAvailable(setupFor(p))),
    [items, blockersOf, setupFor],
  );
  const fixAll = async () => {
    if (fixProgress || !agentFixable.length) return;
    const list = agentFixable.slice();
    const ok = await confirm({
      title: t('approvals.result.fixAllConfirm.title'),
      body: t('approvals.result.fixAllConfirm.body', { n: list.length }),
      confirmLabel: t('approvals.result.fixAllConfirm.ok'),
    });
    if (!ok) return;
    let changed = 0;
    setFixProgress({ done: 0, total: list.length });
    try {
      for (const p of list) {
        try {
          const job = await runAgentFixQueued(p, { // eslint-disable-line no-await-in-loop
            start: async (x) => {
              await agentFixPost(x.campaign, x.id, x.clientId);
              queryClient.invalidateQueries({ queryKey: ['agentFix'] });
            },
            list: (x) => getAgentFixes(x.clientId),
            jobFor: (data, x) => fixFor(data, x.campaign, x.id, x.clientId),
          });
          if (job?.state === 'done') changed += 1;
        } catch { /* the row's own agent glyph shows the job's verdict */ }
        setFixProgress((prev) => (prev ? { ...prev, done: prev.done + 1 } : prev));
      }
    } finally {
      setFixProgress(null);
      queryClient.invalidateQueries({ queryKey: ['plans'] });
      queryClient.invalidateQueries({ queryKey: ['agentFix'] });
      queryClient.invalidateQueries({ queryKey: ['platform-validate'] });
    }
    showToast({ kind: 'success', text: t('approvals.result.fixAllDone', { n: changed }) });
  };

  // All-projects mode: the posts that wait for a lane that is not connected, ONE line per
  // project at the top of the queue (one-project mode has the DestinationStrip for it).
  const unconnected = useMemo(() => (allProjects ? unconnectedGroups(items, offlineLanesOf) : []), [allProjects, items, offlineLanesOf]);

  const approveLabel = t('approvals.bulk.approveN', { n: selSplit.send.length });
  const rejectLabel = t('approvals.bulk.rejectN', { n: selCount });
  // The selecting toolbar is filled only while actually pinned (lib/useStuck.js): in the flow an
  // opaque fill reads as a band on the translucent glass panel.
  const toolbarRef = useRef(null);
  const toolbarStuck = useStuck(toolbarRef, { enabled: selCount > 0 });

  return (
    <div className="flex h-full flex-col gap-3">
      {/* flex-wrap, and gap-y so a wrapped row does not collide. Measured against the
          real de-CH strings this row is already ~530px in a 375px viewport BEFORE the
          sort toggle, so it was overflowing horizontally on mobile already.
          US-APPR-07: while a selection exists the toolbar itself carries the bulk actions and
          sticks to the top of <main> (the one scroller), so they stay in reach down a long
          list. While pinned its surface is the glass panel composited over the page (white/70
          over slate-50, zinc-900/60 over zinc-950), opaque so no row shows through, and it
          reaches over the panel's padding so the stuck strip reads as the panel's own top. */}
      <div
        ref={toolbarRef}
        data-stuck={toolbarStuck ? '' : undefined}
        className={`flex flex-wrap items-center gap-x-3 gap-y-2 ${selCount ? 'sticky top-0 z-20 -mx-4 -my-2 rounded-2xl px-4 py-2 data-[stuck]:bg-[#fdfefe] dark:data-[stuck]:bg-[#121215]' : ''}`}
      >
        <div data-spot="approvals" className="flex items-center rounded-xl bg-zinc-200/60 p-0.5 dark:bg-zinc-800/60" role="group" aria-label={t('approvals.view.label')}>
          {[
            ['pending', pendingVisible ? t('approvals.view.toReviewCount', { n: pendingVisible }) : t('approvals.view.toReview')],
            ['all', t('approvals.view.all')],
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setMode(key)}
              aria-pressed={mode === key}
              className={`rounded-[10px] px-3 py-1 text-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                mode === key ? 'bg-white text-brand shadow dark:bg-zinc-700 dark:text-brand-light' : 'text-zinc-500 dark:text-zinc-400'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {/* Radar-replies facet (Published's evergreen-filter idiom): offered only on
            the pending tab and only while radar reply drafts are actually awaiting a
            decision, so it is never an empty toggle. Count in the label; hidden at
            zero; the derived effectiveRadarOnly above self-releases it. */}
        {mode === 'pending' && radarPending > 0 ? (
          <Tip label={t('approvals.filter.radar.tip')}>
            <button
              type="button"
              onClick={() => setRadarOnly((v) => !v)}
              aria-pressed={effectiveRadarOnly}
              className={`inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                effectiveRadarOnly ? 'bg-brand text-white dark:bg-brand-light dark:text-zinc-900' : `${INNER_SURFACE} text-zinc-600 hover:ring-1 hover:ring-brand/40 dark:text-zinc-400`
              }`}
            >
              <Bot size={13} aria-hidden="true" />
              {t('approvals.filter.radar', { n: radarPending })}
            </button>
          </Tip>
        ) : null}
        {/* Card density toggle: comfortable cards <-> compact rows. Icon-only
            (label via aria-label/title) to keep the header lean, mirroring the
            Assets grid/list metaphor. */}
        <div className="flex items-center rounded-xl bg-zinc-200/60 p-0.5 dark:bg-zinc-800/60" role="group" aria-label={t('approvals.density.label')}>
          {[
            ['comfortable', LayoutGrid, t('approvals.density.comfortable')],
            ['compact', List, t('approvals.density.compact')],
          ].map(([key, Icon, label]) => (
            <Tip key={key} label={label}>
              <button
                type="button"
                onClick={() => setDensity(key)}
                aria-pressed={density === key}
                aria-label={label}
                className={`flex items-center rounded-[10px] px-2.5 py-1.5 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                  density === key ? 'bg-white text-brand shadow dark:bg-zinc-700 dark:text-brand-light' : 'text-zinc-500 dark:text-zinc-400'
                }`}
              >
                <Icon size={14} aria-hidden="true" />
              </button>
            </Tip>
          ))}
        </div>
        {/* Cross-post grouping: a view choice like density, so it wears one segment of the same
            toggle, glyph only (the name rides the tooltip and the accessible name). Off by
            default; works in both layouts. */}
        <div className="flex items-center rounded-xl bg-zinc-200/60 p-0.5 dark:bg-zinc-800/60">
          <Tip label={t('approvals.group.toggle')}>
            <button
              type="button"
              onClick={() => setGrouped(!grouped)}
              aria-pressed={grouped}
              aria-label={t('approvals.group.toggle')}
              className={`flex items-center rounded-[10px] px-2.5 py-1.5 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                grouped ? 'bg-white text-brand shadow dark:bg-zinc-700 dark:text-brand-light' : 'text-zinc-500 dark:text-zinc-400'
              }`}
            >
              <Combine size={14} aria-hidden="true" />
            </button>
          </Tip>
        </div>
        {/* Sort direction. A two-value choice, so it is a toggle and not a Select:
            "a Select for a two-value choice would be ceremony" (Radar's own rule), and
            a dropdown would also add ~190px to a row that already has to wrap at 375px.
            Rendered on BOTH tabs - the order was previously unstated on both - with the
            default and the stored preference kept per tab. */}
        <Tip label={t(sortOrder === 'newest' ? 'approvals.sort.newest' : 'approvals.sort.oldest')}>
          <button
            type="button"
            onClick={() => setSortOrder(sortOrder === 'newest' ? 'oldest' : 'newest')}
            aria-label={t(sortOrder === 'newest' ? 'approvals.sort.newest' : 'approvals.sort.oldest')}
            className="flex items-center gap-1.5 rounded-xl bg-zinc-200/60 px-2.5 py-1.5 text-[11px] font-bold text-zinc-600 transition hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-zinc-800/60 dark:text-zinc-300 dark:hover:text-brand-light"
          >
            {sortOrder === 'newest' ? <ArrowDown size={13} aria-hidden="true" /> : <ArrowUp size={13} aria-hidden="true" />}
            <span>{t(sortOrder === 'newest' ? 'approvals.sort.newestShort' : 'approvals.sort.oldestShort')}</span>
          </button>
        </Tip>
        {/* Select all, and while a selection exists its count in the label's place and the
            two bulk verdicts as glyphs right beside it. The checkbox clears any selection,
            partial or full; there is no separate clear. */}
        <span className="flex items-center gap-2">
          <SelectAllControl total={actionableItems.length} selectedCount={selCount} onToggle={selCount ? clearSelection : selectAll} allKey="approvals.selectAll.all" countKey="approvals.bulk.selected" />
          {selCount ? (
            <>
              <Tip label={rejectLabel}>
                <ActionButton
                  size="icon"
                  variant="subtle"
                  icon={XCircle}
                  ariaLabel={rejectLabel}
                  className={TAP_TARGET}
                  onAction={guardAction(async () => {
                    const note = await prompt({
                      title: t('approvals.bulkRejectPrompt.title'),
                      body: t('approvals.rejectPrompt.body'),
                      multiline: true,
                      rememberKey: 'approvals.reject',
                    });
                    if (note === null) throw { canceled: true };
                    await runBulk((p) => (p.clientId ? rejectPost(p.campaign, p.id, note || undefined, p.clientId) : rejectPost(p.campaign, p.id, note || undefined)), t('approvals.bulk.labelRejected'));
                  }, setBulkError, t)}
                />
              </Tip>
              <Tip label={approveLabel}>
                <ActionButton
                  size="icon"
                  // Nothing approvable in the selection: the grey outline, not a disabled
                  // filled green that still reads as the live action.
                  variant={selSplit.send.length ? 'primary' : 'outline'}
                  icon={CheckCircle2}
                  ariaLabel={bulkProgress && bulkProgress.total > 1 ? t('approvals.action.approvingN', bulkProgress) : approveLabel}
                  className={TAP_TARGET}
                  disabled={!selSplit.send.length}
                  onAction={guardAction(() => approveMany(effectiveSelection), setBulkError, t)}
                />
              </Tip>
              {/* What Approve leaves out, BEFORE the press: a muted skip glyph and the count,
                  the causes a hover away. */}
              {selSkipped ? (
                <Tip label={skipTip}>
                  <span data-bulk-skip="" tabIndex={0} aria-label={skipTip} className="inline-flex h-10 shrink-0 items-center gap-1 rounded-xl px-1.5 text-xs font-bold tabular-nums text-zinc-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400">
                    <Ban size={14} className="text-amber-700 dark:text-amber-400" aria-hidden="true" />
                    {selSkipped}
                  </span>
                </Tip>
              ) : null}
            </>
          ) : null}
        </span>
        {/* The post count only where it adds a number: on "To review" the tab chip already says
            "To review (8)", so a second "8 posts" beside Select all is noise. It stays on the
            "All" tab (no count on its chip) and when a facet narrows the list below the chip.
            While a selection exists "N ausgewählt" holds the count slot: with both, the de-CH
            toolbar ran ~17px past one line at 1024px and the list jumped on the first tick. */}
        {selCount || (mode === 'pending' && pendingVisible === items.length) ? null : (
          <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('approvals.postCount', { n: items.length })}</span>
        )}
        {/* A bulk reject's failure summary (its reasons, never post ids), only while it exists. */}
        <ActionError error={bulkError} className="basis-full" />
        {/* What the last bulk approve left out or had refused: ONE quiet line, grouped by cause,
            until dismissed or resolved. */}
        {liveReport ? (
          <ApprovalRunSummary
            ok={liveReport.ok}
            total={liveReport.entries.length}
            causes={reportCauses}
            showOnly={Boolean(showKeys)}
            onToggleShow={() => setShowOnly((v) => !v)}
            fixable={agentFixable.length}
            onFixAll={fixAll}
            fixProgress={fixProgress}
            onDismiss={() => { setRunReport(null); setShowOnly(false); }}
          />
        ) : null}
      </div>

      {/* WHERE these posts land, stated ONCE for the whole client-scoped list. The
          approval cards show a platform glyph, which says instagram but not WHICH
          instagram - so on 2026-07-25 a second client's post was approved and published onto
          the pendpost account with nothing on screen that could have caught it. The
          destination belongs to the project, not the post, so it is one row here rather
          than a chip repeated on every card. Only the lanes this list actually contains
          are named, so the strip stays a fact about the work in front of the operator. */}
      {/* All-projects mode: the list spans projects whose accounts differ, so one strip
          cannot be true for all of them; each card's project chip says whose post it is and
          each card is judged by its own project's connections. */}
      {allProjects ? <UnconnectedProjectsLine groups={unconnected} onNavigate={onNavigate} /> : (
        <DestinationStrip
          platforms={visiblePlatforms}
          accounts={accounts}
          setup={setup}
          isLoading={accountsLoading}
          isError={accountsError}
          onNavigate={onNavigate}
        />
      )}

      {isLoading && !items.length ? (
        // Skeleton placeholders while the first plan fetch is in flight, so the
        // empty-state copy never flashes before any data has arrived (A16).
        <div className="grid grid-cols-1 content-start gap-2.5 p-1 xl:grid-cols-2 2xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : items.length ? (
        // No scroll box of its own: the list grows and the app's one scroller (<main>)
        // moves it, so the sticky toolbar above pins to the top of the page. p-1 keeps
        // the focus ring (ring-2) room at the edges. items-start: each card keeps its own
        // height, so a short card beside a tall one is never stretched into an empty band.
        <ul
          role="list"
          className={`${
            density === 'compact'
              ? 'flex flex-col gap-1.5 p-1'
              : 'grid grid-cols-1 content-start items-start gap-2.5 p-1 xl:grid-cols-2 2xl:grid-cols-3'
          } ${selCount ? '' : ONE_SOLID_APPROVE}`}
        >
          {rows.map((row) => (row.posts.length > 1 ? (
            <CrossPostGroup
              key={row.key}
              posts={row.posts}
              focused={focusKey === row.key}
              registerRef={registerCard(row.key)}
              onArrowNav={onArrowNav}
              onActed={onActed}
              onOpen={(p) => onOpen(p, items)}
              isSelected={isSelected}
              onToggleGroup={toggleGroup}
              approveAll={approveMany}
              compact={density === 'compact'}
              renderLane={(post) => (
                <ApprovalCard
                  key={keyOf(post)}
                  lane
                  post={post}
                  posts={all}
                  onOpen={(p) => onOpen(p, items)}
                  onEdit={onEdit}
                  selected={isSelected(post)}
                  onToggleSelect={toggleSelect}
                  onSelectThread={selectThread}
                  archived={!activeIds.has(post.campaign)}
                  onActed={onActed}
                  setup={setupFor(post)}
                  accounts={accounts}
                  onNavigate={onNavigate}
                  reviewRequired={reviewRequired}
                  onBlockers={reportBlockers}
                />
              )}
            />
          ) : (
            <ApprovalCard
              key={row.key}
              post={row.posts[0]}
              posts={all}
              onOpen={(p) => onOpen(p, items)}
              onEdit={onEdit}
              selected={isSelected(row.posts[0])}
              onToggleSelect={toggleSelect}
              onSelectThread={selectThread}
              archived={!activeIds.has(row.posts[0].campaign)}
              compact={density === 'compact'}
              focused={focusKey === row.key}
              registerRef={registerCard(row.key)}
              onArrowNav={onArrowNav}
              onActed={onActed}
              setup={setupFor(row.posts[0])}
              accounts={accounts}
              onNavigate={onNavigate}
              reviewRequired={reviewRequired}
              onBlockers={reportBlockers}
            />
          )))}
        </ul>
      ) : (
        <div className="grid flex-1 place-items-center py-16">
          <div className="max-w-xs space-y-2 text-center">
            {/* Cleared queue = the reward state: the gate at rest, quietly
                satisfied (motion kit's EmptyGate). The "all" view keeps the
                quiet Inbox glyph. Both honour reduced-motion via index.css. */}
            {clearedQueue ? (
              <div className="relative mx-auto mb-3 h-[72px] w-[72px]">
                <div
                  aria-hidden="true"
                  className="absolute -inset-5 rounded-full"
                  style={{ background: 'radial-gradient(circle, rgba(94,234,212,.14), transparent 70%)', animation: 'pp-glow-pulse 3s ease-in-out infinite' }}
                />
                <div className="relative text-brand dark:text-brand-light" style={{ animation: 'pp-rest 3.4s ease-in-out infinite' }}>
                  <GateMark size={72} />
                </div>
              </div>
            ) : (
              <Inbox size={26} className="mx-auto text-zinc-500" aria-hidden="true" />
            )}
            <p className="text-sm font-bold">{clearedQueue ? t('approvals.empty.pendingTitle') : t('approvals.empty.allTitle')}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {clearedQueue
                ? clientName
                  ? t('approvals.empty.pendingBodyForClient', { client: clientName })
                  : t('approvals.empty.pendingBody')
                : t('approvals.empty.allBody')}
            </p>
            {/* US-APPR-05: a clear empty queue offers the next step. The pending
                empty state deep-links to Planner so the operator who just cleared
                this client has somewhere to go. */}
            {clearedQueue ? (
              <button
                type="button"
                onClick={() => onNavigate('planner')}
                className="inline-flex items-center gap-1 rounded text-xs font-bold text-brand transition hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light"
              >
                <CalendarDays size={13} aria-hidden="true" />
                {t('approvals.empty.openPlanner')}
              </button>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
