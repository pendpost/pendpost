import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, XCircle, Pencil, Trash2, ImagePlus, ImageOff, Camera, CalendarClock, CalendarPlus, PauseCircle, CheckCheck, Send, ExternalLink, FileImage, FileVideo, FileX2, ShieldCheck, ShieldAlert, ShieldX, Power, CornerUpLeft, MoreHorizontal, MessageSquare, ListPlus, ChevronLeft, ChevronRight, Cloud as CloudIcon, Zap, RefreshCw, Pin, PlugZap, ClipboardCopy, Wrench, Crop } from 'lucide-react';
import { fmtFull, fmtTime, fmtRelative, fmtBytes, campaignBaseLabel, effectiveDelivery, unconnectedLanes, handOffTarget, effectiveLaneText, mastodonThreadUrl, fieldsForPost, deriveThread, OVERRIDE_FIELD, PLATFORMS, TYPES, formatsForPlatform, typeOptionLabel, isImageMedia, visiblePlatforms, pollDurationKey, postNeedsMedia, publishRunOutcome, gridCropInfo, X_PORTAL_URL } from '../lib/format.js';
import {
  useAccounts, usePendpostHealth, usePlatformValidate, usePresubmitCheck, useValidateMedia, useActiveClient, useRedditFlairs, useInsights, useConfig, useAssets,
  approvePost, rejectPost, deletePost, unschedulePost, reschedulePost, markPosted, verifyPost,
  runPublishDue, setCoverFrame, uploadCover, clearCover, updatePost, editPublished, discordScheduleEvent, mastodonPin, resumeLane,
} from '../lib/api.js';
import { VideoPicker } from './Composer.jsx';
import { MetricChips, makeMetricLabel } from './Insights.jsx';
import { useCloudDelivery } from '../lib/cloud.js';
import { StatusPill, ApprovalPill, PlatformIcons, PLATFORM_META, INNER_SURFACE, Modal, CloseButton, PostPreview, PlatformBlockers, setupLinkOffered, EYEBROW, FIELD, FIELD_MULTILINE } from './ui.jsx';
import { Popover, PopoverTrigger, PopoverContent, PopoverClose } from './ui/Popover.jsx';
import ClientBand from './ClientBand.jsx';
import { Tip } from './ui/Tooltip.jsx';
import { IconBadge } from './ui/IconBadge.jsx';
import { ServedBadge } from './ui/ServedBadge.jsx';
import BrandLintBadge from './ui/BrandLintBadge.jsx';
import ActionButton from './ui/ActionButton.jsx';
import { destinationFor, shortId } from './ui/DestinationStrip.jsx';
import { ReviewStatusChip } from './ReviewLink.jsx';
import { DateTimePicker } from './ui/DateTimePicker.jsx';
import { useConfirm, usePrompt } from './ui/confirm.jsx';
import CommentsPanel from './CommentsPanel.jsx';
import PlaylistPanel from './PlaylistPanel.jsx';
import ZapModal from './ZapModal.jsx';
import { showToast } from './AppToast.jsx';
import { patchPlanRemove } from '../lib/useReschedule.js';
import { useT } from '../lib/i18n.js';

// The comment-capable platforms (spec 02, Pattern P6): the Comments thread panel is
// offered only when a POSTED post reached at least one of these. Mirrors
// lib/comments.mjs COMMENT_PLATFORMS (kept as a small local copy so the browser
// bundle never imports the server-only lib module). x/pinterest/gbp are excluded.
const COMMENT_CAPABLE_PLATFORMS = new Set(['instagram', 'facebook', 'youtube', 'linkedin', 'wordpress', 'reddit', 'tiktok', 'telegram', 'mastodon', 'nostr', 'discord']);

// Edit-after-publish (spec 12): the platform -> post.ids field carrying the
// minted id, restricted to the three lanes that expose a first-class edit-in-
// place API (videos.update / editMessageText|Caption / PATCH .../messages/{id}).
// Mirrors lib/comments.mjs LANE_OBJECT_FIELD (kept as a small local copy so the
// browser bundle never imports the server-only lib module).
const EDIT_LANE_ID = { youtube: 'ytVideoId', telegram: 'tgMessageId', discord: 'dcMessageId' };

// Publish-evidence id fields, mirroring the engine's ALL_PLATFORM_ID_FIELDS
// (lib/plans.mjs PLATFORM_ID_FIELDS, kept as a small local copy so the browser
// bundle never imports the server-only lib module). Drives the ONE delete
// confirm: a post carrying any of these (or status 'posted') gets the stronger
// force wording and sends force:true - the server would refuse without it.
const EVIDENCE_ID_FIELDS = [
  'fbPostId', 'fbReelId', 'igMediaId', 'liPostId', 'ytVideoId', 'xPostId',
  'tgMessageId', 'dcMessageId', 'redditPostId', 'pinId', 'tiktokVideoId',
  'mastodonStatusId', 'mastodonScheduledId', 'wordpressPostId', 'ghostPostId',
  'nostrEventId', 'gbpPostId', 'blueskyPostId',
];

function Section({ title, children }) {
  return (
    <section className="space-y-1.5">
      <h3 className={EYEBROW}>{title}</h3>
      {children}
    </section>
  );
}

// US-MEDIA-UP: swap an open post's media in place - upload, drop, or pick a library
// file - via the SAME VideoPicker the editor uses. The asset fetch lives here (not
// in PostDetail) so it runs ONLY when a single-media editable post actually renders
// this control; `onChange` receives the picked `${dir}/${file}` ref (or '' to clear).
function ChangeMediaField({ post, onChange }) {
  const t = useT();
  const { data: assetsData } = useAssets(true);
  const dir = assetsData?.dir || '';
  return (
    <Section title={t('postDetail.section.media')}>
      <div className={`space-y-1.5 rounded-xl p-2.5 ${INNER_SURFACE}`}>
        <VideoPicker
          assets={assetsData?.assets || []}
          assetsDir={dir}
          value={post.media.file ? `${dir}/${post.media.file}` : ''}
          onChange={onChange}
        />
        <p className="text-[10px] text-zinc-500 dark:text-zinc-400">{t('postDetail.media.hint')}</p>
      </div>
    </Section>
  );
}

