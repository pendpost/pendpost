import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, XCircle, Pencil, Trash2, ImagePlus, ImageOff, Camera, CalendarClock, PauseCircle, CheckCheck, Send, ExternalLink, FileVideo, FileX2, ShieldCheck, ShieldAlert, ShieldX, Power, CornerUpLeft, MoreHorizontal, ChevronLeft, ChevronRight, Cloud as CloudIcon, FileText } from 'lucide-react';
import { fmtFull, fmtTime, fmtRelative, fmtBytes, campaignBaseLabel, effectiveDelivery, fieldsForPost, deriveThread } from '../lib/format.js';
import {
  useAccounts, usePlatformValidate, useValidateMedia, useActiveClient,
  approvePost, rejectPost, deletePost, unschedulePost, reschedulePost, markPosted, verifyPost,
  runPublishDue, setCoverFrame, uploadCover, clearCover, updatePost,
} from '../lib/api.js';
import { useCloudDelivery } from '../lib/cloud.js';
import { StatusPill, ApprovalPill, PlatformIcons, PLATFORM_META, INNER_SURFACE, Modal, CloseButton, PostPreview, PlatformBlockers, EYEBROW } from './ui.jsx';
import { Popover, PopoverTrigger, PopoverContent, PopoverClose } from './ui/Popover.jsx';
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

// ONE editable content field in the detail dialog, driven by the shared
// field-relevance model. `label` names it; the optional platform-icon row shows
// which targeted networks the field feeds (only where it diverges from "all of
// them"), and the optional hint carries the override note (X/Mastodon/Nostr).
// Read-only (a posted post) collapses to a plain paragraph. Long content wraps
// (break-words) so a URL-heavy field never forces the dialog to scroll sideways.
function ContentField({ label, platforms, showIcons, hint, kind, mono, value, onChange, editable, placeholder }) {
  const rows = kind === 'textarea'
    ? Math.min(mono ? 18 : 14, Math.max(3, String(value || '').split('\n').length + 1))
    : undefined;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={EYEBROW}>{label}</span>
        {showIcons && platforms.length ? <PlatformIcons platforms={platforms} size={12} /> : null}
        {hint ? <span className="text-[10px] font-medium text-zinc-400 dark:text-zinc-500">{hint}</span> : null}
      </div>
      {editable ? (
        kind === 'textarea' ? (
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            aria-label={label}
            placeholder={placeholder}
            rows={rows}
            className={`w-full resize-y break-words rounded-xl p-3 text-sm leading-relaxed scrollbar-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${mono ? 'font-mono ' : ''}${INNER_SURFACE}`}
          />
        ) : (
          <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            aria-label={label}
            placeholder={placeholder}
            className={`w-full rounded-xl px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${INNER_SURFACE}`}
          />
        )
      ) : (
        <p className={`whitespace-pre-wrap break-words rounded-xl p-3 text-sm leading-relaxed ${INNER_SURFACE} ${value ? '' : 'text-zinc-400 dark:text-zinc-500'}`}>
          {value || placeholder}
        </p>
      )}
    </div>
  );
}

// A one-line human summary of the GBP local-post intent for the read-only Details
// row (topic + optional CTA), reusing the Composer's gbp label keys.
function gbpSummary(gbp, t) {
  if (!gbp) return '';
  const parts = [t(`composer.gbp.topic.${gbp.topic || 'standard'}`)];
  const ctaKey = { BOOK: 'book', ORDER: 'order', SHOP: 'shop', LEARN_MORE: 'learnMore', SIGN_UP: 'signUp', CALL: 'call' }[gbp.ctaType];
  if (ctaKey) parts.push(t(`composer.gbp.cta.${ctaKey}`));
  return parts.join(' · ');
}

