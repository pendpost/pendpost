import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, XCircle, Pencil, Trash2, ImagePlus, ImageOff, Camera, CalendarClock, PauseCircle, CheckCheck, Send, ExternalLink, FileVideo, FileX2, ShieldCheck, ShieldAlert, ShieldX, Power, CornerUpLeft } from 'lucide-react';
import { fmtFull, fmtBytes, campaignBaseLabel, deliveryMode } from '../lib/format.js';
import {
  useAccounts, usePlatformValidate, useValidateMedia, useActiveClient,
  approvePost, rejectPost, deletePost, unschedulePost, reschedulePost, markPosted, verifyPost,
  runPublishDue, setCoverFrame, uploadCover, clearCover,
} from '../lib/api.js';
import { StatusPill, ApprovalPill, PLATFORM_META, INNER_SURFACE, SlideOver, CloseButton, PostPreview, PlatformBlockers, EYEBROW } from './ui.jsx';
import ClientBand from './ClientBand.jsx';
import { Tip } from './ui/Tooltip.jsx';
import { IconBadge } from './ui/IconBadge.jsx';
import BrandLintBadge from './ui/BrandLintBadge.jsx';
import ActionButton from './ui/ActionButton.jsx';
import { DateTimePicker } from './ui/DateTimePicker.jsx';
import { useConfirm, usePrompt } from './ui/confirm.jsx';
import { useT } from '../lib/i18n.js';

function Section({ title, children }) {
  return (
    <section className="space-y-1.5">
      <h3 className={EYEBROW}>{title}</h3>
      {children}
    </section>
  );
}

// Tier semantics (finding #44): `done` (emerald) is reserved for an artifact
// that is permanently published on the platform (fbReelId / igMediaId /
// liPostId). A natively-scheduled future object (FB scheduled post fbPostId,
// YouTube private+publishAt video ytVideoId) is `warn` (amber): it lives on the
// platform but is not yet live, and any reschedule/cancel DELETES the video.
function platformState(post, platform, t) {
  const { ids } = post;
  const nativeWarn = t('postDetail.platform.nativeWarn');
  if (platform === 'facebook') {
    if (ids.fbReelId) return { text: t('postDetail.platform.publishedReel', { id: ids.fbReelId }), tier: 'done' };
    if (ids.fbPostId) return { text: t('postDetail.platform.scheduledNatively', { id: ids.fbPostId }), tier: 'warn', warn: nativeWarn };
  }
  if (platform === 'instagram' && ids.igMediaId) return { text: t('postDetail.platform.published', { id: ids.igMediaId }), tier: 'done' };
  if (platform === 'linkedin' && ids.liPostId) return { text: t('postDetail.platform.published', { id: ids.liPostId }), tier: 'done' };
  if (platform === 'x' && ids.xPostId) return { text: t('postDetail.platform.published', { id: ids.xPostId }), tier: 'done' };
  if (platform === 'youtube' && ids.ytVideoId) return { text: t('postDetail.platform.scheduledNatively', { id: ids.ytVideoId }), tier: 'warn', warn: nativeWarn };
  if (platform === 'telegram' && ids.tgMessageId) return { text: t('postDetail.platform.published', { id: ids.tgMessageId }), tier: 'done' };
  if (platform === 'discord' && ids.dcMessageId) return { text: t('postDetail.platform.published', { id: ids.dcMessageId }), tier: 'done' };
  if (platform === 'reddit' && ids.redditPostId) return { text: t('postDetail.platform.published', { id: ids.redditPostId }), tier: 'done' };
  if (platform === 'pinterest' && ids.pinId) return { text: t('postDetail.platform.published', { id: ids.pinId }), tier: 'done' };
  if (platform === 'tiktok' && ids.tiktokVideoId) return { text: t('postDetail.platform.published', { id: ids.tiktokVideoId }), tier: 'done' };
  if (platform === 'mastodon' && ids.mastodonStatusId) return { text: t('postDetail.platform.published', { id: ids.mastodonStatusId }), tier: 'done' };
  if (platform === 'wordpress' && ids.wordpressPostId) return { text: t('postDetail.platform.published', { id: ids.wordpressPostId }), tier: 'done' };
  if (platform === 'ghost' && ids.ghostPostId) return { text: t('postDetail.platform.published', { id: ids.ghostPostId }), tier: 'done' };
  if (platform === 'nostr' && ids.nostrEventId) return { text: t('postDetail.platform.published', { id: ids.nostrEventId }), tier: 'done' };
  if (platform === 'gbp' && ids.gbpPostId) return { text: t('postDetail.platform.published', { id: ids.gbpPostId }), tier: 'done' };
  return { text: t('postDetail.platform.pending'), tier: 'pending' };
}