// ONE editable content field in the detail dialog, driven by the shared
// field-relevance model. `label` names it; the optional platform-icon row shows
// which targeted networks the field feeds (only where it diverges from "all of
// them"), and the optional hint carries the override note (X/Mastodon/Nostr).
// Read-only (a posted post) collapses to a plain paragraph. Long content wraps
// (break-words) so a URL-heavy field never forces the dialog to scroll sideways.
function ContentField({ label, platforms, showIcons, hint, kind, mono, value, onChange, editable, placeholder }) {
  // Size from content, not just newlines: a long single-paragraph caption wraps,
  // so estimate wrapped lines (~52 chars/row, matching the ~55-char left column)
  // and take the max with the newline count - min 3 rows, capped so a whole
  // article body cannot swallow the dialog.
  const text = String(value || '');
  const rows = kind === 'textarea'
    ? Math.min(mono ? 18 : 14, Math.max(3, text.split('\n').length + 1, Math.ceil(text.length / 52)))
    : undefined;
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className={EYEBROW}>{label}</span>
        {showIcons && platforms.length ? <PlatformIcons platforms={platforms} size={12} /> : null}
        {hint ? <span className="text-[10px] font-medium text-zinc-500 dark:text-zinc-400">{hint}</span> : null}
      </div>
      {editable ? (
        kind === 'textarea' ? (
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            aria-label={label}
            placeholder={placeholder}
            rows={rows}
            className={`w-full resize-y break-words leading-relaxed scrollbar-soft ${mono ? 'font-mono ' : ''}${FIELD_MULTILINE}`}
          />
        ) : (
          <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            aria-label={label}
            placeholder={placeholder}
            className={`${FIELD} w-full`}
          />
        )
      ) : (
        <p className={`whitespace-pre-wrap break-words rounded-xl p-3 text-sm leading-relaxed ${INNER_SURFACE} ${value ? '' : 'text-zinc-500 dark:text-zinc-400'}`}>
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

// Spec 01: a known preset (all/free/paid) reuses the SAME labels the Composer's
// <select> shows, so authoring and review never say two different things for one
// value; an advanced raw NQL filter (e.g. "label:vip") is shown verbatim.
function emailSegmentSummary(segment, t) {
  return ['all', 'free', 'paid'].includes(segment) ? t(`composer.field.emailSegment.${segment}`) : segment;
}

// Spec 14: a one-line human summary of the Telegram CTA (button count + any
// non-default preview/format flag) for the read-only Details row.
function tgCtaSummary(cta, t) {
  const parts = [];
  if (cta.buttons?.length) parts.push(t('postDetail.field.tgCtaButtons', { count: cta.buttons.length }));
  // Only the non-default state is worth a review chip: preview OFF (the default
  // is on), and HTML format (the default is plain). The label must state the
  // ACTUAL state - "Link preview off", never the composer's "Show link preview".
  if (cta.linkPreview === false) parts.push(t('postDetail.field.tgCtaPreviewOff'));
  if (cta.format === 'html') parts.push(t('composer.tgcta.format.html'));
  return parts.join(' · ');
}

// Spec 14: a one-line human summary of the Discord embed (title, else the
// description, else the url - whichever is authored) for the read-only Details row.
function dcEmbedSummary(embed) {
  return embed.title || embed.description || embed.url || '';
}

// Spec 25: a one-line human summary of the TikTok interaction/disclosure flags
// (which toggles are ON + the cover timestamp, if set) for the read-only Details row.
const TT_INTERACTION_SUMMARY_KEYS = ['disableComment', 'disableDuet', 'disableStitch', 'aiGenerated', 'brandedContent', 'brandOrganic'];
function ttInteractionSummary(interaction, t) {
  const parts = TT_INTERACTION_SUMMARY_KEYS.filter((k) => interaction[k] === true).map((k) => t(`composer.tiktok.${k}`));
  if (Number.isInteger(interaction.coverTimestampMs)) parts.push(t('postDetail.field.ttCoverTimestamp', { ms: interaction.coverTimestampMs }));
  return parts.join(' · ');
}

// Spec 25: the read-only label for X's reply_settings enum, reusing the SAME
// option labels the Composer's select shows (mirrors emailSegmentSummary).
function xReplySettingsSummary(value, t) {
  return t(`composer.field.xReplySettings.${value}`);
}

// Spec 10: a one-line human recap of the native poll (the options joined + the
// duration) for the read-only Details row. A preset duration reuses the Composer's
// own duration label; any other value falls back to "<n> min".
function pollSummary(poll, t) {
  const options = Array.isArray(poll.options) ? poll.options.filter((o) => String(o || '').trim()) : [];
  const key = pollDurationKey(poll.durationMinutes);
  const duration = key ? t(`composer.poll.duration.${key}`) : t('postDetail.poll.minutes', { count: poll.durationMinutes });
  const parts = [];
  if (options.length) parts.push(options.join(' · '));
  parts.push(`${t('postDetail.poll.duration')}: ${duration}`);
  if (poll.multiple) parts.push(t('composer.poll.multiple'));
  return parts.join(' — ');
}

// One human-readable line per authored story sticker ("Poll: which one? - A / B").
// Reuses the Composer's per-kind labels; feeds the posted-state add-by-hand
// checklist below (the engine publishes no sticker parameters, so once the story
// is live these are the operator's manual to-do list in the Instagram app).
function stickerSummary(s, t) {
  const label = t(`composer.sticker.${s.kind}.label`);
  const detail = s.kind === 'poll' ? [s.question, (s.options || []).filter(Boolean).join(' / ')].filter(Boolean).join(' - ')
    : s.kind === 'question' ? s.prompt
    : s.kind === 'link' ? (s.label ? `${s.label} (${s.url || ''})` : s.url)
    : s.kind === 'mention' ? (s.handle ? `@${String(s.handle).replace(/^@/, '')}` : '')
    : s.kind === 'location' ? s.name
    : s.kind === 'hashtag' ? (s.tag ? `#${String(s.tag).replace(/^#/, '')}` : '')
    : s.kind === 'music' ? [s.title, s.artist].filter(Boolean).join(' - ')
    : '';
  return detail ? `${label}: ${detail}` : label;
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
    // Specs 17+39: the public media URL the URL-only lanes (pinterest, instagram
    // feed image) fetch at publish time. Review-only here; authored in the Composer.
    else if (key === 'imageUrl' && post.imageUrl) rows.push({ key, label: t('postDetail.field.imageUrl'), value: post.imageUrl, url: true });
    else if (key === 'redditUrl' && post.redditUrl) rows.push({ key, label: t('postDetail.field.redditUrl'), value: post.redditUrl, url: true });
    // Spec 16: one flair chip - the human-readable text where set, else the template id.
    else if (key === 'redditFlairId' && post.redditFlairId) rows.push({ key, label: t('postDetail.field.redditFlair'), value: post.redditFlairText || post.redditFlairId });
    // Spec 36: the per-post subreddit target, shown as r/<sub> only when set (reuses the
    // Composer label - no new i18n key). A no-subreddit post shows no row (byte-identical).
    else if (key === 'redditSubreddit' && post.redditSubreddit) rows.push({ key, label: t('composer.field.redditSubreddit'), value: `r/${String(post.redditSubreddit).replace(/^\/?r\//, '')}` });
    // Spec 37: mark ORGANIC only when explicitly set (isPromo === false). A promo/unset
    // post shows no row - byte-identical to before (absence = promo, the default).
    else if (key === 'isPromo' && post.isPromo === false) rows.push({ key, label: t('postDetail.field.isPromo'), check: true });
    // Spec 17: the Pinterest board-section target, shown only when set (a no-section
    // post shows no row - byte-identical to before this spec).
    else if (key === 'pinBoardSection' && post.pinBoardSection) rows.push({ key, label: t('postDetail.field.pinBoardSection'), value: post.pinBoardSection });
    else if (key === 'canonicalUrl' && post.canonicalUrl) rows.push({ key, label: t('postDetail.field.canonicalUrl'), value: post.canonicalUrl, url: true });
    else if (key === 'blogSlug' && post.blogSlug) rows.push({ key, label: t('postDetail.field.blogSlug'), value: post.blogSlug });
    else if (key === 'hashtags' && Array.isArray(post.hashtags) && post.hashtags.length) rows.push({ key, label: t('postDetail.field.hashtags'), value: post.hashtags.join(' ') });
    else if (key === 'gbp' && post.gbp) rows.push({ key, label: t('postDetail.field.gbp'), value: gbpSummary(post.gbp, t) });
    // Story stickers: before publish, the compact count summary. Once POSTED, the
    // row becomes the add-by-hand checklist (sticker honesty): the engine sends no
    // sticker parameters, so the live story has none of these until the operator
    // adds them in the Instagram app - list exactly what to add.
    else if (key === 'interactiveStory' && post.interactiveStory?.stickers?.length) {
      const stickers = post.interactiveStory.stickers.filter(Boolean);
      if (post.status === 'posted' || post.derivedState === 'posted') {
        rows.push({ key, label: t('postDetail.field.interactiveStory'), lines: stickers.map((s) => stickerSummary(s, t)), hint: t('postDetail.stickers.addByHand') });
      } else {
        rows.push({ key, label: t('postDetail.field.interactiveStory'), value: t('postDetail.field.stickerCount', { count: stickers.length }) });
      }
    }
    else if (key === 'ghostEmail' && post.ghostEmail === true) rows.push({ key, label: t('postDetail.field.ghostEmail'), check: true });
    else if (key === 'newsletter' && post.newsletter) rows.push({ key, label: t('postDetail.field.newsletter'), value: post.newsletter });
    else if (key === 'emailSegment' && post.emailSegment) rows.push({ key, label: t('postDetail.field.emailSegment'), value: emailSegmentSummary(post.emailSegment, t) });
    else if (key === 'emailOnly' && post.emailOnly === true) rows.push({ key, label: t('postDetail.field.emailOnly'), check: true });
    else if (key === 'publishAsDraft' && post.publishAsDraft === true) rows.push({ key, label: t('postDetail.field.publishAsDraft'), check: true });
    else if (key === 'tgCta' && post.tgCta) rows.push({ key, label: t('postDetail.field.tgCta'), value: tgCtaSummary(post.tgCta, t) });
    else if (key === 'dcEmbed' && post.dcEmbed) rows.push({ key, label: t('postDetail.field.dcEmbed'), value: dcEmbedSummary(post.dcEmbed) });
    else if (key === 'ttInteraction' && post.ttInteraction) rows.push({ key, label: t('postDetail.field.ttInteraction'), value: ttInteractionSummary(post.ttInteraction, t) });
    else if (key === 'xReplySettings' && post.xReplySettings) rows.push({ key, label: t('postDetail.field.xReplySettings'), value: xReplySettingsSummary(post.xReplySettings, t) });
    else if (key === 'poll' && post.poll) rows.push({ key, label: t('postDetail.field.poll'), value: pollSummary(post.poll, t) });
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
              ) : r.lines ? (
                <div className="space-y-0.5">
                  <ul className="list-disc space-y-0.5 pl-4">
                    {r.lines.map((line, i) => <li key={i} className="break-words">{line}</li>)}
                  </ul>
                  {r.hint ? <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{r.hint}</p> : null}
                </div>
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

// The Composer's form-field surface, mirrored for the quick-edit controls so the
// modal's format select + schedule trigger read as the same field family.

// Honest per-platform cover reality (mirrors covers.mjs applicability /
// PLATFORM-MATRIX.md) - never imply a cover reaches a platform it cannot.
function coverChips(post, t) {
  const chips = [];
  const source = post.cover?.source;
  for (const p of post.platforms) {
    if (p === 'facebook') chips.push({ p, ok: true, text: t('postDetail.cover.chip.fb') });
    else if (p === 'instagram') {
      if (post.type === 'story') chips.push({ p, ok: false, text: t('postDetail.cover.chip.igStory') });
      else if (source === 'url') chips.push({ p, ok: true, text: t('postDetail.cover.chip.igUrl') });
      else if (source === 'file') chips.push({ p, ok: false, text: t('postDetail.cover.chip.igFile') });
      else if (source === 'frame') chips.push({ p, ok: true, text: t('postDetail.cover.chip.igFrame') });
      // No explicit cover: the engine publishes frame 0, where the render
      // pipeline bakes the title card (meta-social container default).
      else chips.push({ p, ok: true, text: t('postDetail.cover.chip.igFrame0') });
    } else if (p === 'youtube') chips.push({ p, ok: true, text: t('postDetail.cover.chip.yt') });
    else if (p === 'linkedin') chips.push({ p, ok: true, text: t('postDetail.cover.chip.li') });
    else if (p === 'x') chips.push({ p, ok: false, text: t('postDetail.cover.chip.x') });
  }
  return chips;
}

export default function PostDetail({ post, posts = [], triage = null, triageIndex = -1, posting, onClose, onEdit, onNavigate, onOpenPost }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { data: accounts } = useAccounts();
  // Which of this post's lanes pendpost cannot publish to. Free: the ['pendpost-health']
  // query is already in flight app-wide (App.jsx, Freigaben.jsx, Setup.jsx all hold it) and
  // react-query dedupes by key, so this is a read of a cache the modal simply never looked at.
  const { data: health } = usePendpostHealth(true);
  const offlineLanes = unconnectedLanes(post, health?.setup);
  // A lane-wide halt (post.lastFailure.halted, e.g. X 402 credits depleted) offers a
  // top-up link. The portal URL is single-sourced from the SAME setup payload the Setup
  // page reads (lib/playbooks.mjs -> setup.platforms[].playbook.portalUrl), so it never
  // drifts from a hardcoded copy; the link renders only once that value resolves.
  const haltedLane = post.lastFailure?.halted ? post.lastFailure.lane : null;
  const haltPortalUrl = haltedLane
    ? (health?.setup?.platforms?.find((r) => r.platform === haltedLane)?.playbook?.portalUrl
        || (haltedLane === 'x' ? X_PORTAL_URL : null))
    : null;
  // dim-3 M5: the after-publish home shows THIS post's stored metric chips beside
  // its verify chips (the ['insights'] query is already held by the Insights panel,
  // react-query dedupes by key - no extra fetch). A per-platform map of the stored
  // rows for this exact post; the metric label resolver is the SAME one the panel
  // uses (makeMetricLabel), so the chips read identically.
  const { data: insightsData } = useInsights(true);
  const metricLabel = makeMetricLabel(t, insightsData?.metricLabels || {});
  const metricsByPlatform = useMemo(() => {
    const map = {};
    for (const it of insightsData?.items || []) {
      if (it.campaign === post.campaign && it.postId === post.id) map[it.platform] = it;
    }
    return map;
  }, [insightsData, post.campaign, post.id]);
  // The account a lane publishes to, as a short label for the delivery rows. The
  // platform-confirmed account from the verify read-back beats the configured one:
  // after a publish, where the media ACTUALLY lives is the fact worth showing. Returns
  // null when nothing is known, so the row stays silent rather than guessing.
  const laneAccount = (platform) => {
    const confirmed = post.verify?.platforms?.[platform]?.account;
    if (confirmed) return `@${String(confirmed).replace(/^@/, '')}`;
    const dest = destinationFor(platform, accounts);
    if (!dest) return null;
    return dest.handle || (dest.id ? shortId(dest.id) : null);
  };

  // The inline flair picker's read (spec 16's tool, the Composer's states). Keyed to the
  // EFFECTIVE subreddit - the per-post target (spec 36) with the connection default
  // behind it - and enabled only while an editable reddit post is actually on screen.
  const redditTargeted = (post?.platforms || []).includes('reddit');
  const flairSubreddit = String(post?.redditSubreddit || accounts?.reddit?.subreddit || '').replace(/^\/?r\//, '').trim();
  const flairEnabled = Boolean(post) && redditTargeted && post?.derivedState !== 'posted' && Boolean(flairSubreddit);
  const { data: redditFlairsData, isLoading: redditFlairsLoading } = useRedditFlairs(flairSubreddit, flairEnabled);
  const redditFlairs = redditFlairsData?.ok ? redditFlairsData.items || [] : [];
  // ok:false AND a keyless mock both mean "couldn't read flairs" - the unavailable
  // affordance, never the empty state (which would claim a flair-less sub).
  const redditFlairsUnavailable = Boolean(redditFlairsData) && redditFlairsData.ok !== true;
  const flairSelectRef = useRef(null);
  // B2: read-only publish-readiness probes for the open post. enabled-gated and
  // keyed per campaign+postId; they surface advisory blocker rows below the
  // Platforms list. Never write, never auto-retry, never poke a lane.
  const { data: platformValidate } = usePlatformValidate(post?.campaign, post?.id, Boolean(post), post?.rev);
  // Spec 09: reddit/tiktok pre-submit rules (subreddit flair/title/type; TikTok
  // creator privacy/caption caps) - merged into the SAME PlatformBlockers panel.
  const { data: presubmitCheck } = usePresubmitCheck(post?.campaign, post?.id, Boolean(post), post?.rev);
  // CI-2: skip the probe entirely for a media-less type (text/poll/nostr-longform) -
  // there is no local media to spec-check, and the server 404s (media_missing) on
  // the happy path otherwise, which is just console noise, never a real advisory.
  const { data: validateMedia } = useValidateMedia(post?.campaign, post?.id, Boolean(post) && postNeedsMedia(post), post?.rev);
  const confirm = useConfirm();
  const prompt = usePrompt();
  const { activeClient } = useActiveClient();
  // Cloud-aware delivery: whether the always-on runtime fires this brand and which
  // lanes it covers, so the one delivery statement below tells the truth (and stays
  // silent until `resolved` rather than flashing a wrong "needs your Mac").
  const { cloudOn, cloudLanes, localOnlyTypes, resolved: cloudResolved } = useCloudDelivery();
  // B4: append a client-naming line to an irreversible/native-mutation confirm so
  // the owner always knows whose post/platform they are about to act on. Returns
  // the body unchanged when no client is active (never implies a wrong client).
  const withClientLine = (body) =>
    activeClient?.displayName ? `${body}\n\n${t('confirm.forClient', { client: activeClient.displayName })}` : body;
  const videoRef = useRef(null);
  const fileInputRef = useRef(null);
  const [error, setError] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  // The inbound-engagement (inbox) thread panel is opened from the ⋯ menu on a
  // posted, comment-capable post (spec 02, Pattern P6) - no new screen.
  const [showComments, setShowComments] = useState(false);
  // The "Add to playlist" picker is opened from the ⋯ menu on a published YouTube
  // post (spec 15, Pattern P3+P4+P9) - no new screen.
  const [showPlaylist, setShowPlaylist] = useState(false);
  // The "Send zap" modal is opened from the ⋯ menu on a published nostr note (spec 20,
  // the MONEY path) - a lightweight amount+comment dialog, no new screen.
  const [showZap, setShowZap] = useState(false);
  // Mastodon "Pin to profile"/"Unpin" (spec 31): local-only busy/scope-blocked/
  // announce state for the ⋯ menu toggle (no confirm gate - non-destructive,
  // reversible). Reset alongside the other per-post state below whenever the
  // post identity/rev changes.
  const [mastodonPinBusy, setMastodonPinBusy] = useState(false);
  const [mastodonPinBlocked, setMastodonPinBlocked] = useState(false);
  const [mastodonPinAnnounce, setMastodonPinAnnounce] = useState('');
  // Hand-off two-step latch (copy -> "mark as posted"); see onHandOff below. Declared here,
  // with the other hooks, so it stays above the `if (!post) return null` early return - a
  // hook after a conditional return violates the rules of hooks.
  const [handedOff, setHandedOff] = useState(false);
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
  // Quick-edit drafts (single edit surface): format + platforms + schedule live
  // inline in the modal now, staged like the text drafts and written by the same
  // Save. The schedule half goes through the reschedule mutation (native-object
  // guards), the rest through the one rev-guarded PATCH.
  const [typeDraft, setTypeDraft] = useState(post?.type || 'reel');
  const [platformsDraft, setPlatformsDraft] = useState(post?.platforms || []);
  const [scheduleDraft, setScheduleDraft] = useState(post?.scheduledAt || null);
  // The reddit flair, staged like every other quick-edit field. { id, text } move
  // together because flair_text only rides an EDITABLE template (the Composer's rule).
  const [flairDraft, setFlairDraft] = useState({ id: post?.redditFlairId || '', text: post?.redditFlairText || '' });
  useEffect(() => {
    const seed = {};
    for (const f of contentFields) seed[f.key] = post?.[f.key] || '';
    setDrafts(seed);
    setTypeDraft(post?.type || 'reel');
    setPlatformsDraft(post?.platforms || []);
    setScheduleDraft(post?.scheduledAt || null);
    setFlairDraft({ id: post?.redditFlairId || '', text: post?.redditFlairText || '' });
    setMastodonPinBlocked(false);
    setMastodonPinAnnounce('');
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
  const ts = (v) => (v ? Date.parse(v) : null);
  const typeDirty = typeDraft !== post.type;
  const platformsDirty = platformsDraft.join(',') !== (post.platforms || []).join(',');
  const scheduleDirty = ts(scheduleDraft) !== ts(post.scheduledAt);
  const flairDirty = (flairDraft.id || '') !== (post.redditFlairId || '');
  const anyDirty = dirtyFields.length > 0 || typeDirty || platformsDirty || scheduleDirty || flairDirty;
  const saveFields = async () => {
    // The Composer's own guards, mirrored: never save a post with no platform,
    // and a reply-to must be another post's id (the X lane fail-closes on junk).
    if (platformsDirty && !platformsDraft.length) throw new Error(t('composer.error.noPlatform'));
    const xr = String(drafts.xReplyTo ?? '').trim();
    if (dirtyFields.some((f) => f.key === 'xReplyTo') && xr && (!/^[a-zA-Z0-9_-]+$/.test(xr) || xr === post.id)) {
      throw new Error(t('composer.error.xReplyToFormat'));
    }
    const patch = {};
    for (const f of dirtyFields) {
      const v = drafts[f.key] ?? '';
      patch[f.key] = f.key === 'caption' ? v : (v || null);
    }
    if (typeDirty) patch.type = typeDraft;
    if (platformsDirty) patch.platforms = platformsDraft;
    if (flairDirty) {
      patch.redditFlairId = flairDraft.id || null;
      patch.redditFlairText = flairDraft.text || null;
    }
    if (Object.keys(patch).length) {
      try {
        await updatePost(post.campaign, post.id, post.rev, patch);
      } catch (err) {
        throw new Error(err?.code === 'stale_write' ? t('composer.error.staleWrite') : (err?.message || t('postDetail.error.generic')));
      }
    }
    // Schedule goes through the reschedule mutation (NOT the PATCH) so the
    // native-object safety net applies (a natively-scheduled FB/YT post asks
    // for confirmation before its platform object is recreated).
    if (scheduleDirty) {
      const d = new Date(scheduleDraft);
      if (Number.isNaN(d.getTime())) throw new Error(t('postDetail.reschedule.invalidDate'));
      if (d.getTime() <= Date.now()) throw new Error(t('postDetail.reschedule.pastDate'));
      await withConfirm((confirm2) => reschedulePost(post.campaign, post.id, d.toISOString(), confirm2));
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

  // Approve and reject are DECISIONS: once taken, the dialog's job is done, so
  // both close it (mirroring onDelete) - the refreshed list carries the outcome.
  // Leaving the modal open once showed a stale snapshot that still offered
  // "publish now" on a post the scheduler had already fired.
  const onApprove = async () => {
    setError(null);
    await approvePost(post.campaign, post.id);
    refresh();
    onClose();
  };
  const onReject = async () => {
    setError(null);
    const note = await prompt({
      title: t('postDetail.reject.title'),
      body: t('postDetail.reject.body'),
      placeholder: t('postDetail.reject.placeholder'),
      multiline: true,
      rememberKey: 'approvals.reject',
    });
    if (note === null) throw { canceled: true };
    await rejectPost(post.campaign, post.id, note.trim() || undefined);
    refresh();
    onClose();
  };
  // "Delete always works": ONE confirm, then instant. The force question is
  // folded INTO the primary confirm (client-side evidence detection mirrors the
  // engine's gate), so the old confirm -> server refusal -> second confirm ->
  // retry dance is gone. After the confirm the post leaves the ['plans'] cache
  // optimistically and the dialog closes at once; the server answer lands as a
  // bottom-right toast - success quietly, failure with the message AND the post
  // rolled back into place. The engine cancels natively scheduled platform
  // objects itself now (lib/writes.mjs deletePost), so no unschedule ceremony.
  const onDelete = async () => {
    setError(null);
    const hasEvidence = post.status === 'posted' || EVIDENCE_ID_FIELDS.some((k) => post.ids?.[k]);
    // F7: dcEventId is NOT publish evidence (the guild event is a separate calendar
    // object), but deleting the row cancels that live event platform-side (the
    // engine's deleteSideHandoffs). The plain confirm must say so - one sentence,
    // same dialog. The force wording already carries its own cancel sentence.
    const cancelsEvent = !hasEvidence && Boolean(post.ids?.dcEventId);
    const baseBody = hasEvidence
      ? t('postDetail.delete.forceBody', { id: post.id })
      : cancelsEvent
        ? `${t('postDetail.delete.body', { id: post.id })}\n\n${t('postDetail.delete.eventWarn')}`
        : t('postDetail.delete.body', { id: post.id });
    // Thread guard: deleting a post other posts reply to (xReplyTo) strands
    // them - the X lane holds a child forever once its parent is gone.
    const deleteBody = threadReplies.length
      ? `${baseBody}\n\n${t('postDetail.delete.threadWarn', { count: threadReplies.length, ids: threadReplies.map((r) => r.id).join(', ') })}`
      : baseBody;
    const ok = await confirm({
      title: t('postDetail.delete.title'),
      body: withClientLine(deleteBody),
      confirmLabel: hasEvidence ? t('postDetail.delete.forceLabel') : t('postDetail.delete.confirmLabel'),
      danger: true,
      // Suppressible for a plain delete only: the evidence (force) wording, the
      // thread-strand warning and the event-cancel sentence must always be seen -
      // each names a real consequence.
      rememberKey: threadReplies.length || hasEvidence || cancelsEvent ? undefined : 'postDetail.delete',
    });
    if (!ok) throw { canceled: true };
    // Optimistic: the post leaves the plan NOW (useReschedule's snapshot/rollback
    // pattern) and the dialog closes with it - one motion, no waiting on the wire.
    const prev = queryClient.getQueryData(['plans']);
    queryClient.setQueryData(['plans'], (old) => patchPlanRemove(old, post.campaign, post.id));
    onClose();
    try {
      if (hasEvidence) await deletePost(post.campaign, post.id, true);
      else await deletePost(post.campaign, post.id);
      showToast({ kind: 'success', text: t('postDetail.delete.toastSuccess') });
    } catch (err) {
      // Rollback: the post reappears where it was; the toast carries the server's
      // reason (e.g. a native platform cancel that failed, leaving the post intact).
      // F3: the KNOWN refusal maps by its stable code - engine_failure here means the
      // platform-side cancel failed - so the toast leads with a localized sentence
      // and keeps the engine's own words as the quoted detail.
      queryClient.setQueryData(['plans'], prev);
      const detail = err?.message || t('postDetail.error.generic');
      showToast({
        kind: 'error',
        text: err?.code === 'engine_failure'
          ? t('postDetail.delete.toastError.cancelFailed', { detail })
          : t('postDetail.delete.toastError', { message: detail }),
      });
    } finally {
      queryClient.invalidateQueries({ queryKey: ['plans'] });
    }
  };
  const onPark = () => withConfirm((confirm2) => unschedulePost(post.campaign, post.id, confirm2));
  // One dialog (not two): the link prompt IS the confirmation - its body explains
  // the post leaves the queue and nothing is published. null = cancel (snaps the
  // button back to idle), empty string = mark with no link.
  const onMarkPosted = async (lane) => {
    setError(null);
    // R5/G4/L4: on a MIXED multi-lane post, mark ONLY the named lane so the post
    // keeps owing its still-open siblings (whole-post mark below closes all lanes,
    // which is wrong when pendpost still owes one). A string lane = scoped; any
    // non-string (e.g. an ActionButton event) falls back to the whole-post mark.
    const scoped = typeof lane === 'string' && lane ? lane : null;
    const laneLabel = scoped ? (PLATFORM_META[scoped]?.label || scoped) : null;
    const url = await prompt({
      title: scoped ? t('postDetail.markPosted.laneTitle', { lane: laneLabel }) : t('postDetail.markPosted.title'),
      body: scoped ? t('postDetail.markPosted.laneBody', { id: post.id, lane: laneLabel }) : t('postDetail.markPosted.body', { id: post.id }),
      placeholder: t('postDetail.markPosted.placeholder'),
    });
    if (url === null) throw { canceled: true };
    await markPosted(post.campaign, post.id, url.trim() || undefined, scoped || undefined);
    refresh();
  };
  // Read the post back from its platforms to confirm it is actually live
  // (read-only; writes a non-destructive verify block, never publishes).
  const onVerify = async () => {
    setError(null);
    const res = await verifyPost(post.campaign, post.id);
    refresh();
    // Only a real live read-back is a success. verify_post returns ok:true even
    // when the post reads back NOT live (liveCount 0) - throw so the ActionButton
    // shows the honest "Still not live" state instead of flashing a false green
    // "Verified" that the refetched verify-failed state then overwrites.
    if (!res?.liveCount) throw new Error(t('postDetail.verify.notLive'));
  };
  // Force-publish an overdue, approved post NOW instead of waiting for the next
  // scheduler sweep. Reuses the per-post publish-due path (confirm:true = a REAL
  // publish), so the same lint/cadence/Meta-block guards apply. Surfaces a real
  // per-lane failure instead of flashing a false success.
  const onPublishNow = async () => {
    setError(null);
    const ok = await confirm({
      title: t(retryHeld ? 'postDetail.tryAgain.title' : 'postDetail.publishNow.title'),
      body: withClientLine(t(retryHeld ? 'postDetail.tryAgain.body' : 'postDetail.publishNow.body', { id: post.id })),
      confirmLabel: t(retryHeld ? 'postDetail.tryAgain.confirmLabel' : 'postDetail.publishNow.confirmLabel'),
      danger: true,
    });
    if (!ok) throw { canceled: true };
    if (retryHeld) {
      // Fix B7: clear the hold FIRST, or the run below fires zero lanes (lanesOwed
      // skips a held post). A reschedule to the post's OWN unchanged scheduledAt is
      // the engine's documented "retry now" verb (lib/publish-hold.mjs) - server-legal
      // (reschedulePost validates ISO-8601 only, never future-ness) and otherwise
      // GUI-inexpressible (the picker's disablePast). needs_confirm escalates like
      // every other native-object mutation (a natively scheduled sibling lane).
      try {
        await reschedulePost(post.campaign, post.id, post.scheduledAt, false);
      } catch (err) {
        if (err?.code !== 'needs_confirm') throw err;
        const ok2 = await confirm({ title: t('postDetail.confirm.title'), body: withClientLine(err.message), confirmLabel: t('postDetail.confirm.continue'), danger: true });
        if (!ok2) throw { canceled: true };
        await reschedulePost(post.campaign, post.id, post.scheduledAt, true);
      }
    }
    const res = await runPublishDue({ campaign: post.campaign, postId: post.id });
    const { rows: mine, fired, held, halted, reason } = publishRunOutcome(res, post.id);
    if (!fired && held) {
      // The cloud owns this lane inside its handoff grace: nothing failed, the
      // click just cannot fire locally yet. Say so instead of flashing success.
      refresh();
      setError(t('postDetail.publishNow.cloudHeld'));
      throw { canceled: true };
    }
    if (!fired && halted && !reason) {
      // The lane is paused by an account-level breaker (X 402 credits) and dropped
      // before dispatch, and NOTHING else genuinely failed (reason excludes the
      // informational markers). Change 1 hides the button on a post carrying its OWN
      // halt, so this fires only for the residual case (an overdue post on ANOTHER
      // post's block). Tell the truth and point at the resume control. When a real
      // lane DID fail alongside the halt, `reason` is set and the failure branch below
      // wins - the actionable failure must not be masked by the halt marker.
      refresh();
      setError(t('postDetail.publishNow.laneHalted'));
      throw { canceled: true };
    }
    if (!fired && mine.length) {
      refresh();
      setError(reason ? t('postDetail.publishNow.failedReason', { reason }) : t('postDetail.publishNow.laneFailed', { lane: mine[0].lane }));
      throw { canceled: true };
    }
    if (!mine.length) {
      // An empty run usually means the background scheduler beat this click and
      // the post is already live - decide from FRESH truth, not the snapshot.
      // If it really is posted, this click succeeded in spirit: report success
      // (the refetched state hides the button and shows the publish time).
      await queryClient.refetchQueries({ queryKey: ['plans'] });
      const fresh = (queryClient.getQueryData(['plans'])?.campaigns || [])
        .find((c) => c.id === post.campaign)?.posts?.find((p) => p.id === post.id);
      if (fresh?.derivedState === 'posted' || fresh?.status === 'posted') return;
      // For a held-post retry the "scheduler beat the click" story is impossible
      // (the scheduler skips a held post), so never blame it - say plainly that
      // the block was cleared but no lane fired, and point at Activity.
      setError(t(retryHeld ? 'postDetail.publishNow.nothingRanHeld' : 'postDetail.publishNow.nothingRan'));
      throw { canceled: true };
    }
    refresh();
  };
  // Attach the live URL to a post that was hand-published without one (the
  // copy-draft flow often records the permalink later). Server-side this is
  // markPosted's one legal re-entry for manual posts.
  const onAddExternalUrl = async () => {
    setError(null);
    const url = await prompt({
      title: t('postDetail.addExternalUrl.title'),
      body: t('postDetail.addExternalUrl.body'),
      placeholder: 'https://',
    });
    if (url === null) return;
    const clean = url.trim();
    if (!/^https?:\/\//.test(clean)) {
      setError(t('postDetail.addExternalUrl.invalid'));
      return;
    }
    try {
      await markPosted(post.campaign, post.id, clean);
    } catch (err) {
      setError(err?.message || t('postDetail.error.generic'));
      return;
    }
    refresh();
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
  // US-MEDIA-UP: swap the post's media file in place. VideoPicker emits the same
  // `${dir}/${file}` ref the Composer stores, so we write it as `path` and null
  // `file` to keep the reference single-valued (both are on the server's
  // owner-editable allow-list). An empty value clears the media. A stale rev is the
  // same ifRev conflict every detail write surfaces, not a new failure mode.
  const onChangeMedia = async (value) => {
    setError(null);
    try {
      await updatePost(post.campaign, post.id, post.rev, { path: value || null, file: null });
    } catch (err) {
      setError(err?.code === 'stale_write' ? t('composer.error.staleWrite') : (err?.message || t('postDetail.error.generic')));
    } finally {
      refresh();
    }
  };

  // An edited-since-approval post is approval:'approved' but needs a FRESH decision:
  // offer Approve (re-approve) again. Reject stays available so the owner can pull it.
  const canApprove = (post.approval !== 'approved' || post.editedSinceApproval) && post.derivedState !== 'posted';
  // Spec 12 review (finding #4): a POSTED post's editedSinceApproval flag is
  // publish-inert (the guardrail already holds - lanesOwed stays [] after an
  // edit, nothing re-fires) and canApprove above already excludes 'posted', so the
  // header's amber "Re-approve" pill can NEVER be cleared once a posted post is
  // edited via the widened "Open in editor" gate - permanent noise, not a signal.
  // Suppress the flag for the pill ONLY on a posted post; every non-posted post
  // keeps the real flag (and the gate it drives) untouched.
  const showEditedSinceApproval = post.derivedState !== 'posted' && post.editedSinceApproval;
  // Spec 48 R10 (V6): whether this project requires client sign-off, and the status
  // pill state clamped so a post awaiting sign-off never reads as overdue-red (the
  // clock rule, section 4.6); the ReviewStatusChip carries the awaiting/signed state.
  const { data: reviewConfig } = useConfig(true);
  const reviewRequired = Boolean(reviewConfig?.posting?.review?.required);
  const reviewPillState = post.reviewPending && (post.derivedState === 'overdue' || post.derivedState === 'publish-failed')
    ? null
    : post.derivedState;
  const canReject = post.approval !== 'rejected' && post.derivedState !== 'posted';
  const editable = post.derivedState !== 'posted';
  // Verify is meaningful once a post is handed off and past due (fired-assumed),
  // or anytime it already carries a verify block (so it can be re-checked).
  const canVerify = post.derivedState === 'fired-assumed' || Boolean(post.verify);
  // Force-publish is offered only for an approved post that has slipped past its
  // scheduled time. A healthy scheduler publishes it within a minute; this is the
  // manual "do it now" lever for the owner.
  // 'publish-failed' is 'overdue' plus a recorded reason (lib/plans.mjs), so it must keep
  // the publish-now control - retrying by hand is a recovery, and hiding the button on the
  // exact posts that failed would remove the way out.
  // Fix B7 (ux-audit dim-1 G1): a publish-HELD post (publishHold stamped after
  // MAX_PUBLISH_ATTEMPTS trailing failures, lib/publish-hold.mjs) owes NO lanes
  // (lib/scheduler.mjs lanesOwed), so a bare "Publish now" would fire nothing and
  // then blame the scheduler. The engine's documented recovery is a reschedule -
  // even to the SAME time (lib/writes.mjs reschedulePost deletes the hold) - so
  // for a held post the same primary slot becomes "Try again": clear the hold via
  // a same-time reschedule, then refire. When the failing lane is OFFLINE the
  // retry would only refail: drop the publish CTA entirely and let the failure
  // banner's mark-as-posted own the recovery (post it yourself is then true).
  const held = Boolean(post.publishHold);
  const heldLaneOffline = held && offlineLanes.includes(post.publishHold?.lane);
  // ux-audit dim-1 row 35 / R1a: a Radar reply whose external target 404'd is
  // TERMINAL (the engine stamped radarReplyState='target_gone' and lanesOwed
  // skips the lane forever - lib/scheduler.mjs). A "Publish now" here would fire
  // zero lanes and then read like a scheduler bug (the exact B7 class), so the
  // state's one recovery verb is the failure banner's "Discard draft" instead.
  const targetGone = Boolean(post.radarReplyTo) && post.radarReplyState === 'target_gone' && post.derivedState !== 'posted';
  // A lane halted by an account-level circuit breaker (X 402 credits, lib/state.mjs
  // recordLaneBlock) is dropped before dispatch (lib/scheduler.mjs), so a bare
  // "Publish now" would fire zero lanes and then read like a scheduler race (the B7
  // class). The failure banner's "Lane fortsetzen" (resumeLane) is the sole recovery -
  // mirrors postActions.canPublishNowPost. Change 3's lane_halted run row keeps the
  // planner run-now dialog + an overdue post on ANOTHER post's block honest too.
  const laneHalted = Boolean(post.lastFailure?.halted);
  const canPublishNow = (post.derivedState === 'overdue' || post.derivedState === 'publish-failed') && post.approval === 'approved' && !post.editedSinceApproval && !heldLaneOffline && !targetGone && !laneHalted;
  const retryHeld = canPublishNow && held;
  // The Comments thread panel (spec 02, Pattern P6) is offered on a POSTED post that
  // reached a comment-capable lane. Opening it pulls the comments on demand; the
  // reply loop is operator-in-the-loop (no auto-reply surface exists anywhere).
  const isPosted = post.status === 'posted' || post.derivedState === 'posted';
  const commentCapable = (post.platforms || []).some((p) => COMMENT_CAPABLE_PLATFORMS.has(p));
  const canComment = isPosted && commentCapable;
  // "Add to playlist" (spec 15, Pattern P3+P4+P9) is offered only once the video has
  // actually published (ytVideoId set) - hidden before that, like the other
  // publish-dependent actions (you cannot playlist a video that does not exist yet).
  const canPlaylist = (post.platforms || []).includes('youtube') && Boolean(post.ids?.ytVideoId);
  // "Send zap" (spec 20) is offered only once the nostr note has actually published
  // (nostrEventId set) - you cannot zap a note that does not exist yet.
  const canZap = (post.platforms || []).includes('nostr') && Boolean(post.ids?.nostrEventId);
  // Mastodon "Pin to profile"/"Unpin" (spec 31) is offered only once the status
  // has actually published (mastodonStatusId set) - hidden before that, mirrors
  // canZap/canPlaylist. follow/relay/lists are MCP-only, no GUI face (§6 of the
  // spec: not per-post, not connection config, not worth a new screen).
  const canMastodonPin = (post.platforms || []).includes('mastodon') && Boolean(post.ids?.mastodonStatusId);
  const mastodonPinned = post.ids?.mastodonPinned === true;
  // Edit-after-publish (spec 12): the lanes this post targeted that are BOTH
  // edit-capable (youtube/telegram/discord) AND already carry a minted id - the
  // owed set editPublished pushes to. Drives both the "Open in editor" reachability
  // for a posted post and the new "Edit published" push action.
  // Spec 12 review (finding #5): a poll's question/options are immutable once sent
  // on every edit-capable lane (Telegram/Discord 400 - no editable poll content) -
  // exclude it here so neither "Open in editor" nor "Edit published" dangles a
  // dead-end action; scripts/telegram-social.mjs and discord-social.mjs cmdEdit
  // structured-skip a poll too, so the UI and engine agree either way.
  const editableLanes = post.type === 'poll' ? [] : (post.platforms || []).filter((p) => EDIT_LANE_ID[p] && Boolean(post.ids?.[EDIT_LANE_ID[p]]));
  // Push the post's ALREADY-SAVED content (edited via "Open in editor" + Save, the
  // normal Composer/inline path) out to the already-minted object(s). Distinct
  // from re-publish: the object id/permalink never change. One upfront confirm
  // (danger:false - a metadata push, not a destructive action) names the lanes;
  // the server fails closed without confirm:true regardless.
  const onEditPublished = async () => {
    setError(null);
    const ok = await confirm({
      title: t('postDetail.editPublished.confirmTitle'),
      body: withClientLine(t('postDetail.editPublished.confirmBody', { lanes: editableLanes.join(', ') })),
      confirmLabel: t('postDetail.editPublished.confirmLabel'),
      danger: false,
    });
    if (!ok) throw { canceled: true };
    await editPublished(post.campaign, post.id);
    refresh();
  };
  // Discord guild scheduled events (spec 26): create a REAL guild event from the
  // post's dcEvent intent (authored in the Composer). Offered only when discord
  // is targeted AND a dcEvent intent exists; once dcEventId is set, the action
  // reads "Event created" and re-running it is a safe no-op (the engine GETs
  // the existing event rather than minting a second one).
  const discord = (post.platforms || []).includes('discord');
  const onDiscordEvent = async () => {
    setError(null);
    if (post.ids?.dcEventId) return; // idempotent no-op - the event already exists
    const ok = await confirm({
      title: t('postDetail.discordEvent.confirmTitle'),
      body: withClientLine(t('postDetail.discordEvent.confirmBody')),
      confirmLabel: t('postDetail.discordEvent.confirmLabel'),
      danger: false,
    });
    if (!ok) throw { canceled: true };
    await discordScheduleEvent(post.campaign, post.id);
    refresh();
  };
  // Toggle pin/unpin on the Mastodon profile (spec 31). IDEMPOTENT + reversible -
  // no confirm gate. A missing write:accounts scope flips the label to
  // "Authorize" (P9) rather than a transient error banner (mirrors ZapModal's
  // not_configured -> notConfigured pattern); any other failure surfaces via the
  // shared act() error banner like every other ⋯ menu action.
  const onMastodonPin = async () => {
    setError(null);
    setMastodonPinBusy(true);
    try {
      await mastodonPin(post.campaign, post.id, !mastodonPinned);
      setMastodonPinBlocked(false);
      setMastodonPinAnnounce(t('postDetail.pin.done'));
      refresh();
    } catch (err) {
      if (err?.code === 'not_configured') {
        setMastodonPinBlocked(true);
      } else {
        setMastodonPinBlocked(false);
        throw err;
      }
    } finally {
      setMastodonPinBusy(false);
    }
  };
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

  // One dominant state CTA (approval flows keep precedence); Save is the
  // permanent primary next to it. Everything destructive/less-common lives in
  // the ⋯ overflow.
  //
  // A post whose lane is not connected takes the HAND-OFF instead of Approve. Approving it
  // would do nothing: setApproval never checks connectivity, so the post would flip to
  // approved and then fail at publish forever. Offering the real action - take the text,
  // post it yourself - is the honest swap, and it is a swap, not an addition: the same slot,
  // one button, in the same place the eye already looks.
  const handOff = canApprove && offlineLanes.length > 0;
  const primary =
    canPublishNow ? 'publishNow'
    : handOff ? 'handOff'
    : canApprove ? 'approve'
    : canVerify ? 'verify'
    : null;

  // Step one of the hand-off: put the text on the clipboard and open the destination. Two
  // steps, ONE control - after the copy the same button becomes "mark as posted", because a
  // copy that leaves the operator hunting the ⋯ menu for the way to close the loop is the
  // dead end this is meant to remove. Copy first, so a clipboard refusal never opens a tab
  // and claims success it did not have. (The handedOff latch is declared with the hooks above,
  // so it stays above the early return.)
  // Where the text is supposed to GO. Built for every offline lane, not just the first:
  // auto-opening one of two destinations would silently pick a network for the operator,
  // so two openable targets means the panel shows both links and the button opens neither.
  // A lane with no honest URL still rides along ({ url: null }) so the Destination section
  // can NAME it instead of staying silent; only url-carrying targets are auto-openable.
  const handOffTargets = offlineLanes.map((p) => handOffTarget(post, p, accounts)).filter(Boolean);
  const openableTargets = handOffTargets.filter((tgt) => tgt.url);
  const onHandOff = async () => {
    // Copy the lane's EFFECTIVE text (the same override precedence the engines
    // publish: xCaption/redditText/tgCaption/... else caption), not the bare caption -
    // otherwise the clipboard can differ from what the approval gate approved (gap G5).
    // The clipboard holds ONE text: with several offline lanes that resolve
    // differently, the shared caption is the only honest common ground, and each
    // destination link already prefills its own lane's text via handOffTarget.
    const texts = [...new Set(offlineLanes.map((p) => effectiveLaneText(post, p)))];
    const text = texts.length === 1 ? texts[0] : (post.caption || '').trim();
    if (text) await navigator.clipboard.writeText(text);
    const target = post.radarReplyTo?.url
      || post.externalUrl
      || (openableTargets.length === 1 ? openableTargets[0].url : null);
    if (target) window.open(target, '_blank', 'noopener,noreferrer');
    setHandedOff(true);
  };

  // ⋯ overflow items (data, not markup) - filtered to what's valid for the state.
  // The full Composer stays reachable for heavy media work via "Open in editor".
  // R5/G4/L4: mark-as-posted becomes lane-scoped on a MIXED multi-lane post - one
  // "Mark <lane> posted" entry per still-owed lane, so recording one lane by hand
  // never closes the siblings pendpost still owes. A single-lane post keeps the one
  // whole-post entry. `pending` tier = the lane has no publish evidence yet (mirrors
  // pendingPlatforms below), and lanes that already carry a manual marker drop out.
  const isMixed = (post.platforms?.length || 0) > 1;
  const owedForMark = post.derivedState === 'posted'
    ? []
    : (post.platforms || []).filter((p) => PLATFORM_META[p]
        && platformState(post, p, t).tier === 'pending'
        && !(post.manualCompletions && post.manualCompletions[p]));
  const markEntries = post.derivedState === 'posted'
    ? []
    : isMixed
      ? owedForMark.map((lane) => ({ key: `mark-${lane}`, icon: CheckCheck, label: t('postDetail.action.markLaneIdle', { lane: PLATFORM_META[lane]?.label || lane }), run: () => onMarkPosted(lane) }))
      : [{ key: 'mark', icon: CheckCheck, label: t('postDetail.action.markIdle'), run: () => onMarkPosted() }];
  const menuItems = [
    // Reachable for a normal draft/scheduled post (editable) AND for a posted post
    // that reached at least one edit-capable lane (spec 12) - opens the
    // state-agnostic Composer either way.
    (editable || (post.derivedState === 'posted' && editableLanes.length)) && { key: 'edit', icon: Pencil, label: t('postDetail.action.openEditor'), run: () => onEdit(post) },
    canReject && { key: 'reject', icon: XCircle, label: t('approvals.action.reject'), danger: true, run: onReject },
    editable && post.executionMode === 'fully-scheduled' && { key: 'park', icon: PauseCircle, label: t('postDetail.action.parkIdle'), run: onPark },
    ...markEntries,
    canVerify && primary !== 'verify' && { key: 'verify', icon: ShieldCheck, label: t('postDetail.action.verifyIdle'), run: onVerify },
    // US-CMT-10: the Comments entry moved OUT of the overflow into a visible
    // control beside the panel below - a headline capability was hiding behind an
    // unlabeled menu whose other entry is Delete.
    canPlaylist && !showPlaylist && { key: 'playlist', icon: ListPlus, label: t('postDetail.action.addToPlaylist'), run: () => setShowPlaylist(true) },
    // Edit-after-publish (spec 12): push the content already saved via "Open in
    // editor" + Save to the already-minted object - never a re-publish.
    editableLanes.length > 0 && { key: 'editPublished', icon: RefreshCw, label: t('postDetail.action.editPublished'), run: onEditPublished },
    // Discord guild scheduled events (spec 26): offered once a dcEvent intent
    // exists; the label + run become an idempotent no-op once dcEventId is set.
    discord && post.dcEvent && { key: 'discordEvent', icon: CalendarPlus, label: post.ids?.dcEventId ? t('postDetail.discordEvent.created') : t('postDetail.action.discordEvent'), run: onDiscordEvent },
    // Mastodon pin toggle (spec 31): the ONE shipped GUI touch-point for the
    // social-graph & list actions - a genuinely post-scoped action on the object
    // the operator is already viewing (mirrors spec 15's playlist action).
    canMastodonPin && {
      key: 'mastodonPin',
      icon: Pin,
      label: mastodonPinBusy
        ? t('postDetail.action.pinning')
        : mastodonPinBlocked
          ? t('postDetail.pin.needsScope')
          : mastodonPinned
            ? t('postDetail.action.unpin')
            : t('postDetail.action.pin'),
      run: onMastodonPin,
    },
    canZap && !showZap && { key: 'zap', icon: Zap, label: t('postDetail.action.sendZap'), run: () => setShowZap(true) },
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
  // H6: the post's TYPE rides the delivery question, because the cloud cannot fire some
  // formats at all (an album, a nostr longform) whatever the lane's capability says.
  const deliveryOpts = { cloudOn, cloudLanes, type: post.type, localOnlyTypes };
  const localPending = pendingPlatforms.filter(
    (p) => effectiveDelivery(p, deliveryOpts) === 'local',
  );
  const cloudPending = pendingPlatforms.some(
    (p) => effectiveDelivery(p, deliveryOpts) === 'cloud',
  );
  // Whether the local answer is caused by the FORMAT rather than by the lane. It decides
  // WHICH sentence the existing line renders, never whether a line appears: the operator
  // otherwise reads "needs pendpost running: LinkedIn" and goes looking at the LinkedIn
  // connection, which is fine, and learns nothing about the real cause.
  const localBecauseFormat = Boolean(post.type) && (localOnlyTypes || []).includes(post.type)
    && localPending.some((p) => effectiveDelivery(p, { cloudOn, cloudLanes }) !== 'local');
  // An UNCONNECTED lane outranks both: "needs pendpost running" is true about the delivery
  // MECHANISM and silent about connectivity (effectiveDelivery never consults setup), so it
  // read identically whether the lane was live or had never been authorized - and it implies
  // that running pendpost is enough, which is exactly wrong. Same line, same place: the
  // section already speaks to delivery, so this relabels it rather than adding a badge.
  // US-PRE-10/11: an UNCONNECTED lane is a per-row "Blocked - connect <lane>"
  // fact (the broken-lanes error model: what, why, one recovering action) rather
  // than a summary sentence stacked over rows still reading "Pending" - the old
  // offline-tone sentence + the warning-list row said the same thing twice. The
  // summary hint now covers only the still-connected pending lanes.
  const connectedPending = pendingPlatforms.filter((p) => !offlineLanes.includes(p));
  const deliveryHint = !cloudResolved || connectedPending.length === 0
    ? null
    : localPending.filter((p) => !offlineLanes.includes(p)).length > 0
      ? { tone: 'local', platforms: localPending.filter((p) => !offlineLanes.includes(p)), becauseFormat: localBecauseFormat }
      : { tone: 'auto', viaCloud: cloudPending };

  // Live action bundle for the keyboard listener (read via ref, never stale).
  kbRef.current = { canApprove, canReject, prevPost, nextPost, onApprove, onReject, goPrev, goNext, act };

  // Per-field platform-icon rule: show icons only where a field diverges from
  // "every targeted platform" (redundant on a single-platform post, or on a field
  // all networks share), so a multi-platform post reads exactly what each network
  // posts without noise. Caption-override fields carry a text hint - the set is
  // the shared OVERRIDE_FIELD map (lib/format.js, derived from
  // LANE_TEXT_PRECEDENCE), so B1's tgCaption/dcCaption/ttCaption/redditText/
  // pinDescription hint exactly like xCaption. pinTitle is deliberately absent:
  // it shadows the title, not the caption, so the caption hint would lie.
  const targetCount = post.platforms.length;
  const OVERRIDE_KEYS = new Set(Object.values(OVERRIDE_FIELD));
  // Editable post: show every relevant field (empty ones are there to fill in).
  // Read-only (posted) post: hide the empty ones - a review of what actually
  // published should not carry blank "Not set" rows for fields left unused.
  // US-PRE-12: on a plain LinkedIn text post the article-card decorations
  // (Title / Link description) are relevant only once the post IS an article
  // (a link exists) - until then an empty "Title: Not set" row is an irrelevant
  // field on a post that has neither (canon: no irrelevant fields). Authoring an
  // article from scratch stays in the Composer (Open in editor), the house rule.
  // Lanes that genuinely require a title (youtube/blog/nostr-longform) keep it.
  const liArticleOnlyKeys = new Set(['title', 'liDescription']);
  const titleRequiredLane = post.platforms.some((p) => ['youtube', 'wordpress', 'ghost', 'pinterest'].includes(p)) || post.type === 'nostr-longform';
  const plainLiText = post.type === 'text' && post.platforms.includes('linkedin') && !String(post.link || '').trim() && !titleRequiredLane;
  const visibleContentFields = (editable
    ? contentFields
    : contentFields.filter((f) => String(drafts[f.key] ?? '').trim()))
    .filter((f) => !(plainLiText && liArticleOnlyKeys.has(f.key) && !String(drafts[f.key] ?? '').trim()));

  // The platform chips offer connected + enabled + not-skipped lanes plus any
  // lane the post already targets (a real target is never silently dropped) -
  // the Composer's pickerPlatforms rule. The union is built from the post's ORIGINAL
  // targets, never the live draft: derived from the draft, deselecting a targeted but
  // unconnected lane (the hand-off case) removed it from both sets, so the chip
  // unrendered on the first click with no way to re-select it. Stable set = deselect
  // un-highlights, the chip stays, the toggle stays reversible.
  const pickerPlatforms = !accounts
    ? PLATFORMS
    : PLATFORMS.filter((p) => new Set([...visiblePlatforms(accounts, posting), ...(post.platforms || [])]).has(p));

  // The destination pill: a button-shaped, brand-tinted, content-width control that
  // collapses the destination NAME and its open action into one element. Shared by the
  // hand-off targets and the Radar reply's open-thread link (one design language). The
  // muted variant carries a url-less destination; the amber variant carries the fix.
  const DEST_PILL = 'inline-flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-bold ring-1 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand';
  const DEST_PILL_BRAND = `${DEST_PILL} bg-brand/10 text-brand ring-brand/30 hover:bg-brand/20 dark:bg-brand-light/10 dark:text-brand-light dark:ring-brand-light/30 dark:hover:bg-brand-light/20`;

  // The scrollable body content shared by the two-column and single-column layouts.
  const bodyLeft = (
    <>
      {/* WHY IT DID NOT PUBLISH, above everything. The reason has always existed - the
          platform's own words, cached in state.cloudFailures or the post's attempt log -
          and until now no surface read either one: a stuck post showed a red "Overdue"
          pill, which tells the owner pendpost was not running and sends them to start a
          scheduler that is already running. Three answers in one block: what happened
          (the lane refused it), why (the platform's own sentence, quoted rather than
          paraphrased into something less true), and the one action that gets out of it. */}
      {post.lastFailure || targetGone ? (
        <div role="alert" className="space-y-2 rounded-xl bg-red-500/10 px-3 py-2.5 ring-1 ring-red-500/25">
          <p className="flex items-start gap-1.5 text-xs font-bold text-red-700 dark:text-red-300">
            <ShieldX size={13} aria-hidden="true" className="mt-px shrink-0" />
            {/* target_gone outranks the generic refusal title: the lane did not merely
                refuse this reply - the thread it answers no longer exists, and that is
                the fact the operator must act on (row 35). */}
            {targetGone
              ? t('postDetail.failure.targetGoneTitle')
              : t('postDetail.failure.title', { lane: PLATFORM_META[post.lastFailure?.lane]?.label || post.lastFailure?.lane || t('postDetail.failure.laneUnknown') })}
            {/* WHEN it failed, or a day-old refusal reads as breaking news: the banner
                shows the LAST recorded failure, which for a rescheduled post can be from
                before the fix that rescued it. Same fmtRelative idiom as the header. */}
            {post.lastFailure?.at ? (
              <span className="mt-px shrink-0 font-normal opacity-70">{fmtRelative(post.lastFailure.at)}</span>
            ) : null}
          </p>
          {post.lastFailure?.message ? (
            <p className="text-[11px] text-red-700/90 dark:text-red-300/80">{post.lastFailure.message}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 text-[11px] text-zinc-600 dark:text-zinc-300">
              {/* Fix B7: honest states, one line each. target_gone: the reply has no
                  destination anymore and nothing will retry - never "tries again on
                  its own" (a lie: lanesOwed skips the lane) and never "post it
                  yourself" (there is nowhere to post it). Held with a working lane:
                  the footer's "Try again" is the recovery - name it, and do NOT pair it
                  with "post it yourself" (a contradiction with a live publish button).
                  Terminal without that retry (cloud cap spent, failing lane offline):
                  the way out really is the owner's hands. Still retrying: say so. */}
              {targetGone ? t('postDetail.failure.targetGone')
                : post.lastFailure.halted ? t('postDetail.failure.creditsHalted')
                : retryHeld ? t('postDetail.failure.heldRetry')
                : post.lastFailure.terminal ? t('postDetail.failure.stopped')
                : t('postDetail.failure.retrying')}
            </p>
            {/* The state's ONE recovery verb, on the banner (never an overflow hunt).
                target_gone: the draft has nowhere to go - discard it (the existing
                delete flow with its confirms). Otherwise TERMINAL ONLY, and only when
                no automatic retry exists (retryHeld posts recover via the footer's
                primary instead): the re-fire budget is spent, so the way out is the
                owner's hands - post it where it lives, then record that. */}
            {targetGone ? (
              <ActionButton
                variant="danger"
                icon={Trash2}
                labels={{ idle: t('postDetail.failure.discardIdle'), loading: t('postDetail.failure.discardLoading'), success: t('postDetail.failure.discardSuccess'), error: t('postDetail.error.generic') }}
                onAction={onDelete}
                onError={setError}
              />
            ) : post.lastFailure.halted ? (
              /* The lane is circuit-broken (e.g. X 402 credits depleted). No per-post
                 verb recovers it - the operator tops up the account (portal link, single-
                 sourced from the setup payload) and then resumes the whole lane, the SAME
                 lane-resume the readiness strip runs. */
              <>
                {haltPortalUrl ? (
                  <a
                    href={haltPortalUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 rounded text-[11px] font-bold text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light"
                  >
                    <ExternalLink size={11} aria-hidden="true" /> {t('action.topUpCredits')}
                  </a>
                ) : null}
                <ActionButton
                  variant="subtle"
                  icon={PlugZap}
                  labels={{ idle: t('readiness.resumeLane'), loading: t('postDetail.action.markLoading'), success: t('postDetail.action.markSuccess'), error: t('postDetail.error.generic') }}
                  onAction={async () => {
                    // Consume the recheck signal: resumeLane clears the block, re-fires
                    // the lane's due posts, and reports whether credits are back. If the
                    // re-fire hit the same 402 the block re-armed (stillDepleted) - say so
                    // instead of flashing success, or the operator reads "resumed" while
                    // the post is still halted (the exact dishonest signal this avoids).
                    const r = await resumeLane(post.lastFailure.lane);
                    await queryClient.invalidateQueries({ queryKey: ['health'] });
                    await queryClient.invalidateQueries({ queryKey: ['pendpost-health'] });
                    await queryClient.invalidateQueries({ queryKey: ['plans'] });
                    if (r?.stillDepleted) {
                      setError(t('postDetail.resume.stillDepleted'));
                      throw { canceled: true }; // no success flash; the banner carries the truth
                    }
                  }}
                  onError={setError}
                />
              </>
            ) : post.lastFailure.terminal && !retryHeld ? (
              <ActionButton
                variant="subtle"
                icon={CheckCheck}
                labels={{ idle: (isMixed && post.lastFailure.lane) ? t('postDetail.action.markLaneIdle', { lane: PLATFORM_META[post.lastFailure.lane]?.label || post.lastFailure.lane }) : t('postDetail.action.markIdle'), loading: t('postDetail.action.markLoading'), success: t('postDetail.action.markSuccess'), error: t('postDetail.error.generic') }}
                onAction={() => onMarkPosted((isMixed && post.lastFailure.lane) ? post.lastFailure.lane : undefined)}
                onError={setError}
              />
            ) : null}
          </div>
        </div>
      ) : null}
      {/* WHERE THIS POST GOES, first. The one post type whose whole meaning lives
          somewhere else (a Radar reply) and the one the operator must publish by hand
          (a hand-off lane) share a failure mode: the destination was invisible or
          buried, so the screen asked for a decision about a place it never named.
          The affordance is ONE content-width pill button per destination (icon +
          "Post it on r/mcp" + external glyph) - name and link collapsed into one
          control, never a full-width row with a small link exiled to the far edge.
          The reply quote box keeps its width (the excerpt earns it) but its open
          link wears the same pill: one visual answer to "open this elsewhere". */}
      {post.radarReplyTo ? (
        <Section title={t('postDetail.replyTo.title')}>
          <div className={`rounded-xl px-3 py-2 ${INNER_SURFACE}`}>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {PLATFORM_META[post.radarReplyTo.source] ? (
                (() => { const M = PLATFORM_META[post.radarReplyTo.source]; return <M.Icon size={13} className={M.color} aria-hidden="true" />; })()
              ) : null}
              {post.radarReplyTo.author ? <span className="font-bold">{post.radarReplyTo.author}</span> : null}
              {post.radarReplyTo.community ? <span className="text-zinc-500 dark:text-zinc-400">{post.radarReplyTo.community}</span> : null}
              {/* A reply queued before the context snapshot existed knows only its URL. Show
                  it: the row would otherwise be a lone glyph and a link floating apart, and
                  the address is the one true thing we have. Never a stand-in for the quote. */}
              {!post.radarReplyTo.author && !post.radarReplyTo.community ? (
                <span className="truncate text-zinc-500 dark:text-zinc-400">{post.radarReplyTo.url.replace(/^https?:\/\//, '')}</span>
              ) : null}
              {/* No dead end: the thread opens where it lives. Always rendered, because a
                  reply queued before the context snapshot existed has the link and nothing
                  else - and a link is honest where an invented quote would not be. */}
              <a href={mastodonThreadUrl(post.radarReplyTo, accounts)} target="_blank" rel="noreferrer" className={`ml-auto ${DEST_PILL_BRAND}`}>
                {t('postDetail.replyTo.open')}
                <ExternalLink size={11} aria-hidden="true" />
              </a>
            </div>
            {post.radarReplyTo.excerpt ? (
              <p className="mt-1.5 whitespace-pre-wrap text-sm text-zinc-600 dark:text-zinc-300">{post.radarReplyTo.excerpt}</p>
            ) : null}
          </div>
        </Section>
      ) : handOffTargets.length > 0 && post.derivedState !== 'posted' ? (
        <div className="space-y-1.5">
          <span className={EYEBROW}>{t('postDetail.handOff.destinationTitle')}</span>
          <div className="flex flex-wrap items-center gap-2">
            {handOffTargets.map((tgt) => {
              const M = PLATFORM_META[tgt.platform];
              const name = tgt.label || M?.label || tgt.platform;
              if (tgt.url) {
                return (
                  <a key={tgt.platform} href={tgt.url} target="_blank" rel="noreferrer" className={DEST_PILL_BRAND}>
                    {M ? <M.Icon size={13} aria-hidden="true" /> : null}
                    {t(tgt.truncated ? 'postDetail.handOff.targetPaste' : 'postDetail.handOff.target', { target: name })}
                    <ExternalLink size={11} aria-hidden="true" />
                  </a>
                );
              }
              if (tgt.reason === 'noSubreddit') {
                /* The three answers in one control: no subreddit is set (what), so no
                   submit link can be built (why), choose one in the editor (way out). */
                return (
                  <button
                    key={tgt.platform}
                    type="button"
                    onClick={() => onEdit(post)}
                    className={`${DEST_PILL} bg-amber-500/10 text-amber-700 ring-amber-500/30 hover:bg-amber-500/20 dark:text-amber-300`}
                  >
                    {M ? <M.Icon size={13} aria-hidden="true" /> : null}
                    {t('postDetail.handOff.noSubreddit')}
                  </button>
                );
              }
              return (
                <span key={tgt.platform} className={`${DEST_PILL} text-zinc-500 ring-zinc-900/10 dark:text-zinc-400 dark:ring-white/10`}>
                  {M ? <M.Icon size={13} className={M.color} aria-hidden="true" /> : null}
                  {t('postDetail.handOff.destinationOnly', { target: name })}
                </span>
              );
            })}
          </div>
        </div>
      ) : null}
      {/* Quick edit (single edit surface): platforms + format + schedule live
          inline, staged into the same dirty->Save model as the text fields, so
          routine changes never need the full Composer. */}
      {editable ? (
        <section className="space-y-4">
          <fieldset className="space-y-1.5">
            <legend className={EYEBROW}>{t('composer.field.platforms')}</legend>
            <div className="flex flex-wrap gap-1.5">
              {pickerPlatforms.map((p) => {
                const meta = PLATFORM_META[p];
                if (!meta) return null;
                const active = platformsDraft.includes(p);
                const { Icon } = meta;
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setPlatformsDraft((prev) => (prev.includes(p) ? prev.filter((q) => q !== p) : PLATFORMS.filter((q) => prev.includes(q) || q === p)))}
                    aria-pressed={active}
                    className={`flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs font-bold ring-1 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                      active
                        ? 'bg-brand/10 text-brand ring-brand/30 dark:bg-brand-light/10 dark:text-brand-light dark:ring-brand-light/30'
                        : 'text-zinc-500 ring-zinc-900/10 hover:bg-zinc-200/40 dark:text-zinc-400 dark:ring-white/10 dark:hover:bg-zinc-800/40'
                    }`}
                  >
                    <Icon size={13} className={active ? meta.color : ''} aria-hidden="true" />
                    {meta.label}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="detail-type">{t('composer.field.format')}</label>
              {/* A12: offer only the formats the chosen lane(s) can publish (union
                  across platforms; full list when none) - a text lane never lists
                  Reel/Story. The current value stays listed even if now invalid, so
                  a platform change never silently rewrites the format. */}
              <select id="detail-type" value={typeDraft} onChange={(e) => setTypeDraft(e.target.value)} className={`${FIELD} w-full h-10`}>
                {TYPES.filter((ty) => ty === typeDraft || (platformsDraft.length ? platformsDraft.some((p) => formatsForPlatform(p).includes(ty)) : true)).map((ty) => (
                  <option key={ty} value={ty}>{typeOptionLabel(t, platformsDraft, ty)}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className={EYEBROW}>{t('composer.field.schedule')}</label>
              <DateTimePicker value={scheduleDraft} onChange={setScheduleDraft} disablePast triggerClassName={`${FIELD} w-full h-10`} />
            </div>
          </div>
        </section>
      ) : null}

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

      {/* The flair picker, IN the detail (canon: edit in place; prevent at the control).
          The Composer's picker verbatim - same hook, same four states, same locale keys -
          staged into the shared dirty->Save model like every other quick-edit field. The
          blockers panel's "Choose a flair" action focuses this select, so the advisory,
          the control, and the save are one loop that never leaves the modal. */}
      {/* US-PRE-11: without a subreddit there are no flairs to pick, and the old
          placeholder only told the operator to go set one "in the editor" while
          they stood in the editor - so the whole section stays hidden until a
          subreddit exists. */}
      {editable && redditTargeted && flairSubreddit ? (
        <div className="space-y-1.5">
          <span className={EYEBROW}>{t('composer.field.redditFlair')}</span>
          {redditFlairsLoading ? (
            <select aria-label={t('composer.field.redditFlair')} disabled className={`${FIELD} w-full`}>
              <option>{t('composer.reddit.flairLoading')}</option>
            </select>
          ) : redditFlairsUnavailable ? (
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.reddit.flairUnavailable', { sub: flairSubreddit })}</p>
          ) : redditFlairs.length ? (
            <select
              ref={flairSelectRef}
              aria-label={t('composer.field.redditFlair')}
              value={flairDraft.id}
              onChange={(e) => {
                const picked = redditFlairs.find((f) => f.id === e.target.value);
                // flair_text only rides an EDITABLE template (Reddit ignores it otherwise).
                setFlairDraft({ id: e.target.value, text: picked && picked.editable ? (picked.text || '') : '' });
              }}
              className={`${FIELD} w-full`}
            >
              <option value="">{t('composer.reddit.flairNone')}</option>
              {redditFlairs.map((f) => (
                <option key={f.id} value={f.id}>{f.text || f.id}</option>
              ))}
            </select>
          ) : (
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.reddit.flairEmpty', { sub: flairSubreddit })}</p>
          )}
        </div>
      ) : null}

      {/* The read-only flair chip yields to the picker above - one answer per job. */}
      {contentExtras.length ? <PostExtras post={post} extras={editable && redditTargeted ? contentExtras.filter((e) => e.key !== 'redditFlairId') : contentExtras} t={t} /> : null}


      <Section title={t('postDetail.section.delivery')}>
        {/* US-PRE-10: the summary line covers only the still-CONNECTED pending
            lanes (their delivery mechanism). A disconnected lane speaks for itself
            in its own row below - blocked label + the one recovering action -
            instead of a second sentence up here saying the same thing. */}
        {deliveryHint ? (
          <p className={`mb-1.5 flex items-center gap-1.5 text-[11px] ${deliveryHint.tone === 'local' ? 'text-amber-700 dark:text-amber-300' : 'text-zinc-500 dark:text-zinc-400'}`}>
            {deliveryHint.tone === 'local'
              ? <Power size={11} aria-hidden="true" className="shrink-0" />
              : deliveryHint.viaCloud
                ? <CloudIcon size={11} aria-hidden="true" className="shrink-0" />
                : <CalendarClock size={11} aria-hidden="true" className="shrink-0" />}
            {deliveryHint.tone === 'local'
              ? t(deliveryHint.becauseFormat ? 'postDetail.delivery.needsLocalFormat' : 'postDetail.delivery.needsLocal', {
                platforms: deliveryHint.platforms.map((p) => PLATFORM_META[p].label).join(', '),
                format: t(`type.${post.type}`),
              })
              : t('postDetail.delivery.autoAll')}
          </p>
        ) : null}
        <ul className="space-y-1.5">
          {post.platforms.map((p) => {
            const meta = PLATFORM_META[p];
            const state = platformState(post, p, t);
            if (!meta) return null;
            // US-PRE-10: a lane that cannot publish never says "Pending". An
            // unconnected lane's row reads the blocked-class label with the one
            // recovering action (the broken-lanes error model), so the row and
            // the truth agree.
            const blocked = state.tier === 'pending' && offlineLanes.includes(p);
            const { Icon } = meta;
            const verify = platformVerify(post, p, t);
            const stateCls = state.tier === 'done'
              ? 'text-emerald-600 dark:text-emerald-300'
              : state.tier === 'warn' || blocked
                ? 'text-amber-700 dark:text-amber-300'
                : 'text-zinc-500 dark:text-zinc-400';
            const verifyCls = verify?.tone === 'ok'
              ? 'text-emerald-600 dark:text-emerald-300'
              : verify?.tone === 'err'
                ? 'text-red-600 dark:text-red-300'
                : 'text-amber-700 dark:text-amber-300';
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
                  <span className="flex-1 text-sm font-bold">
                    {meta.label}
                    {/* WHICH account this lane publishes to, at the moment of the
                        decision. Always rendered when it is known, never folded into
                        deliveryHint above: that hint is null for every already-approved,
                        fully-handed-off post, which is exactly when it matters. For a
                        published post the platform's OWN word wins (the verify read-back
                        reports the account that actually holds the media), because that
                        is evidence rather than intent. */}
                    {laneAccount(p) ? (
                      <span className="ml-1.5 font-normal text-[11px] text-zinc-500 dark:text-zinc-400">{laneAccount(p)}</span>
                    ) : null}
                  </span>
                  <span className={`flex items-center gap-1 text-[11px] ${stateCls}`}>
                    {state.tier === 'done' ? <CheckCircle2 size={11} aria-hidden="true" /> : null}
                    {blocked ? <PlugZap size={11} aria-hidden="true" /> : null}
                    {state.tier === 'done' ? <span className="sr-only">{t('postDetail.platform.publishedSr')}: </span> : null}
                    {state.tier === 'warn' ? <span className="sr-only">{t('postDetail.platform.warnSr')}: </span> : null}
                    {blocked ? t('postDetail.delivery.blocked', { platform: meta.label }) : state.text}
                  </span>
                  {/* One control per job: the wrench yields when the
                      Before-publishing card already offers the labelled
                      "Set up <lane>" link for this same lane. */}
                  {blocked && typeof onNavigate === 'function' && !setupLinkOffered(platformValidate, p, onNavigate) ? (
                    <Tip label={t('approvals.card.connectTip', { platforms: meta.label })}>
                      <button
                        type="button"
                        onClick={() => onNavigate('setup', p)}
                        aria-label={t('approvals.card.connectTip', { platforms: meta.label })}
                        className="shrink-0 rounded-lg p-1 text-zinc-500 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:bg-zinc-700/60"
                      >
                        <Wrench size={12} aria-hidden="true" />
                      </button>
                    </Tip>
                  ) : null}
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
                    {/* Measured post-publish: the rendition Instagram actually serves
                        (media_url ffprobe). Self-hides for non-IG lanes and unmeasured posts. */}
                    {p === 'instagram' ? <ServedBadge served={post.verify?.platforms?.instagram?.served} /> : null}
                  </div>
                ) : null}
                {/* dim-3 M5: this post's stored metric chips, beside its verify
                    chips - measuring happens where approving/verifying already do.
                    Reuses the Insights MetricChips (primary + "+N", delta badges),
                    so the two panels never fork a renderer. A mock-lane row carries
                    a tiny badge (consuming the orphaned per-item `mode` field) so
                    fabricated mock numbers stop looking identical to live ones. */}
                {metricsByPlatform[p] ? (
                  <div className="mt-1.5 flex items-center gap-1.5 pl-[25px]">
                    {metricsByPlatform[p].mode === 'mock' ? (
                      <span className="inline-flex shrink-0 items-center rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-bold text-amber-700 ring-1 ring-amber-500/30 dark:text-amber-300" title={t('postDetail.metrics.mockTip')}>
                        {t('postDetail.metrics.mock')}
                      </span>
                    ) : null}
                    <MetricChips entry={metricsByPlatform[p]} metricLabel={metricLabel} t={t} />
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
        {/* CI-1: a posted post is already live - the pre-publish "Before publishing"
            advisory (platform_validate/presubmit/media-spec problems) is noise once
            there is nothing left to fix before a publish that already happened.
            Suppressed for posted only; every non-posted state keeps the full panel. */}
        {!isPosted ? (
          <PlatformBlockers platformValidate={platformValidate} presubmit={presubmitCheck} validateMedia={validateMedia} approval={post.approval} editedSinceApproval={post.editedSinceApproval} showApproval={false} onNavigate={onNavigate} onFix={editable && redditTargeted ? () => { const el = flairSelectRef.current; if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); } else { onEdit(post); } } : undefined} className="mt-1.5" />
        ) : null}
      </Section>

      {/* The inbound-engagement (inbox) thread panel (spec 02, Pattern P6).
          US-CMT-10: the entry point is a VISIBLE quiet control here in the body
          (a headline capability, not an overflow secret); pull-on-demand stays -
          the panel and its comment read only load once opened. No cached count
          exists on the post, so the label carries no number until the panel's
          own read supplies the thread (count absent, per the story's AC). */}
      {canComment && !showComments ? (
        <button
          type="button"
          onClick={() => setShowComments(true)}
          className={`flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs font-bold ${INNER_SURFACE} transition hover:ring-brand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`}
        >
          <MessageSquare size={14} aria-hidden="true" className="text-zinc-500 dark:text-zinc-400" />
          {t('postDetail.menu.comments')}
          <ChevronRight size={13} aria-hidden="true" className="ml-auto text-zinc-500 dark:text-zinc-400" />
        </button>
      ) : null}
      {canComment && showComments ? (
        <CommentsPanel campaign={post.campaign} postId={post.id} enabled={showComments} />
      ) : null}

      {/* "Add to playlist" picker (spec 15, Pattern P3+P4+P9): opened from the ⋯ menu
          on a published YouTube post. Pull-on-demand; create+add reuses the SAME
          mutation -> invalidateQueries(['plans']) path as every other write. */}
      {canPlaylist && showPlaylist ? (
        <PlaylistPanel campaign={post.campaign} postId={post.id} enabled={showPlaylist} />
      ) : null}

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
            {/* The glyph follows the actual file, not the post type: a JPEG on a
                media-backed post used to read FileVideo regardless. */}
            <IconBadge
              icon={post.media.exists ? (isImageMedia(post.media) ? FileImage : FileVideo) : FileX2}
              tone={post.media.exists ? 'ok' : 'warn'}
              label={post.media.exists ? t('postDetail.file.present') : t('postDetail.file.missing')}
            />
          </div>
        </div>
      ) : null}
      {/* Spec 05: the album's slide strip used to live HERE, as a read-only grid that
          was blind to the 0-slide and 1-slide cases and sat in the left column while the
          media pane showed a red "no media" error. Both are now the ONE album render in
          the media pane (ui/CarouselPreview), where the strip is the viewer's navigation
          rather than a second, disconnected picture of the same slides. */}
    </>
  );

  // The media column (two-column) or inline block (single-column): the preview
  // plus, for a VIDEO-backed editable post, the cover override editor.
  //
  // The cover editor is video-only, and gating it on the media (isImageMedia) rather
  // than on post.type is what keeps it honest: PostPreview one line up branches on
  // exactly the same helper, so the editor can never appear over an <img>. On a still
  // image the whole Section was not just mislabeled, it was dead: no <video> mounts,
  // so coverSec stayed at its initial 0 (hence the "0.0s als Titelbild" label) and
  // onCoverFrame threw the canceled sentinel that ActionButton swallows silently. Its
  // hint ("scrub the video...") named a video that was not there, and no lane can take
  // a cover for a feed image anyway (lib/covers.mjs coverApplicability).
  const mediaBlock = (
    <>
      {/* onEdit is what turns the album's empty/under-count/missing-slide states from
          dead ends into recoverable ones: the same "open in the editor" action the ⋯ menu
          offers, present as a control inside the state that needs it. */}
      <PostPreview key={`${post.campaign}-${post.id}`} post={post} videoRef={videoRef} onEdit={editable ? () => onEdit(post) : undefined} />
      {/* US-MEDIA-UP: swap the underlying media right here - upload, drop, or pick a
          library file - the same VideoPicker the editor uses, so a fresh clip no
          longer needs an "open in editor" detour. Single-media only (a carousel edits
          its slides in the Composer); the cover editor below stays a separate box. */}
      {editable && postNeedsMedia(post) && post.type !== 'carousel' ? (
        <ChangeMediaField post={post} onChange={onChangeMedia} />
      ) : null}
      {post.media.url && editable && !isImageMedia(post.media) ? (
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
            {gridCropInfo(post).cropped ? (
              <p className="flex items-start gap-1.5 rounded-lg bg-amber-500/10 px-2 py-1.5 text-[10px] text-amber-700 dark:text-amber-300">
                <Crop size={12} className="mt-px shrink-0" aria-hidden="true" />
                <span>{t('postDetail.cover.gridHint', { platforms: gridCropInfo(post).platforms.map((x) => PLATFORM_META[x.platform]?.label || x.platform).join(', ') })}</span>
              </p>
            ) : null}
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

  // A post with a preview (media, link card, or article card) keeps the two-column
  // shape; a pure-text post has nothing to preview, so its body goes single-column
  // full-width instead of reserving ~38% for an empty tile.
  const hasPreview = !isText || textHasCard;

  return (
    <>
    {/* Send-zap modal (spec 20): a portal Modal layered above the PostDetail dialog,
        opened from the ⋯ menu on a published nostr note. */}
    {canZap && showZap ? (
      <ZapModal campaign={post.campaign} postId={post.id} onClose={() => setShowZap(false)} />
    ) : null}
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
              {/* V6: a post awaiting client sign-off never reads as overdue-red (spec
                  48 section 4.6); the awaiting chip carries the honest state. */}
              {reviewPillState ? <StatusPill state={reviewPillState} short /> : null}
              <ApprovalPill approval={post.approval} editedSinceApproval={showEditedSinceApproval} handOff={handOff} />
              <ReviewStatusChip post={post} />
              <span className="flex items-center gap-1">
                {post.platforms.map((p) => {
                  const meta = PLATFORM_META[p];
                  return meta ? <meta.Icon key={p} size={14} className={meta.color} aria-hidden="true" /> : null;
                })}
              </span>
              {/* Once a post is live the ACTUAL publish time is the fact that
                  matters; the scheduled time is history. One line, never both. */}
              <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                {post.postedAt
                  ? t('postDetail.postedAt', { ts: fmtFull(post.postedAt) })
                  : post.scheduledAt ? `${fmtRelative(post.scheduledAt)} · ${fmtTime(post.scheduledAt)}` : t('approvals.card.noSchedule')}
              </span>
              {/* No type here: the Format select a few lines down is the editable,
                  authoritative one, so repeating it in the header was pure duplication.
                  The approval rows DO carry it (there is no select to read there). */}
              <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
                {t('approvals.card.campaignMeta', { campaign: campaignBaseLabel(post.campaign), id: post.id })}
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
                  <span className="text-amber-700 dark:text-amber-300">{t('postDetail.thread.parentMissing', { id: post.xReplyTo })}</span>
                )}
              </p>
            ) : null}
            {post.publishedVia === 'manual' ? (
              <p className="flex items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                {t('postDetail.postedExternally')}
                {/* A hand-published post without a recorded permalink can get one
                    after the fact - without this, the detail stays linkless forever. */}
                {!post.externalUrl ? (
                  <button
                    type="button"
                    onClick={onAddExternalUrl}
                    className="rounded text-brand underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light"
                  >
                    {t('postDetail.addExternalUrl')}
                  </button>
                ) : null}
              </p>
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
                <span role="status" aria-live="polite" className="whitespace-nowrap text-[11px] font-bold tabular-nums text-zinc-500 dark:text-zinc-400">
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
      {/* Mastodon pin toggle (spec 31): a non-visual confirmation for screen-reader
          users, mirroring the verify announce region above (post.verify.at). */}
      {mastodonPinAnnounce ? (
        <p role="status" aria-live="polite" className="sr-only">{mastodonPinAnnounce}</p>
      ) : null}

      {/* Scrolling body: the ONLY overflow-y-auto child (min-h-0 or the footer
          collapses). A post WITH a preview uses the two-column 62/38 golden grid at
          lg - caption + platforms left, the preview (media / link-card / article-
          card) sticky on the right, stacking below lg. A pure-text post has no
          preview, so it drops to a single full-width column. px-1/-mx-1 keeps 4px of
          slack inside the clip box so the 2px focus ring on the fields renders fully
          instead of being cut by overflow-x-hidden. */}
      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-soft px-1">
        {hasPreview ? (
          <div className="flex flex-col gap-5 lg:grid lg:grid-cols-[minmax(0,1.62fr)_minmax(0,1fr)] lg:gap-6">
            <div className="min-w-0 space-y-5">{bodyLeft}</div>
            <div className="min-w-0 space-y-4 lg:sticky lg:top-0 lg:self-start">{mediaBlock}</div>
          </div>
        ) : (
          <div className="min-w-0 space-y-5">{bodyLeft}</div>
        )}
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

          {/* Approval-flow CTAs keep precedence as the state primary ... */}
          {primary === 'approve' ? (
            <ActionButton
              variant="success"
              size="md"
              icon={reviewRequired ? Send : CheckCircle2}
              labels={reviewRequired
                // O2: with review.required on, the operator's approve relabels to send
                // for sign-off; the write is unchanged (onApprove -> approvePost).
                ? { idle: t('review.action.sendForSignoff'), loading: t('review.action.sending'), success: t('review.action.sent'), error: t('approvals.action.error') }
                : { idle: t('approvals.action.approve'), loading: t('approvals.action.approving'), success: t('approvals.action.approved'), error: t('approvals.action.error') }}
              onAction={onApprove}
              onError={setError}
            />
          ) : null}
          {/* The lane is not connected, so pendpost cannot post this - the operator can.
              Sky (never emerald): this is not a green "done", it is work handed back. */}
          {/* Distinct keys, deliberately: without them React reconciles the two steps as ONE
              ActionButton instance and the copy's lingering success state paints itself onto
              step two, so the button reads "posted" before the operator has posted anything.
              A remount resets the status with the label. */}
          {primary === 'handOff' ? (
            handedOff ? (
              <ActionButton key="handoff-done" variant="manual" size="md" icon={CheckCheck} labels={{ idle: t('postDetail.handOff.markIdle'), loading: t('postDetail.action.markLoading'), success: t('postDetail.action.markSuccess'), error: t('postDetail.error.generic') }} onAction={onMarkPosted} onError={setError} />
            ) : (
              <ActionButton key="handoff-copy" variant="manual" size="md" icon={ClipboardCopy} labels={{ idle: t('postDetail.handOff.copyIdle'), loading: t('postDetail.handOff.copyLoading'), success: t('postDetail.handOff.copySuccess'), error: t('postDetail.error.generic') }} onAction={onHandOff} onError={setError} />
            )
          ) : null}
          {/* Fix B7: the SAME slot, relabeled per failure class - a held post's click
              must clear the hold first (onPublishNow does both), so calling it
              "Publish now" would promise a plain publish it cannot deliver. */}
          {primary === 'publishNow' ? (
            retryHeld ? (
              <Tip label={t('postDetail.action.tryAgainTip')}>
                <ActionButton key="publish-retry" variant="success" size="md" icon={RefreshCw} ariaLabel={t('postDetail.action.tryAgainTip')} labels={{ idle: t('postDetail.action.tryAgainIdle'), loading: t('postDetail.action.publishNowLoading'), success: t('postDetail.action.publishNowSuccess'), error: t('postDetail.error.generic') }} onAction={onPublishNow} onError={setError} />
              </Tip>
            ) : (
              <Tip label={t('postDetail.action.publishNowTip')}>
                <ActionButton key="publish-now" variant="success" size="md" icon={Send} ariaLabel={t('postDetail.action.publishNowTip')} labels={{ idle: t('postDetail.action.publishNowIdle'), loading: t('postDetail.action.publishNowLoading'), success: t('postDetail.action.publishNowSuccess'), error: t('postDetail.error.generic') }} onAction={onPublishNow} onError={setError} />
              </Tip>
            )
          ) : null}
          {primary === 'verify' ? (
            <Tip label={t('postDetail.action.verifyTip')}>
              {/* ux-audit dim-1 G3/R1a: on a verify-FAILED post the same primary slot
                  reads "Re-check" - the state-correct recovery verb (the read-back
                  said not-live; the fix is to read again), mirroring how a held post's
                  slot becomes "Try again". Same action, honest label. */}
              <ActionButton variant="success" size="md" icon={ShieldCheck} ariaLabel={t(post.derivedState === 'verify-failed' ? 'postDetail.action.recheckTip' : 'postDetail.action.verifyTip')} labels={{ idle: t(post.derivedState === 'verify-failed' ? 'postDetail.action.recheckIdle' : 'postDetail.action.verifyIdle'), loading: t('postDetail.action.verifyLoading'), success: t('postDetail.action.verifySuccess'), error: t('postDetail.action.verifyNotLive') }} onAction={onVerify} onError={setError} />
            </Tip>
          ) : null}

          {/* ... and Save is the PERMANENT footer action for an editable post:
              subdued (disabled) while nothing changed, lit once any field is
              dirty. One rev-guarded PATCH + the reschedule mutation when the
              schedule moved; success clears itself (rev bump -> draft re-sync). */}
          {editable ? (
            <ActionButton variant="success" size="md" icon={CheckCircle2} disabled={!anyDirty} labels={{ idle: t('postDetail.action.saveIdle'), loading: t('postDetail.action.saveLoading'), success: t('postDetail.action.saveSuccess'), error: t('postDetail.error.generic') }} onAction={saveFields} onError={setError} />
          ) : null}
        </div>
      </div>
    </Modal>
    </>
  );
}