// The read-only "Details" block: relevant-but-not-primary fields (supporting URLs,
// the newsletter flag, and the structured GBP / story-sticker / hashtag intent),
// each shown ONLY when it carries content - so an operator sees the full picture of
// what will publish without the field ever standing empty. Deep edits happen in the
// Composer (the Edit button); this is review signage, not a second author form.
function PostExtras({ post, extras, t }) {
  const rows = [];
  for (const { key } of extras) {
    if (key === 'link' && post.link) rows.push({ key, label: t('postDetail.field.link'), value: post.link, url: true });
    else if (key === 'image' && post.image) rows.push({ key, label: t('postDetail.field.image'), value: post.image, url: true });
    else if (key === 'canonicalUrl' && post.canonicalUrl) rows.push({ key, label: t('postDetail.field.canonicalUrl'), value: post.canonicalUrl, url: true });
    else if (key === 'blogSlug' && post.blogSlug) rows.push({ key, label: t('postDetail.field.blogSlug'), value: post.blogSlug });
    else if (key === 'hashtags' && Array.isArray(post.hashtags) && post.hashtags.length) rows.push({ key, label: t('postDetail.field.hashtags'), value: post.hashtags.join(' ') });
    else if (key === 'gbp' && post.gbp) rows.push({ key, label: t('postDetail.field.gbp'), value: gbpSummary(post.gbp, t) });
    else if (key === 'interactiveStory' && post.interactiveStory?.stickers?.length) rows.push({ key, label: t('postDetail.field.interactiveStory'), value: t('postDetail.field.stickerCount', { count: post.interactiveStory.stickers.length }) });
    else if (key === 'ghostEmail' && post.ghostEmail === true) rows.push({ key, label: t('postDetail.field.ghostEmail'), check: true });
  }
  if (!rows.length) return null;
  return (
    <Section title={t('postDetail.section.details')}>
      <dl className="space-y-1.5">
        {rows.map((r) => (
          <div key={r.key} className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded-xl px-3 py-2 ${INNER_SURFACE}`}>
            <dt className="text-[11px] font-bold text-zinc-500 dark:text-zinc-400">{r.label}</dt>
            <dd className="min-w-0 flex-1 text-xs text-zinc-600 dark:text-zinc-300">
              {r.check ? (
                <CheckCircle2 size={13} className="text-emerald-600 dark:text-emerald-300" aria-hidden="true" />
              ) : (
                <span className="break-all">{r.value}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

// The right-column placeholder for a pure-text post (no link, no image): a calm,
// theme-aware tile at the card's 1.91:1 ratio so every post keeps the same
// two-column shape, instead of leaving the text stranded in one column.
function TextPostTile({ label }) {
  return (
    <div className="flex aspect-[1.91/1] w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-300 bg-zinc-100 text-zinc-400 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-500">
      <FileText size={20} aria-hidden="true" />
      <span className="text-[11px] font-bold">{label}</span>
    </div>
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

export default function PostDetail({ post, posts = [], triage = null, triageIndex = -1, onClose, onEdit, onNavigate, onOpenPost }) {
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
  // Cloud-aware delivery: whether the always-on runtime fires this brand and which
  // lanes it covers, so the one delivery statement below tells the truth (and stays
  // silent until `resolved` rather than flashing a wrong "needs your Mac").
  const { cloudOn, cloudLanes, resolved: cloudResolved } = useCloudDelivery();
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
  // Platform-aware content model (lib/format.js): the ordered editable text fields
  // this post's platforms actually use + the read-only extras. The SAME model the
  // Composer gates its fields on, so authoring and review never drift.
  const { fields: contentFields, extras: contentExtras } = useMemo(() => fieldsForPost(post || {}), [post]);
  // Inline editing across EVERY relevant field (not just the caption): one draft
  // per field, re-seeded whenever the post identity or rev changes (triage nav, or
  // our own save bumping rev), so the dirty check is honest and Save only lights up
  // once a field actually differs. Keyed by field key, so a YouTube post edits its
  // title/description and an X post its tweet text - each the platform's primary.
  // Seeded from the post on mount (no first-render flash), then re-seeded whenever
  // the post identity or rev changes.
  const [drafts, setDrafts] = useState(() => {
    const seed = {};
    for (const f of contentFields) seed[f.key] = post?.[f.key] || '';
    return seed;
  });
  useEffect(() => {
    const seed = {};
    for (const f of contentFields) seed[f.key] = post?.[f.key] || '';
    setDrafts(seed);
    // Re-seed on identity/rev change only (rev bumps on every server write); the
    // field list is derived from the same post, so it is intentionally not a dep.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [post?.campaign, post?.id, post?.rev]);
  // Keyboard triage reads the live action bundle from a ref so the single global
  // listener never goes stale and is not re-bound on every post change.
  const kbRef = useRef(null);
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

  // Keyboard triage (A=approve, R=reject, ←/→=prev/next). Esc stays owned by the
  // Modal's useSlideOver. Ignored while typing (reschedule picker, reject prompt,
  // any input) or while a Radix menu/picker owns the keys ([data-state="open"]).
  useEffect(() => {
    const onKey = (e) => {
      const b = kbRef.current;
      if (!b) return;
      const el = document.activeElement;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
      if (document.querySelector('[data-state="open"]')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowLeft') { if (b.prevPost) { e.preventDefault(); b.goPrev(); } }
      else if (e.key === 'ArrowRight') { if (b.nextPost) { e.preventDefault(); b.goNext(); } }
      else if (e.key === 'a' || e.key === 'A') { if (b.canApprove) { e.preventDefault(); b.act(b.onApprove); } }
      else if (e.key === 'r' || e.key === 'R') { if (b.canReject) { e.preventDefault(); b.act(b.onReject); } }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  if (!post) return null;

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['plans'] });

  // Inline save across every dirty content field: reuses the same rev-guarded
  // updatePost the Composer uses (a stale edit is refused, never silently
  // clobbered) and sends only the changed fields in one PATCH. On success the
  // plans refetch bumps rev, re-syncing the drafts and clearing dirty (hiding
  // Save). caption sends its raw string (empty is valid); every other field
  // mirrors the Composer's `value || null` clear-semantics.
  const setDraft = (key, val) => setDrafts((d) => ({ ...d, [key]: val }));
  const dirtyFields = contentFields.filter((f) => (drafts[f.key] ?? '') !== (post[f.key] || ''));
  const anyDirty = dirtyFields.length > 0;
  const saveFields = async () => {
    const patch = {};
    for (const f of dirtyFields) {
      const v = drafts[f.key] ?? '';
      patch[f.key] = f.key === 'caption' ? v : (v || null);
    }
    try {
      await updatePost(post.campaign, post.id, post.rev, patch);
    } catch (err) {
      throw new Error(err?.code === 'stale_write' ? t('composer.error.staleWrite') : (err?.message || t('postDetail.error.generic')));
    }
    await queryClient.invalidateQueries({ queryKey: ['plans'] });
  };

  // X reply-chain context (xReplyTo): the sibling post this one threads under,
  // and any posts that thread under THIS one. Same-campaign only - the engine
  // resolves the reference within one plan and fail-closes when the parent is
  // gone (scripts/x-social.mjs), so a dangling reference means "held forever".
  const { parent: threadParent, replies: threadReplies } = deriveThread(post, posts);

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

  // An edited-since-approval post is approval:'approved' but needs a FRESH decision:
  // offer Approve (re-approve) again. Reject stays available so the owner can pull it.
  const canApprove = (post.approval !== 'approved' || post.editedSinceApproval) && post.derivedState !== 'posted';
  const canReject = post.approval !== 'rejected' && post.derivedState !== 'posted';
  const editable = post.derivedState !== 'posted';
  // Verify is meaningful once a post is handed off and past due (fired-assumed),
  // or anytime it already carries a verify block (so it can be re-checked).
  const canVerify = post.derivedState === 'fired-assumed' || Boolean(post.verify);
  // Force-publish is offered only for an approved post that has slipped past its
  // scheduled time. A healthy scheduler publishes it within a minute; this is the
  // manual "do it now" lever for the owner.
  const canPublishNow = post.derivedState === 'overdue' && post.approval === 'approved' && !post.editedSinceApproval;
  // Screen-reader summary of the read-back (finding: verify outcome was never
  // announced). The visible per-platform rows below carry the detail; this single
  // polite line lets a SR user who just ran Verify learn the live/total result
  // without hunting. Derived from the persisted verify block.
  const verifyChecked = post.verify ? Object.keys(post.verify.platforms || {}) : [];
  const verifyLive = verifyChecked.filter((p) => post.verify.platforms[p]?.live).length;

  // Triage: prev/next re-thread the SAME ordered list through the one openPost
  // entry point, so the "n of m" counter stays alive without a dedicated callback.
  const hasTriage = Array.isArray(triage) && triage.length > 1 && triageIndex >= 0;
  const prevPost = hasTriage && triageIndex > 0 ? triage[triageIndex - 1] : null;
  const nextPost = hasTriage && triageIndex < triage.length - 1 ? triage[triageIndex + 1] : null;
  const goPrev = () => prevPost && onOpenPost?.(prevPost, triage);
  const goNext = () => nextPost && onOpenPost?.(nextPost, triage);
  // Shared runner for keyboard + ⋯-menu actions: one in-flight guard so a mashed
  // key can't double-fire, and the reject/delete cancel sentinel stays silent.
  const actingRef = { current: false }; // fresh each render is fine: guards one synchronous burst
  const act = async (fn) => {
    if (actingRef.current) return;
    actingRef.current = true;
    try { await fn(); }
    catch (err) { if (err?.canceled !== true) setError(err?.message || t('postDetail.error.generic')); }
    finally { actingRef.current = false; }
  };

  // One dominant primary CTA per state; everything destructive/less-common lives
  // in the ⋯ overflow. Precedence mirrors the plan's action-hierarchy table.
  const primary =
    canPublishNow ? 'publishNow'
    : canApprove ? 'approve'
    : canVerify ? 'verify'
    : editable ? 'reschedule'
    : null;
  const toggleReschedule = () => { setRescheduleOpen((v) => !v); setRescheduleValue(null); };

  // ⋯ overflow items (data, not markup) - filtered to what's valid for the state.
  const menuItems = [
    canReject && { key: 'reject', icon: XCircle, label: t('approvals.action.reject'), danger: true, run: onReject },
    editable && post.executionMode === 'fully-scheduled' && { key: 'park', icon: PauseCircle, label: t('postDetail.action.parkIdle'), run: onPark },
    post.derivedState !== 'posted' && { key: 'mark', icon: CheckCheck, label: t('postDetail.action.markIdle'), run: onMarkPosted },
    canVerify && primary !== 'verify' && { key: 'verify', icon: ShieldCheck, label: t('postDetail.action.verifyIdle'), run: onVerify },
    { key: 'delete', icon: Trash2, label: t('postDetail.action.deleteMenu'), danger: true, run: onDelete },
  ].filter(Boolean);

  // A text post has a real card to preview when it targets a blog lane (article
  // card) or carries a link/image (LinkedIn card); a pure text post has none.
  const isText = post.type === 'text';
  const textHasCard = isText && (post.platforms?.includes('wordpress') || post.platforms?.includes('ghost') || Boolean(post.link) || Boolean(post.image));

  // ONE post-level delivery statement (replaces the per-platform "needs pendpost"
  // line). Summarize the effective mechanism across the still-pending platforms:
  // 'cloud'/'native' fire without the user, 'local' needs pendpost running. Amber
  // caveat names ONLY the local lanes (the actionable subset); otherwise a calm
  // "publishes automatically". Silent until the cloud answer resolves (no wrong
  // flash) and silent when nothing is pending (every lane already handed off).
  const pendingPlatforms = post.platforms.filter(
    (p) => PLATFORM_META[p] && platformState(post, p, t).tier === 'pending',
  );
  const localPending = pendingPlatforms.filter(
    (p) => effectiveDelivery(p, { cloudOn, cloudLanes }) === 'local',
  );
  const cloudPending = pendingPlatforms.some(
    (p) => effectiveDelivery(p, { cloudOn, cloudLanes }) === 'cloud',
  );
  const deliveryHint = !cloudResolved || pendingPlatforms.length === 0
    ? null
    : localPending.length > 0
      ? { tone: 'local', platforms: localPending }
      : { tone: 'auto', viaCloud: cloudPending };

  // Live action bundle for the keyboard listener (read via ref, never stale).
  kbRef.current = { canApprove, canReject, prevPost, nextPost, onApprove, onReject, goPrev, goNext, act };

  // Per-field platform-icon rule: show icons only where a field diverges from
  // "every targeted platform" (redundant on a single-platform post, or on a field
  // all networks share), so a multi-platform post reads exactly what each network
  // posts without noise. Override fields (x/mastodon/nostr) carry a text hint.
  const targetCount = post.platforms.length;
  const OVERRIDE_KEYS = new Set(['xCaption', 'mastodonCaption', 'nostrCaption']);
  // Editable post: show every relevant field (empty ones are there to fill in).
  // Read-only (posted) post: hide the empty ones - a review of what actually
  // published should not carry blank "Not set" rows for fields left unused.
  const visibleContentFields = editable
    ? contentFields
    : contentFields.filter((f) => String(drafts[f.key] ?? '').trim());

  // The scrollable body content shared by the two-column and single-column layouts.
  const bodyLeft = (
    <>
      {/* Platform-relevant content, primary text first: only the fields a targeted
          platform actually posts appear (YouTube leads with title + description, X
          with its tweet text, meta with the caption) - never an empty "Bildtext" on
          a lane that has none. Each is inline-editable with the shared dirty->Save. */}
      {visibleContentFields.length ? (
        <section className="space-y-4">
          {visibleContentFields.map((f) => {
            const val = drafts[f.key] ?? '';
            const isOverride = OVERRIDE_KEYS.has(f.key);
            return (
              <ContentField
                key={f.key}
                label={t(`postDetail.field.${f.key}`)}
                platforms={f.platforms}
                showIcons={f.platforms.length > 0 && f.platforms.length !== targetCount}
                hint={isOverride ? (val.trim() ? t('postDetail.field.overrideSet') : t('postDetail.field.overrideEmpty')) : null}
                kind={f.kind}
                mono={f.mono}
                value={val}
                onChange={(v) => setDraft(f.key, v)}
                editable={editable}
                placeholder={f.key === 'caption' ? t('postDetail.caption.empty') : t('postDetail.field.empty')}
              />
            );
          })}
        </section>
      ) : null}

      {contentExtras.length ? <PostExtras post={post} extras={contentExtras} t={t} /> : null}

      <Section title={t('postDetail.section.platforms')}>
        {deliveryHint ? (
          <p className={`mb-1.5 flex items-center gap-1.5 text-[11px] ${deliveryHint.tone === 'local' ? 'text-amber-600 dark:text-amber-300' : 'text-zinc-500 dark:text-zinc-400'}`}>
            {deliveryHint.tone === 'local'
              ? <Power size={11} aria-hidden="true" className="shrink-0" />
              : deliveryHint.viaCloud
                ? <CloudIcon size={11} aria-hidden="true" className="shrink-0" />
                : <CalendarClock size={11} aria-hidden="true" className="shrink-0" />}
            {deliveryHint.tone === 'local'
              ? t('postDetail.delivery.needsLocal', { platforms: deliveryHint.platforms.map((p) => PLATFORM_META[p].label).join(', ') })
              : t('postDetail.delivery.autoAll')}
          </p>
        ) : null}
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
        <p role="status" aria-live="polite" className="sr-only">
          {post.verify ? t('postDetail.verify.announce', { live: verifyLive, total: verifyChecked.length }) : ''}
        </p>
        <PlatformBlockers platformValidate={platformValidate} validateMedia={validateMedia} approval={post.approval} editedSinceApproval={post.editedSinceApproval} showApproval={false} onNavigate={onNavigate} className="mt-1.5" />
      </Section>

      {/* Low-frequency detail, shown inline (each row self-labels; no chevron).
          The first comment is now an editable content field above when relevant
          (IG feed); the approval note + media file stay read-only here. */}
      {post.approvalNote ? (
        <div className="space-y-1">
          <p className={EYEBROW}>{t('postDetail.section.approvalNote')}</p>
          <p className={`whitespace-pre-wrap rounded-xl p-3 text-sm ${INNER_SURFACE}`}>{post.approvalNote}</p>
        </div>
      ) : null}
      {post.media.file ? (
        <div className="space-y-1">
          <p className={EYEBROW}>{t('postDetail.section.file')}</p>
          <div className={`flex flex-wrap items-center gap-2 rounded-xl px-3 py-2 text-xs ${INNER_SURFACE}`}>
            <span className="break-all font-bold">{post.media.file}</span>
            {post.media.bytes ? <span className="text-zinc-500 dark:text-zinc-400">{fmtBytes(post.media.bytes)}</span> : null}
            <IconBadge
              icon={post.media.exists ? FileVideo : FileX2}
              tone={post.media.exists ? 'ok' : 'warn'}
              label={post.media.exists ? t('postDetail.file.present') : t('postDetail.file.missing')}
            />
          </div>
        </div>
      ) : null}

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
    </>
  );

  // The media column (two-column) or inline block (single-column): the preview
  // plus, for a media-backed editable post, the cover override editor.
  const mediaBlock = (
    <>
      <PostPreview key={`${post.campaign}-${post.id}`} post={post} videoRef={videoRef} />
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
    </>
  );

  // The right column of the two-column body: the media/card preview for any post
  // that has one, or a calm text tile for a pure-text post - so EVERY post keeps
  // the same two-column shape (no more single-column text with dead space).
  const rightColumn = isText && !textHasCard ? <TextPostTile label={t('postDetail.preview.textOnly')} /> : mediaBlock;

  return (
    <Modal onClose={onClose} label={t('postDetail.dialogLabel', { id: post.id })} width="max-w-4xl">
      {/* Header (never scrolls): ONE dense identity row - client signage + status +
          approval + platform glyphs + schedule + campaign meta, all side by side to
          use the width - then only the rare thread/manual sublines. Triage + close
          sit on the right. */}
      <div>
        <header className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <ClientBand client={activeClient} />
              {/* `short` label ("Geplant", not "Geplant - pendpost"): the cloud-blind
                  delivery suffix is dropped here - the one delivery statement in the
                  Platforms section carries the honest, cloud-aware mechanism instead. */}
              <StatusPill state={post.derivedState} short />
              <ApprovalPill approval={post.approval} editedSinceApproval={post.editedSinceApproval} />
              <span className="flex items-center gap-1">
                {post.platforms.map((p) => {
                  const meta = PLATFORM_META[p];
                  return meta ? <meta.Icon key={p} size={14} className={meta.color} aria-hidden="true" /> : null;
                })}
              </span>
              <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                {post.scheduledAt ? `${fmtRelative(post.scheduledAt)} · ${fmtTime(post.scheduledAt)}` : t('approvals.card.noSchedule')}
              </span>
              <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
                {t('approvals.card.campaignMeta', { campaign: campaignBaseLabel(post.campaign), id: post.id, type: t(`type.${post.type}`) })}
              </span>
              {/* Advisory brand-lint badge (read-only): silent unless a target
                  platform would trip an error; never alters approve/reject. */}
              <BrandLintBadge caption={post.caption} platforms={post.platforms} />
              {post.publishedVia === 'manual' && post.externalUrl ? (
                <a href={post.externalUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 rounded text-[11px] text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light">
                  <ExternalLink size={11} aria-hidden="true" /> {t('postDetail.viewLink')}
                </a>
              ) : null}
            </div>
            {/* X thread line (xReplyTo): link to the parent post, or an explicit
                missing note - a dangling reference never publishes on X. */}
            {post.xReplyTo ? (
              <p className="flex items-center gap-1 text-[11px] text-zinc-500 dark:text-zinc-400">
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
            {post.publishedVia === 'manual' ? (
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('postDetail.postedExternally')}</p>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {hasTriage ? (
              <>
                <Tip label={t('postDetail.triage.prev')}>
                  <button type="button" onClick={goPrev} disabled={!prevPost} aria-label={t('postDetail.triage.prev')} className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40 dark:text-zinc-400 dark:hover:bg-zinc-700/60">
                    <ChevronLeft size={16} aria-hidden="true" />
                  </button>
                </Tip>
                <span role="status" aria-live="polite" className="whitespace-nowrap text-[11px] font-bold tabular-nums text-zinc-400 dark:text-zinc-500">
                  {t('postDetail.triage.counter', { n: triageIndex + 1, m: triage.length })}
                </span>
                <Tip label={t('postDetail.triage.next')}>
                  <button type="button" onClick={goNext} disabled={!nextPost} aria-label={t('postDetail.triage.next')} className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-40 dark:text-zinc-400 dark:hover:bg-zinc-700/60">
                    <ChevronRight size={16} aria-hidden="true" />
                  </button>
                </Tip>
              </>
            ) : null}
            <CloseButton onClose={onClose} label={t('postDetail.close')} />
          </div>
        </header>
      </div>

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

      {error ? (
        <p role="alert" className="rounded-xl bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-300">{error}</p>
      ) : null}

      {/* Scrolling body: the ONLY overflow-y-auto child (min-h-0 or the footer
          collapses). Two-column 62/38 golden grid at lg for EVERY post - caption +
          platforms left, the preview (media / link-card / article-card, or a text
          tile for a pure-text post) sticky on the right. Stacks below lg. */}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-soft pr-1">
        <div className="flex flex-col gap-5 lg:grid lg:grid-cols-[minmax(0,1.62fr)_minmax(0,1fr)] lg:gap-6">
          <div className="min-w-0 space-y-5">{bodyLeft}</div>
          <div className="min-w-0 space-y-4 lg:sticky lg:top-0 lg:self-start">{rightColumn}</div>
        </div>
      </div>

      {/* Pinned footer (flex sibling, not sticky): muted secondary actions + ⋯
          overflow, primary CTA bottom-right (Z-pattern). Triage nav lives in the
          header now, next to the "n von m" counter. */}
      <div className="flex items-center gap-2 border-t border-zinc-900/5 pt-4 dark:border-white/10">
        <div className="ml-auto flex items-center gap-1.5">
          {/* ⋯ overflow FIRST - sits to the LEFT of Edit: destructive (Reject/Delete)
              + less-common actions. */}
          {menuItems.length ? (
            <Popover>
              <PopoverTrigger asChild>
                <button type="button" aria-label={t('postDetail.more')} className={`${ACTION_BTN} text-zinc-500 hover:bg-zinc-200/60 dark:text-zinc-400 dark:hover:bg-zinc-700/60`}>
                  <MoreHorizontal size={16} aria-hidden="true" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" side="top" className="w-56">
                <div className="flex flex-col">
                  {menuItems.map((it) => (
                    <PopoverClose asChild key={it.key}>
                      <button
                        type="button"
                        onClick={() => act(it.run)}
                        className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm font-bold transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-700/60 ${it.danger ? 'text-red-600 dark:text-red-300' : 'text-zinc-700 dark:text-zinc-200'}`}
                      >
                        <it.icon size={14} aria-hidden="true" />
                        {it.label}
                      </button>
                    </PopoverClose>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          ) : null}
          {editable ? (
            <Tip label={t('postDetail.action.editAria')}>
              <button type="button" onClick={() => onEdit(post)} aria-label={t('postDetail.action.editAria')} className={`${ACTION_BTN} bg-zinc-200/60 hover:bg-zinc-300/60 dark:bg-zinc-800/60 dark:hover:bg-zinc-700/60`}>
                <Pencil size={13} aria-hidden="true" />
                {t('postDetail.action.editIdle')}
              </button>
            </Tip>
          ) : null}
          {editable && primary !== 'reschedule' && !anyDirty ? (
            <Tip label={t('postDetail.action.rescheduleAria')}>
              <button type="button" aria-label={t('postDetail.action.rescheduleAria')} aria-expanded={rescheduleOpen} aria-controls="detail-reschedule-panel" onClick={toggleReschedule} className={`${ACTION_BTN} bg-zinc-200/60 hover:bg-zinc-300/60 dark:bg-zinc-800/60 dark:hover:bg-zinc-700/60`}>
                <CalendarClock size={13} aria-hidden="true" />
                {t('postDetail.action.rescheduleIdle')}
              </button>
            </Tip>
          ) : null}

          {/* Dirty edits take the primary slot: Save appears only once ANY content
              field changed, patches all of them in one rev-guarded write, and
              clears itself on success (rev bump -> draft re-sync). When clean, the
              normal state-based CTA shows. */}
          {anyDirty ? (
            <ActionButton variant="success" size="md" icon={CheckCircle2} labels={{ idle: t('postDetail.action.saveIdle'), loading: t('postDetail.action.saveLoading'), success: t('postDetail.action.saveSuccess'), error: t('postDetail.error.generic') }} onAction={saveFields} onError={setError} />
          ) : (
            <>
              {primary === 'approve' ? (
                <ActionButton variant="success" size="md" icon={CheckCircle2} labels={{ idle: t('approvals.action.approve'), loading: t('approvals.action.approving'), success: t('approvals.action.approved'), error: t('approvals.action.error') }} onAction={onApprove} onError={setError} />
              ) : null}
              {primary === 'publishNow' ? (
                <Tip label={t('postDetail.action.publishNowTip')}>
                  <ActionButton variant="success" size="md" icon={Send} ariaLabel={t('postDetail.action.publishNowTip')} labels={{ idle: t('postDetail.action.publishNowIdle'), loading: t('postDetail.action.publishNowLoading'), success: t('postDetail.action.publishNowSuccess'), error: t('postDetail.error.generic') }} onAction={onPublishNow} onError={setError} />
                </Tip>
              ) : null}
              {primary === 'verify' ? (
                <Tip label={t('postDetail.action.verifyTip')}>
                  <ActionButton variant="success" size="md" icon={ShieldCheck} ariaLabel={t('postDetail.action.verifyTip')} labels={{ idle: t('postDetail.action.verifyIdle'), loading: t('postDetail.action.verifyLoading'), success: t('postDetail.action.verifySuccess'), error: t('postDetail.error.generic') }} onAction={onVerify} onError={setError} />
                </Tip>
              ) : null}
              {primary === 'reschedule' ? (
                <button type="button" aria-expanded={rescheduleOpen} aria-controls="detail-reschedule-panel" onClick={toggleReschedule} className="flex items-center gap-1.5 rounded-xl bg-brand px-3 py-1.5 text-xs font-bold text-white transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-brand-light dark:text-zinc-900">
                  <CalendarClock size={14} aria-hidden="true" />
                  {t('postDetail.action.rescheduleIdle')}
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