// The verify read-back result for one platform (post.verify, written by
// lib/verify.mjs): { tone, label, permalink } or null when this platform was
// never read back. Maps the per-platform engine `state` to an honest label.
function platformVerify(post, platform, t) {
  const v = post.verify?.platforms?.[platform];
  if (!v) return null;
  if (v.live) return { tone: 'ok', label: t('postDetail.verify.live'), permalink: v.permalink || null };
  if (v.state === 'scheduled') return { tone: 'warn', label: t('postDetail.verify.scheduled'), permalink: v.permalink || null };
  if (v.state === 'private-overdue') return { tone: 'err', label: t('postDetail.verify.privateOverdue'), permalink: null };
  if (v.state === 'missing') return { tone: 'err', label: t('postDetail.verify.missing'), permalink: null };
  return { tone: 'warn', label: t('postDetail.verify.notConfirmed'), permalink: v.permalink || null };
}

const ACTION_BTN = 'flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs font-bold transition focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50';

// Honest per-platform cover reality (mirrors covers.mjs applicability /
// PLATFORM-MATRIX.md) - never imply a cover reaches a platform it cannot.
function coverChips(post, t) {
  const chips = [];
  const source = post.cover?.source;
  for (const p of post.platforms) {
    if (p === 'facebook') chips.push({ p, ok: true, text: t('postDetail.cover.chip.fb') });
    else if (p === 'instagram') {
      if (post.type === 'story') chips.push({ p, ok: false, text: t('postDetail.cover.chip.igStory') });
      else if (source === 'file') chips.push({ p, ok: false, text: t('postDetail.cover.chip.igFile') });
      else chips.push({ p, ok: true, text: t('postDetail.cover.chip.igFrame') });
    } else if (p === 'youtube') chips.push({ p, ok: true, text: t('postDetail.cover.chip.yt') });
    else if (p === 'linkedin') chips.push({ p, ok: true, text: t('postDetail.cover.chip.li') });
    else if (p === 'x') chips.push({ p, ok: false, text: t('postDetail.cover.chip.x') });
  }
  return chips;
}

export default function PostDetail({ post, posts = [], onClose, onEdit, onNavigate, onOpenPost }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { data: accounts } = useAccounts();
  // B2: read-only publish-readiness probes for the open post. enabled-gated and
  // keyed per campaign+postId; they surface advisory blocker rows below the
  // Platforms list. Never write, never auto-retry, never poke a lane.
  const { data: platformValidate } = usePlatformValidate(post?.campaign, post?.id, Boolean(post));
  const { data: validateMedia } = useValidateMedia(post?.campaign, post?.id, Boolean(post));
  const confirm = useConfirm();
  const prompt = usePrompt();
  const { activeClient } = useActiveClient();
  // B4: append a client-naming line to an irreversible/native-mutation confirm so
  // the owner always knows whose post/platform they are about to act on. Returns
  // the body unchanged when no client is active (never implies a wrong client).
  const withClientLine = (body) =>
    activeClient?.displayName ? `${body}\n\n${t('confirm.forClient', { client: activeClient.displayName })}` : body;
  const videoRef = useRef(null);
  const fileInputRef = useRef(null);
  const [error, setError] = useState(null);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  // ISO string for the house DateTimePicker (finding #41); null = nothing picked.
  const [rescheduleValue, setRescheduleValue] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  // Mirror the video playhead (rounded to the 0.1s the backend stores) so the
  // cover-frame button can show a live "X.Xs als Titelbild" counter. Listeners
  // attach to the shared videoRef so PostPreview stays generic.
  const [coverSec, setCoverSec] = useState(0);
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return; // null on text posts / before the video mounts
    const sync = () => {
      const next = Math.round((v.currentTime || 0) * 10) / 10;
      setCoverSec((prev) => (prev === next ? prev : next));
    };
    sync(); // seed initial value (handles the 0.1s nudge)
    v.addEventListener('timeupdate', sync);
    v.addEventListener('seeked', sync);
    v.addEventListener('loadedmetadata', sync);
    return () => {
      v.removeEventListener('timeupdate', sync);
      v.removeEventListener('seeked', sync);
      v.removeEventListener('loadedmetadata', sync);
    };
  }, [post?.id, post?.media?.url]);

  if (!post) return null;

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['plans'] });

  // X reply-chain context (xReplyTo): the sibling post this one threads under,
  // and any posts that thread under THIS one. Same-campaign only - the engine
  // resolves the reference within one plan and fail-closes when the parent is
  // gone (scripts/x-social.mjs), so a dangling reference means "held forever".
  const threadParent = post.xReplyTo
    ? posts.find((p) => p.campaign === post.campaign && p.id === post.xReplyTo) || null
    : null;
  const threadReplies = posts.filter((p) => p.campaign === post.campaign && p.xReplyTo === post.id);

  // Meta lane pause notice (finding #2): the owner-controlled kill switch
  // (accounts.meta.paused) stops every Meta write, so a FB/IG post will not
  // publish until the lane is resumed.
  const metaPaused = Boolean(accounts?.meta?.paused);
  const metaPauseReason = accounts?.meta?.pauseReason || null;
  const targetsMeta = (post.platforms || []).some((p) => p === 'facebook' || p === 'instagram');
  const showMetaPaused = targetsMeta && metaPaused;

  // needs_confirm (native platform mutation) escalates to an in-app confirm and
  // retries with confirm: true. Declining throws the user-cancel sentinel so the
  // ActionButton snaps back to idle without an error flash. Each onAction below
  // owns its own loading/success/error state via its ActionButton.
  const withConfirm = async (fn) => {
    setError(null);
    try {
      await fn(false);
    } catch (err) {
      if (err?.code === 'needs_confirm') {
        const ok = await confirm({ title: t('postDetail.confirm.title'), body: withClientLine(err.message), confirmLabel: t('postDetail.confirm.continue'), danger: true });
        if (!ok) throw { canceled: true };
        await fn(true);
      } else {
        throw err;
      }
    }
    refresh();
  };

  const onApprove = async () => {
    setError(null);
    await approvePost(post.campaign, post.id);
    refresh();
  };
  const onReject = async () => {
    setError(null);
    const note = await prompt({
      title: t('postDetail.reject.title'),
      body: t('postDetail.reject.body'),
      placeholder: t('postDetail.reject.placeholder'),
      multiline: true,
    });
    if (note === null) throw { canceled: true };
    await rejectPost(post.campaign, post.id, note.trim() || undefined);
    refresh();
  };
  const onDelete = async () => {
    setError(null);
    // Thread guard: deleting a post other posts reply to (xReplyTo) strands
    // them - the X lane holds a child forever once its parent is gone.
    const deleteBody = threadReplies.length
      ? `${t('postDetail.delete.body', { id: post.id })}\n\n${t('postDetail.delete.threadWarn', { count: threadReplies.length, ids: threadReplies.map((r) => r.id).join(', ') })}`
      : t('postDetail.delete.body', { id: post.id });
    const ok = await confirm({
      title: t('postDetail.delete.title'),
      body: withClientLine(deleteBody),
      confirmLabel: t('postDetail.delete.confirmLabel'),
      danger: true,
    });
    if (!ok) throw { canceled: true };
    try {
      await deletePost(post.campaign, post.id);
    } catch (err) {
      if (err?.code === 'invalid_input' && /publish evidence/.test(err.message)) {
        const force = await confirm({
          title: t('postDetail.confirm.title'),
          body: withClientLine(t('postDetail.delete.forceBody', { message: err.message })),
          confirmLabel: t('postDetail.delete.forceLabel'),
          danger: true,
        });
        if (!force) throw { canceled: true };
        await deletePost(post.campaign, post.id, true);
      } else {
        throw err;
      }
    }
    refresh();
    onClose();
  };
  const onPark = () => withConfirm((confirm2) => unschedulePost(post.campaign, post.id, confirm2));
  // One dialog (not two): the link prompt IS the confirmation - its body explains
  // the post leaves the queue and nothing is published. null = cancel (snaps the
  // button back to idle), empty string = mark with no link.
  const onMarkPosted = async () => {
    setError(null);
    const url = await prompt({
      title: t('postDetail.markPosted.title'),
      body: t('postDetail.markPosted.body', { id: post.id }),
      placeholder: t('postDetail.markPosted.placeholder'),
    });
    if (url === null) throw { canceled: true };
    await markPosted(post.campaign, post.id, url.trim() || undefined);
    refresh();
  };
  // Read the post back from its platforms to confirm it is actually live
  // (read-only; writes a non-destructive verify block, never publishes).
  const onVerify = async () => {
    setError(null);
    await verifyPost(post.campaign, post.id);
    refresh();
  };
  // Force-publish an overdue, approved post NOW instead of waiting for the next
  // scheduler sweep. Reuses the per-post publish-due path (confirm:true = a REAL
  // publish), so the same lint/cadence/Meta-block guards apply. Surfaces a real
  // per-lane failure instead of flashing a false success.
  const onPublishNow = async () => {
    setError(null);
    const ok = await confirm({
      title: t('postDetail.publishNow.title'),
      body: withClientLine(t('postDetail.publishNow.body', { id: post.id })),
      confirmLabel: t('postDetail.publishNow.confirmLabel'),
      danger: true,
    });
    if (!ok) throw { canceled: true };
    const res = await runPublishDue({ campaign: post.campaign, postId: post.id });
    refresh();
    const mine = (res?.ran || []).filter((r) => r.postId === post.id);
    const failed = mine.find((r) => !r.ok);
    if (failed || !mine.length) {
      setError(failed ? t('postDetail.publishNow.laneFailed', { lane: failed.lane }) : t('postDetail.publishNow.nothingRan'));
      throw { canceled: true };
    }
  };
  // The reschedule control is a plain (non-ActionButton) inline form; it owns its
  // own error handling.
  const onReschedule = async () => {
    const d = new Date(rescheduleValue);
    if (Number.isNaN(d.getTime())) {
      setError(t('postDetail.reschedule.invalidDate'));
      return;
    }
    // Guard against past dates (finding #40): on a natively-scheduled YT/FB post
    // a past reschedule deletes the platform object then marks the post overdue.
    if (d.getTime() <= Date.now()) {
      setError(t('postDetail.reschedule.pastDate'));
      return;
    }
    try {
      await withConfirm((confirm2) => reschedulePost(post.campaign, post.id, d.toISOString(), confirm2));
      setRescheduleOpen(false);
    } catch (err) {
      if (err?.canceled !== true) setError(err?.message || t('postDetail.reschedule.error'));
    }
  };

  const onCoverFrame = async () => {
    const sec = videoRef.current?.currentTime;
    if (typeof sec !== 'number') throw { canceled: true };
    setError(null);
    await setCoverFrame(post.campaign, post.id, Math.round(sec * 10) / 10);
    refresh();
  };
  // Driven by the drop-zone + hidden file input (not an ActionButton), so it
  // owns its own error handling rather than throwing into a button machine.
  const onCoverFile = async (file) => {
    if (!file || !/^image\//.test(file.type)) {
      setError(t('postDetail.coverError.notImage'));
      return;
    }
    setError(null);
    try {
      await uploadCover(post.campaign, post.id, file);
    } catch (err) {
      setError(err?.message || t('postDetail.error.generic'));
    } finally {
      refresh();
    }
  };
  const onCoverClear = async () => {
    setError(null);
    try {
      await clearCover(post.campaign, post.id);
    } catch (err) {
      setError(err?.message || t('postDetail.error.generic'));
    } finally {
      refresh();
    }
  };

  const canApprove = post.approval !== 'approved' && post.derivedState !== 'posted';
  const canReject = post.approval !== 'rejected' && post.derivedState !== 'posted';
  const editable = post.derivedState !== 'posted';
  // Verify is meaningful once a post is handed off and past due (fired-assumed),
  // or anytime it already carries a verify block (so it can be re-checked).
  const canVerify = post.derivedState === 'fired-assumed' || Boolean(post.verify);
  // Force-publish is offered only for an approved post that has slipped past its
  // scheduled time. A healthy scheduler publishes it within a minute; this is the
  // manual "do it now" lever for the owner.
  const canPublishNow = post.derivedState === 'overdue' && post.approval === 'approved';
  // Screen-reader summary of the read-back (finding: verify outcome was never
  // announced). The visible per-platform rows below carry the detail; this single
  // polite line lets a SR user who just ran Verify learn the live/total result
  // without hunting. Derived from the persisted verify block.
  const verifyChecked = post.verify ? Object.keys(post.verify.platforms || {}) : [];
  const verifyLive = verifyChecked.filter((p) => post.verify.platforms[p]?.live).length;

  return (
    <SlideOver onClose={onClose} label={t('postDetail.slideOverLabel', { id: post.id })}>
      {/* Per-client signage (B4): the detail overlay covers the sidebar switcher,
          so the band names the active client at the top of this header. Read-only. */}
      <div className="mb-2">
        <ClientBand client={activeClient} />
      </div>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-2xl font-bold leading-tight">
            {post.title?.trim() || post.caption?.split('\n')[0] || t('approvals.card.untitled')}
          </h2>
          <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">
            {t('approvals.card.scheduledFor', { when: post.scheduledAt ? fmtFull(post.scheduledAt) : t('approvals.card.noSchedule') })}
          </p>
          <p className="mt-1 text-[11px] text-zinc-400 dark:text-zinc-500">
            {t('approvals.card.campaignMeta', { campaign: campaignBaseLabel(post.campaign), id: post.id, type: t(`type.${post.type}`) })}
          </p>
          {/* X thread line (xReplyTo): link to the parent post, or an explicit
              missing note - a dangling reference never publishes on X. */}
          {post.xReplyTo ? (
            <p className="mt-1 flex items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-400">
              <CornerUpLeft size={11} className="shrink-0" aria-hidden="true" />
              {threadParent ? (
                <button
                  type="button"
                  onClick={() => onOpenPost?.(threadParent)}
                  className="rounded text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light"
                >
                  {t('postDetail.thread.repliesTo', { id: post.xReplyTo })}
                </button>
              ) : (
                <span className="text-amber-600 dark:text-amber-300">{t('postDetail.thread.parentMissing', { id: post.xReplyTo })}</span>
              )}
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <StatusPill state={post.derivedState} />
            <ApprovalPill approval={post.approval} />
            {/* Advisory brand-lint badge (read-only): mirrors the per-platform
                publish gate. Silent unless a target platform would trip an error;
                never alters approve/reject enablement. */}
            <BrandLintBadge caption={post.caption} platforms={post.platforms} />
            {post.publishedVia === 'manual' && post.externalUrl ? (
              <a href={post.externalUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 rounded text-[11px] text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light">
                <ExternalLink size={11} aria-hidden="true" /> {t('postDetail.viewLink')}
              </a>
            ) : null}
          </div>
          {post.publishedVia === 'manual' ? (
            <p className="mt-1 text-[11px] text-zinc-500 dark:text-zinc-400">{t('postDetail.postedExternally')}</p>
          ) : null}
        </div>
        <CloseButton onClose={onClose} label={t('postDetail.close')} />
      </header>

      {/* Meta lane paused notice (finding #2): a FB/IG post will not publish
          while the owner-controlled Meta kill switch is active. */}
      {showMetaPaused ? (
        <p className="flex items-start gap-2 rounded-xl bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          <PauseCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            {t('postDetail.metaPaused.notice')}
            {metaPauseReason ? <span className="mt-0.5 block opacity-80">{metaPauseReason}</span> : null}
          </span>
        </p>
      ) : null}

      {/* Approval + lifecycle actions. Each ActionButton owns its own
          idle->loading->success state machine (no global disable-all). */}
      <div className="flex flex-wrap items-center gap-1.5">
        {canApprove ? (
          <ActionButton
            variant="success"
            icon={CheckCircle2}
            labels={{ idle: t('approvals.action.approve'), loading: t('approvals.action.approving'), success: t('approvals.action.approved'), error: t('approvals.action.error') }}
            onAction={onApprove}
            onError={setError}
          />
        ) : null}
        {canReject ? (
          <ActionButton
            variant="danger"
            icon={XCircle}
            labels={{ idle: t('approvals.action.reject'), loading: t('approvals.action.rejecting'), success: t('approvals.action.rejected'), error: t('approvals.action.error') }}
            onAction={onReject}
            onError={setError}
          />
        ) : null}
        {editable ? (
          <Tip label={t('postDetail.action.editAria')}>
            <button type="button" onClick={() => onEdit(post)} aria-label={t('postDetail.action.editAria')} className={`${ACTION_BTN} bg-zinc-200/60 hover:bg-zinc-300/60 dark:bg-zinc-800/60 dark:hover:bg-zinc-700/60`}>
              <Pencil size={13} aria-hidden="true" />
              {t('postDetail.action.editIdle')}
            </button>
          </Tip>
        ) : null}
        {editable ? (
          <Tip label={t('postDetail.action.rescheduleAria')}>
            <button
              type="button"
              aria-label={t('postDetail.action.rescheduleAria')}
              aria-expanded={rescheduleOpen}
              aria-controls="detail-reschedule-panel"
              onClick={() => {
                setRescheduleOpen((v) => !v);
                setRescheduleValue(null);
              }}
              className={`${ACTION_BTN} bg-zinc-200/60 hover:bg-zinc-300/60 dark:bg-zinc-800/60 dark:hover:bg-zinc-700/60`}
            >
              <CalendarClock size={13} aria-hidden="true" />
              {t('postDetail.action.rescheduleIdle')}
            </button>
          </Tip>
        ) : null}
        {editable && post.executionMode === 'fully-scheduled' ? (
          <Tip label={t('postDetail.action.parkTip')}>
            <ActionButton
              icon={PauseCircle}
              ariaLabel={t('postDetail.action.parkTip')}
              labels={{ idle: t('postDetail.action.parkIdle'), loading: t('postDetail.action.parkLoading'), success: t('postDetail.action.parkSuccess'), error: t('postDetail.error.generic') }}
              onAction={onPark}
              onError={setError}
            />
          </Tip>
        ) : null}
        {canPublishNow ? (
          <Tip label={t('postDetail.action.publishNowTip')}>
            <ActionButton
              variant="success"
              icon={Send}
              ariaLabel={t('postDetail.action.publishNowTip')}
              labels={{ idle: t('postDetail.action.publishNowIdle'), loading: t('postDetail.action.publishNowLoading'), success: t('postDetail.action.publishNowSuccess'), error: t('postDetail.error.generic') }}
              onAction={onPublishNow}
              onError={setError}
            />
          </Tip>
        ) : null}
        {post.derivedState !== 'posted' ? (
          <Tip label={t('postDetail.action.markTip')}>
            <ActionButton
              icon={CheckCheck}
              labels={{ idle: t('postDetail.action.markIdle'), loading: t('postDetail.action.markLoading'), success: t('postDetail.action.markSuccess'), error: t('postDetail.error.generic') }}
              onAction={onMarkPosted}
              onError={setError}
            />
          </Tip>
        ) : null}
        {canVerify ? (
          <Tip label={t('postDetail.action.verifyTip')}>
            <ActionButton
              icon={ShieldCheck}
              labels={{ idle: t('postDetail.action.verifyIdle'), loading: t('postDetail.action.verifyLoading'), success: t('postDetail.action.verifySuccess'), error: t('postDetail.error.generic') }}
              onAction={onVerify}
              onError={setError}
            />
          </Tip>
        ) : null}
        <Tip label={t('postDetail.action.deleteTip')}>
          <ActionButton
            variant="danger"
            className="ml-auto"
            icon={Trash2}
            ariaLabel={t('postDetail.action.deleteAria')}
            labels={{ idle: '', loading: t('postDetail.action.deleteLoading'), success: t('postDetail.action.deleteSuccess'), error: t('postDetail.error.generic') }}
            onAction={onDelete}
            onError={setError}
          />
        </Tip>
      </div>

      {rescheduleOpen ? (
        <div id="detail-reschedule-panel" role="group" aria-label={t('postDetail.reschedule.panelLabel')} className={`flex items-center gap-2 rounded-xl p-2.5 ${INNER_SURFACE}`}>
          <div className="flex-1">
            <DateTimePicker value={rescheduleValue} onChange={setRescheduleValue} placeholder={t('postDetail.reschedule.placeholder')} disablePast />
          </div>
          <button type="button" onClick={onReschedule} disabled={!rescheduleValue} className={`${ACTION_BTN} bg-brand text-white dark:bg-brand-light dark:text-zinc-900`}>
            {t('postDetail.reschedule.submit')}
          </button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="rounded-xl bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-300">{error}</p>
      ) : null}

      <PostPreview post={post} videoRef={videoRef} />

      {/* Cover override: frame scrubber + drop zone, honest platform chips */}
      {post.media.url && editable ? (
        <Section title={t('postDetail.section.cover')}>
          <div
            className={`space-y-2 rounded-xl p-2.5 ${INNER_SURFACE} ${dragOver ? 'ring-2 ring-brand' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              onCoverFile(e.dataTransfer.files?.[0]);
            }}
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <Tip label={t('postDetail.cover.frameTip')}>
                <ActionButton
                  icon={Camera}
                  ariaLabel={t('postDetail.cover.frameTip')}
                  labels={{ idle: t('postDetail.cover.frameIdle', { seconds: coverSec.toFixed(1) }), loading: t('postDetail.cover.frameLoading'), success: t('postDetail.cover.frameSuccess'), error: t('postDetail.error.generic') }}
                  onAction={onCoverFrame}
                  onError={setError}
                />
              </Tip>
              <Tip label={t('postDetail.cover.uploadTip')}>
                <button type="button" onClick={() => fileInputRef.current?.click()} aria-label={t('postDetail.cover.uploadAria')} className={`${ACTION_BTN} bg-zinc-200/60 hover:bg-zinc-300/60 dark:bg-zinc-800/60 dark:hover:bg-zinc-700/60`}>
                  <ImagePlus size={13} aria-hidden="true" />
                  {t('postDetail.cover.uploadIdle')}
                </button>
              </Tip>
              {post.cover ? (
                <Tip label={t('postDetail.cover.removeTip')}>
                  <button type="button" onClick={onCoverClear} aria-label={t('postDetail.cover.removeAria')} className={`${ACTION_BTN} text-zinc-500 hover:bg-zinc-200/60 dark:text-zinc-400 dark:hover:bg-zinc-700/60`}>
                    <ImageOff size={13} aria-hidden="true" />
                    {t('postDetail.cover.removeIdle')}
                  </button>
                </Tip>
              ) : null}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                aria-label={t('postDetail.cover.fileInputAria')}
                className="hidden"
                onChange={(e) => {
                  onCoverFile(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </div>
            <p className="text-[10px] text-zinc-500 dark:text-zinc-400">
              {t('postDetail.cover.hint')}
            </p>
            <div className="flex flex-wrap gap-1">
              {coverChips(post, t).map(({ p, ok, text }) => (
                <IconBadge key={p} tone={ok ? 'ok' : 'neutral'} text={PLATFORM_META[p]?.label || p} label={text} />
              ))}
            </div>
            {post.cover ? (
              <p className="flex items-center gap-1.5 text-[10px] text-zinc-500 dark:text-zinc-400">
                {post.cover.source === 'frame' ? t('postDetail.cover.activeFrame', { seconds: (post.cover.offsetMs / 1000).toFixed(1) }) : t('postDetail.cover.activeImage')}
                {post.cover.exists === false ? (
                  <IconBadge icon={FileX2} tone="warn" label={t('postDetail.cover.missing')} />
                ) : null}
              </p>
            ) : null}
          </div>
        </Section>
      ) : null}

      <Section title={t('postDetail.section.platforms')}>
        <ul className="space-y-1.5">
          {post.platforms.map((p) => {
            const meta = PLATFORM_META[p];
            const state = platformState(post, p, t);
            if (!meta) return null;
            const { Icon } = meta;
            const verify = platformVerify(post, p, t);
            const stateCls = state.tier === 'done'
              ? 'text-emerald-600 dark:text-emerald-300'
              : state.tier === 'warn'
                ? 'text-amber-600 dark:text-amber-300'
                : 'text-zinc-500 dark:text-zinc-400';
            const verifyCls = verify?.tone === 'ok'
              ? 'text-emerald-600 dark:text-emerald-300'
              : verify?.tone === 'err'
                ? 'text-red-600 dark:text-red-300'
                : 'text-amber-600 dark:text-amber-300';
            // Icon + sr-only word per outcome so a failure never carries the
            // reassuring check-shield and color is never the only signal.
            const VerifyIcon = verify?.tone === 'ok' ? ShieldCheck : verify?.tone === 'err' ? ShieldX : ShieldAlert;
            const verifySr = verify?.tone === 'ok'
              ? t('postDetail.verify.toneOk')
              : verify?.tone === 'err'
                ? t('postDetail.verify.toneErr')
                : t('postDetail.verify.toneWarn');
            return (
              <li key={p} className={`rounded-xl px-3 py-2 ${INNER_SURFACE}`}>
                <div className="flex items-center gap-2.5">
                  <Icon size={15} className={meta.color} aria-hidden="true" />
                  <span className="flex-1 text-sm font-bold">{meta.label}</span>
                  <span className={`flex items-center gap-1 text-[11px] ${stateCls}`}>
                    {state.tier === 'done' ? <CheckCircle2 size={11} aria-hidden="true" /> : null}
                    {state.tier === 'done' ? <span className="sr-only">{t('postDetail.platform.publishedSr')}: </span> : null}
                    {state.tier === 'warn' ? <span className="sr-only">{t('postDetail.platform.warnSr')}: </span> : null}
                    {state.text}
                  </span>
                  {state.tier === 'warn' && state.warn ? (
                    <IconBadge icon={CalendarClock} tone="warn" label={state.warn} />
                  ) : null}
                </div>
                {state.tier === 'pending' ? (
                  <div className="mt-1 flex items-center gap-1.5 pl-[25px] text-[11px] text-zinc-500 dark:text-zinc-400">
                    {deliveryMode(p) === 'native'
                      ? <CalendarClock size={11} aria-hidden="true" />
                      : <Power size={11} aria-hidden="true" />}
                    {t(`postDetail.delivery.${deliveryMode(p)}`)}
                  </div>
                ) : null}
                {verify ? (
                  <div className="mt-1 flex items-center gap-2 pl-[25px] text-[11px]">
                    <span className={`flex items-center gap-1 ${verifyCls}`}>
                      <VerifyIcon size={11} aria-hidden="true" />
                      <span className="sr-only">{verifySr}: </span>
                      {verify.label}
                    </span>
                    {verify.permalink ? (
                      <a href={verify.permalink} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light">
                        <ExternalLink size={11} aria-hidden="true" /> {t('postDetail.verify.viewLink')}
                      </a>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
        {post.verify?.at ? (
          <p className="mt-1 text-[10px] text-zinc-500 dark:text-zinc-400">{t('postDetail.verify.lastChecked', { when: fmtFull(post.verify.at) })}</p>
        ) : null}
        {/* Verify result announced to screen readers (the visible rows above hold
            the per-platform detail). Container is always present so a result that
            lands after the user runs Verify is read out via the polite region. */}
        <p role="status" aria-live="polite" className="sr-only">
          {post.verify ? t('postDetail.verify.announce', { live: verifyLive, total: verifyChecked.length }) : ''}
        </p>
        {/* B2: read-only publish-readiness blockers. Quiet advisory rows distinct
            from the state/verify rows above; clean post => nothing renders. */}
        <PlatformBlockers platformValidate={platformValidate} validateMedia={validateMedia} approval={post.approval} onNavigate={onNavigate} className="mt-1.5" />
      </Section>

      <Section title={t('postDetail.section.caption')}>
        <p className={`whitespace-pre-wrap rounded-xl p-3 text-sm leading-relaxed ${INNER_SURFACE}`}>
          {post.caption || t('postDetail.caption.empty')}
        </p>
      </Section>

      {post.firstComment ? (
        <Section title={t('postDetail.section.firstComment')}>
          <p className={`whitespace-pre-wrap rounded-xl p-3 text-sm ${INNER_SURFACE}`}>{post.firstComment}</p>
        </Section>
      ) : null}

      {post.approvalNote ? (
        <Section title={t('postDetail.section.approvalNote')}>
          <p className={`whitespace-pre-wrap rounded-xl p-3 text-sm ${INNER_SURFACE}`}>{post.approvalNote}</p>
        </Section>
      ) : null}

      {post.media.file ? (
        <Section title={t('postDetail.section.file')}>
          <div className={`flex flex-wrap items-center gap-2 rounded-xl px-3 py-2 text-xs ${INNER_SURFACE}`}>
            <span className="break-all font-bold">{post.media.file}</span>
            {post.media.bytes ? <span className="text-zinc-500 dark:text-zinc-400">{fmtBytes(post.media.bytes)}</span> : null}
            <IconBadge
              icon={post.media.exists ? FileVideo : FileX2}
              tone={post.media.exists ? 'ok' : 'warn'}
              label={post.media.exists ? t('postDetail.file.present') : t('postDetail.file.missing')}
            />
          </div>
        </Section>
      ) : null}
    </SlideOver>
  );
}
