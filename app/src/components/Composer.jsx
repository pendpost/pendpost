import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Loader2, ArrowLeft, Clapperboard, ChevronDown, X, Search, Wand2, Eye, Plus, Trash2, BarChart3, HelpCircle, Link2, AtSign, MapPin, Hash, Music, CornerUpLeft, Check, Upload } from 'lucide-react';
import { useAssets, useConfig, usePlatformValidate, useValidateMedia, useActiveClient, useRedditFlairs, usePinterestBoardSections, createPost, updatePost, lintText } from '../lib/api.js';
import { useAssetUpload } from '../lib/useAssetUpload.js';
import { useT, useLocale } from '../lib/i18n.js';
import { splitTweetThread } from '../lib/thread.js';
import { PLATFORMS, TYPES, prettyCampaign, suggestPostId, visiblePlatforms, fieldRelevance, collapsedOverrideKey, formatsForPlatform, typeOptionLabel, POLL_DURATIONS, POLL_DEFAULT_DURATION, pollDurationKey, postNeedsMedia } from '../lib/format.js';
import { PLATFORM_META, INNER_SURFACE, FIELD_SURFACE, FIELD, FIELD_MULTILINE, LinkCardPreview, PostPreview, PlatformBlockers, CoverThumb, EYEBROW, DISABLED_PRIMARY } from './ui.jsx';
import ClientBand from './ClientBand.jsx';
import { DateTimePicker } from './ui/DateTimePicker.jsx';
import { Popover, PopoverTrigger, PopoverContent } from './ui/Popover.jsx';
import { Tip } from './ui/Tooltip.jsx';
import { IconBadge } from './ui/IconBadge.jsx';
import { useConfirm } from './ui/confirm.jsx';

// Content-driven textarea height (mirrors PostDetail's ContentField, punch-list
// 2.5): grow from the content's newline count and a wrapped-line estimate
// (~52 chars/row), clamped between min and max so an empty field starts compact
// and a long body cannot swallow the surface. resize-y stays for manual override.
function growRows(text, min, max) {
  const s = String(text || '');
  return Math.min(max, Math.max(min, s.split('\n').length + 1, Math.ceil(s.length / 52)));
}

// B9: reduce a SubRip (.srt) transcript to its plain spoken text so an attached
// asset's voiceover can seed an editable draft caption. Pure + zero-dep: split on
// blank-line cue boundaries, drop the leading cue-index line and the
// `hh:mm:ss,mmm --> hh:mm:ss,mmm` timecode line, keep the remaining text lines,
// and join with single spaces. Empty on any falsy/non-string input so a failed or
// absent SRT never blocks draft creation.
export function srtToText(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const TIMECODE = /^\s*\d{1,2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{1,2}:\d{2}:\d{2}[.,]\d{3}/;
  const out = [];
  for (const block of raw.replace(/\r\n/g, '\n').split(/\n\s*\n/)) {
    for (const line of block.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^\d+$/.test(trimmed)) continue; // cue index
      if (TIMECODE.test(trimmed)) continue; // timecode line
      out.push(trimmed);
    }
  }
  return out.join(' ');
}

// Per-platform caption caps mirrored from lib/lint.mjs CAPTION_LIMITS. Used only
// to pick the single most-permissive platform when several are co-selected, so a
// multi-target caption is not over-flagged for the laxest target (A4). The server
// remains the source of truth; this map just orders the choice.
const CAPTION_CAPS = { instagram: 2200, facebook: 63206, linkedin: 3000, youtube: 5000, x: 280, mastodon: 500, gbp: 1500 };

// Derive ONE representative platform for the live lint from the multi-select.
// The server brandLint takes a single platform, so when several are selected we
// send the one with the most permissive caption cap (e.g. Facebook over
// Instagram) to avoid a false over-limit flag. Returns undefined when nothing is
// selected, so lintText falls back to the conservative server default.
function representativePlatform(platforms) {
  if (!platforms || platforms.length === 0) return undefined;
  return platforms.reduce(
    (best, p) => ((CAPTION_CAPS[p] || 0) > (CAPTION_CAPS[best] || 0) ? p : best),
    platforms[0],
  );
}

// Live brand-lint over the caption, debounced against the server rule set. An
// optional platform threads the target's caption/hashtag caps through so the
// matchers do not fall back to the conservative default; it is part of the
// debounce deps so re-selecting platforms re-lints.
export function useLint(text, platform) {
  const [result, setResult] = useState(null);
  useEffect(() => {
    if (!text) {
      setResult(null);
      return undefined;
    }
    const t = setTimeout(() => {
      lintText(text, platform).then(setResult).catch(() => setResult(null));
    }, 350);
    return () => clearTimeout(t);
  }, [text, platform]);
  return result;
}

export function LintPanel({ lint }) {
  const t = useT();
  if (!lint) return null;
  // R6b net-simplify: drop the em-dash warn from the DISPLAY. The always-on
  // humanizer gate GUARANTEES every en/em dash is rewritten at save - its dash
  // fix (lib/humanize.mjs) matches on the exact same [–—] set as the
  // em-dash lint rule (rules.json) and replaces globally, so the fix is certain
  // and the operator can't act on the warning. Showing it is duplicate signal
  // for the one finding the receipt already covers. The server rule stays as the
  // backstop; only this panel hides it.
  const findings = (lint.findings || []).filter((f) => f.rule !== 'em-dash');
  if (!findings.length) {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-300">
        <CheckCircle2 size={12} aria-hidden="true" /> {t('composer.lint.clean')}
      </p>
    );
  }
  return (
    <ul className="space-y-1">
      {findings.slice(0, 8).map((f, i) => (
        <li
          key={`${f.rule}-${f.index}-${i}`}
          className={`flex items-start gap-1.5 text-[11px] ${
            f.severity === 'error' ? 'text-red-600 dark:text-red-300' : 'text-amber-700 dark:text-amber-300'
          }`}
        >
          <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            <span className="font-bold">&quot;{f.match}&quot;</span> - {f.hint}
          </span>
        </li>
      ))}
      {findings.length > 8 ? (
        <li className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.lint.more', { count: findings.length - 8 })}</li>
      ) : null}
      {lint.truncated ? (
        <li className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.lint.truncated')}</li>
      ) : null}
    </ul>
  );
}

const specBadges = (a, t) => {
  const out = [];
  const r = a.checks?.resolution;
  if (r === 'story-9x16') out.push(<IconBadge key="r" tone="ok" text="9:16" label={t('composer.spec.portrait')} />);
  else if (r === 'feed-4x5') out.push(<IconBadge key="r" tone="ok" text="4:5" label={t('composer.spec.feed')} />);
  else if (r === 'square-1x1') out.push(<IconBadge key="r" tone="ok" text="1:1" label={t('composer.spec.square')} />);
  return out;
};

// Visual video picker: a cover-thumbnail grid in a popover, searchable, with
// used/unused + resolution folders, replacing the bare filename dropdown.
// CT-1: `placeholderKey` lets a caller override the empty-state label - the
// CarouselPicker below reuses this SAME component per slide but a carousel is
// usually images, so "Choose video (data/media)" is wrong there; it passes
// 'composer.media.choose' ("Choose media") instead. The single-media picker
// (a real video slot) keeps the default 'composer.video.choose'.
// H4: the client half of two hand-copied server tables (lib/carousel.mjs
// CAROUSEL_LANE_LIMITS). They live at module scope so test/enumeration-drift.test.mjs
// can regex-read both literals; keep them as single-line object literals with no nested
// braces or that guard goes blind. CAROUSEL_LANE_NOMIX is guarded on arrival rather
// than after a second miss.
const CAROUSEL_LANE_MAX = { x: 4, mastodon: 4, pinterest: 5, instagram: 10, telegram: 10, discord: 10, linkedin: 20, reddit: 20 };
const CAROUSEL_LANE_NOMIX = { x: true, mastodon: true };
// The structural bound lib/writes.mjs enforces at save. Used when no carousel-capable
// lane is targeted yet: the previous fallback of 10 was invented and hid the Add control
// on a lawful album.
const CAROUSEL_STRUCTURAL_MAX = 20;

// The MIME allow-list every in-composer upload accepts, kept identical to the
// Assets library input so a file that uploads there uploads here (video + the two
// still formats the engine ingests). One const, so the picker and the carousel
// can never drift apart.
export const MEDIA_UPLOAD_ACCEPT = 'video/*,image/png,image/jpeg';

// A compact per-file upload status line (uploading / done / error). Shared by the
// VideoPicker popover and the CarouselPicker so both report progress the same way.
// Errors arrive already localized from useAssetUpload; done rows are transient and
// disappear when the asset list refreshes, so only errors carry a dismiss.
export function UploadStatus({ uploads, onDismiss }) {
  const t = useT();
  if (!uploads.length) return null;
  return (
    <ul role="status" aria-live="polite" className="space-y-1">
      {uploads.map((u) => (
        <li key={u.name} className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[11px] ${INNER_SURFACE}`}>
          {u.state === 'uploading' ? <Loader2 size={12} className="animate-spin text-zinc-500" aria-hidden="true" /> : u.state === 'done' ? <CheckCircle2 size={12} className="text-emerald-500" aria-hidden="true" /> : <AlertTriangle size={12} className="text-red-500" aria-hidden="true" />}
          <span className="flex-1 truncate font-bold">{u.name}</span>
          <span className={u.state === 'error' ? 'text-red-600 dark:text-red-300' : 'text-zinc-500 dark:text-zinc-400'}>{u.state === 'uploading' ? t('assets.upload.statusUploading') : u.state === 'done' ? t('assets.upload.statusDone') : u.error}</span>
          {u.state === 'error' && onDismiss ? (
            <Tip label={t('assets.upload.dismissTip')}>
              <button type="button" onClick={() => onDismiss(u.name)} aria-label={t('assets.upload.dismissAria', { name: u.name })} className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-zinc-500 dark:text-zinc-400 transition hover:bg-zinc-300/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-700/60">
                <X size={11} aria-hidden="true" />
              </button>
            </Tip>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function VideoPicker({ assets, assetsDir, value, onChange, placeholderKey = 'composer.video.choose', optionDisabledReason = null }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [folder, setFolder] = useState('all');
  // US-MEDIA-UP: upload/drag-drop right at the picker, so a fresh file no longer
  // needs a detour to the Assets page. A successful upload sets THIS field to the
  // new asset and closes the popover; the shared engine invalidates ['assets'] so
  // the grid below already lists it. Dropping onto the field works with the popover
  // shut, so the fastest path is "drag a file onto the field".
  const upload = useAssetUpload({ onUploaded: (name) => { onChange(`${assetsDir}/${name}`); setOpen(false); } });
  const selected = useMemo(() => assets.find((a) => `${assetsDir}/${a.file}` === value), [assets, assetsDir, value]);
  const shown = useMemo(
    () => assets.filter((a) => {
      if (q && !a.file.toLowerCase().includes(q.toLowerCase())) return false;
      if (folder === 'unused') return !(a.usedBy && a.usedBy.length);
      if (folder === 'used') return Boolean(a.usedBy && a.usedBy.length);
      // r2-4: mirror the Library's resolution folders so the composer picker can
      // narrow to square (1:1) media too - not just story/feed (Assets.jsx:198).
      if (['story-9x16', 'feed-4x5', 'square-1x1'].includes(folder)) return a.checks?.resolution === folder;
      return true;
    }),
    [assets, q, folder],
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* The trigger IS the field. The clear ("remove selected") control is a
          sibling button overlaid at the right - never a descendant of the trigger
          - so the trigger stays a single interactive element (no nested-interactive
          a11y violation). pr-9 reserves room for it; the chevron shows only when
          there is nothing to clear. */}
      <div className="relative" {...upload.dragHandlers}>
        {/* The field itself is the drop target (works with the popover shut). The
            dashed overlay is dragover-only and click-through, so it never competes
            with the trigger at rest; the hidden input backs the popover's Upload
            control. accept mirrors the Assets library exactly (MEDIA_UPLOAD_ACCEPT). */}
        <input
          ref={upload.inputRef}
          type="file"
          accept={MEDIA_UPLOAD_ACCEPT}
          aria-label={t('composer.video.upload')}
          className="hidden"
          onChange={(e) => { upload.handleFiles(e.target.files); e.target.value = ''; }}
        />
        {upload.dragging ? (
          <div role="region" aria-label={t('assets.drop.region')} className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-xl border-2 border-dashed border-brand bg-brand/5 text-[11px] font-bold text-brand backdrop-blur-sm dark:text-brand-light">
            {t('composer.video.dropHint')}
          </div>
        ) : null}
        <PopoverTrigger asChild>
          <button type="button" className={`flex w-full items-center gap-2.5 ${FIELD} ${value ? 'pr-9' : ''}`}>
            {selected ? (
              // US-ASSET-13: a chosen video shows its cover, or its own first
              // frame when cover-less - never a bare icon. The clapperboard stays
              // only as the empty-state "pick a video" affordance below.
              <CoverThumb media={selected} className="h-9 w-6 shrink-0 rounded" />
            ) : (
              <Clapperboard size={16} className="shrink-0 text-zinc-500" aria-hidden="true" />
            )}
            <span className="flex-1 truncate text-left">{selected ? selected.file : t(placeholderKey)}</span>
            {value ? null : <ChevronDown size={14} className="shrink-0 text-zinc-500" aria-hidden="true" />}
          </button>
        </PopoverTrigger>
        {value ? (
          <Tip label={t('composer.video.removeSelected')}>
            <button type="button" aria-label={t('composer.video.removeSelected')} onClick={() => onChange('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-zinc-500 dark:text-zinc-400 transition hover:bg-zinc-300/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-600/50">
              <X size={14} aria-hidden="true" />
            </button>
          </Tip>
        ) : null}
      </div>
      <PopoverContent className="w-[420px] max-w-[90vw] space-y-2 p-3" align="start">
        {/* Upload sits ABOVE the library grid: the fresh-file path first, picking an
            existing file second. Clicking it opens the same hidden input the field's
            drag-drop feeds, so both routes share one transport. */}
        <button
          type="button"
          onClick={upload.openPicker}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-zinc-300 px-3 py-2 text-[12px] font-bold text-zinc-600 transition hover:border-brand hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:border-zinc-600 dark:text-zinc-300 dark:hover:border-brand-light dark:hover:text-brand-light"
        >
          <Upload size={13} aria-hidden="true" />
          {t('composer.video.upload')}
        </button>
        <UploadStatus uploads={upload.uploads} onDismiss={upload.dismissUpload} />
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500" aria-hidden="true" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('composer.video.searchPlaceholder')} className={`${FIELD} w-full pl-8`} />
          </div>
        </div>
        <div className="flex flex-wrap gap-1">
          {[['all', t('composer.video.filterAll')], ['unused', t('composer.video.filterUnused')], ['used', t('composer.video.filterUsed')], ['story-9x16', '9:16'], ['feed-4x5', '4:5'], ['square-1x1', '1:1']].map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setFolder(k)}
              className={`rounded-full px-2.5 py-1 text-[11px] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${folder === k ? 'bg-brand text-white dark:bg-brand-light dark:text-zinc-900' : 'bg-zinc-200/60 text-zinc-600 hover:bg-zinc-300/60 dark:bg-zinc-800/60 dark:text-zinc-300'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="grid max-h-72 grid-cols-3 gap-2 overflow-y-auto">
          {shown.length ? shown.map((a) => {
            const isSel = `${assetsDir}/${a.file}` === value;
            // H4, canon "prevent at the control": an option the target lane cannot
            // accept renders disabled with its reason a hover away, rather than being
            // pickable and refused later at Pruefen. aria-disabled, NEVER the native
            // `disabled` attribute: `disabled` swallows pointer events, so the tooltip
            // would never fire and "the reason is a hover away" would be a lie.
            // optionDisabledReason defaults to null, so the single-media picker renders
            // exactly as before.
            const reason = optionDisabledReason ? optionDisabledReason(a) : null;
            return (
              <Tip key={a.file} label={reason || a.file}>
                <button
                  type="button"
                  aria-disabled={reason ? true : undefined}
                  aria-label={reason ? `${a.file}: ${reason}` : undefined}
                  onClick={reason ? undefined : () => { onChange(`${assetsDir}/${a.file}`); setOpen(false); }}
                  className={`overflow-hidden rounded-lg text-left ring-1 transition ${reason ? 'cursor-not-allowed opacity-40' : ''} ${isSel ? 'ring-2 ring-brand' : 'ring-zinc-900/10 hover:ring-brand/40 dark:ring-white/10'}`}
                >
                  {/* US-ASSET-13: cover JPEG, else the video's own first frame -
                      never a bare icon (CoverThumb owns that fallback). */}
                  <CoverThumb media={a} className="aspect-[9/16] w-full" />
                  <div className="space-y-0.5 p-1">
                    <p className="truncate text-[10px] font-bold">{a.file}</p>
                    <div className="flex items-center gap-1">
                      {specBadges(a, t)}
                      {a.probe?.durationSec ? <span className="text-[9px] text-zinc-500 dark:text-zinc-400">{a.probe.durationSec}s</span> : null}
                    </div>
                  </div>
                </button>
              </Tip>
            );
          }) : <p className="col-span-3 py-6 text-center text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.video.noMatches')}</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// FR4: the seven interactive-story sticker kinds. `api` records the honest
// per-platform reality: only mention is programmatically supported on Instagram;
// every other sticker is preview-only (the operator adds it by hand in the IG
// app). `empty` seeds a freshly-added sticker so its fields render at once.
const STICKER_KINDS = [
  { kind: 'poll', label: 'Poll', Icon: BarChart3, api: 'preview', empty: { question: '', options: ['', ''] } },
  { kind: 'question', label: 'Question', Icon: HelpCircle, api: 'preview', empty: { prompt: '' } },
  { kind: 'link', label: 'Link', Icon: Link2, api: 'preview', empty: { url: '', label: '' } },
  { kind: 'mention', label: 'Mention', Icon: AtSign, api: 'supported', empty: { handle: '' } },
  { kind: 'location', label: 'Location', Icon: MapPin, api: 'preview', empty: { name: '' } },
  { kind: 'hashtag', label: 'Hashtag', Icon: Hash, api: 'preview', empty: { tag: '' } },
  { kind: 'music', label: 'Music', Icon: Music, api: 'preview', empty: { title: '', artist: '' } },
];
const STICKER_META = Object.fromEntries(STICKER_KINDS.map((s) => [s.kind, s]));

// The labeled, keyboard-operable fields for one sticker (the authoritative
// content; the preview overlay is decoration). Each kind exposes its own inputs.
function StickerFields({ sticker, onPatch }) {
  const t = useT();
  const set = (patch) => onPatch({ ...sticker, ...patch });
  if (sticker.kind === 'poll') {
    return (
      <div role="group" aria-label={t('composer.sticker.poll.group')} className="space-y-1.5">
        <input aria-label={t('composer.sticker.poll.question')} placeholder={t('composer.sticker.poll.questionPlaceholder')} value={sticker.question || ''} onChange={(e) => set({ question: e.target.value })} className={`${FIELD} w-full`} />
        <div className="grid grid-cols-2 gap-1.5">
          <input aria-label={t('composer.sticker.poll.option1')} placeholder={t('composer.sticker.poll.option1Placeholder')} value={sticker.options?.[0] || ''} onChange={(e) => set({ options: [e.target.value, sticker.options?.[1] || ''] })} className={`${FIELD} w-full`} />
          <input aria-label={t('composer.sticker.poll.option2')} placeholder={t('composer.sticker.poll.option2Placeholder')} value={sticker.options?.[1] || ''} onChange={(e) => set({ options: [sticker.options?.[0] || '', e.target.value] })} className={`${FIELD} w-full`} />
        </div>
      </div>
    );
  }
  if (sticker.kind === 'question') {
    return <input aria-label={t('composer.sticker.question.prompt')} placeholder={t('composer.sticker.question.promptPlaceholder')} value={sticker.prompt || ''} onChange={(e) => set({ prompt: e.target.value })} className={`${FIELD} w-full`} />;
  }
  if (sticker.kind === 'link') {
    return (
      <div className="space-y-1.5">
        <input aria-label={t('composer.sticker.link.url')} placeholder="https://example.com" value={sticker.url || ''} onChange={(e) => set({ url: e.target.value })} className={`${FIELD} w-full`} />
        <input aria-label={t('composer.sticker.link.labelField')} placeholder={t('composer.sticker.link.labelPlaceholder')} value={sticker.label || ''} onChange={(e) => set({ label: e.target.value })} className={`${FIELD} w-full`} />
      </div>
    );
  }
  if (sticker.kind === 'mention') {
    return <input aria-label={t('composer.sticker.mention.handle')} placeholder={t('composer.sticker.mention.handlePlaceholder')} value={sticker.handle || ''} onChange={(e) => set({ handle: e.target.value })} className={`${FIELD} w-full`} />;
  }
  if (sticker.kind === 'location') {
    return <input aria-label={t('composer.sticker.location.name')} placeholder={t('composer.sticker.location.namePlaceholder')} value={sticker.name || ''} onChange={(e) => set({ name: e.target.value })} className={`${FIELD} w-full`} />;
  }
  if (sticker.kind === 'hashtag') {
    return <input aria-label={t('composer.sticker.hashtag.tag')} placeholder={t('composer.sticker.hashtag.tagPlaceholder')} value={sticker.tag || ''} onChange={(e) => set({ tag: e.target.value })} className={`${FIELD} w-full`} />;
  }
  if (sticker.kind === 'music') {
    return (
      <div className="grid grid-cols-2 gap-1.5">
        <input aria-label={t('composer.sticker.music.title')} placeholder={t('composer.sticker.music.titlePlaceholder')} value={sticker.title || ''} onChange={(e) => set({ title: e.target.value })} className={`${FIELD} w-full`} />
        <input aria-label={t('composer.sticker.music.artist')} placeholder={t('composer.sticker.music.artistPlaceholder')} value={sticker.artist || ''} onChange={(e) => set({ artist: e.target.value })} className={`${FIELD} w-full`} />
      </div>
    );
  }
  return null;
}

// FR4: the interactive-story authoring panel, shown ONLY for an Instagram story
// (the only surface where these stickers apply). Plus the per-post hashtags
// override: a toggle between the inherited global presets (read-only) and a
// custom per-post list. Both flow into the create/update payload.
export function InteractiveFields({
  stickers, onStickersChange, hashtagsMode, onHashtagsModeChange, hashtags, onHashtagsChange, globalHashtags,
}) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);
  const addSticker = (kind) => {
    onStickersChange([...stickers, { kind, ...structuredClone(STICKER_META[kind].empty) }]);
    setMenuOpen(false);
  };
  const patchSticker = (i, next) => onStickersChange(stickers.map((s, idx) => (idx === i ? next : s)));
  const removeSticker = (i) => onStickersChange(stickers.filter((_, idx) => idx !== i));

  return (
    <section className={`space-y-3 rounded-xl p-3 ${INNER_SURFACE}`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className={EYEBROW}>{t('composer.interactive.heading')}</h3>
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <button type="button" className="flex items-center gap-1 rounded-lg bg-zinc-200/60 px-2 py-1 text-[11px] font-bold transition hover:bg-zinc-300/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-zinc-800/60 dark:hover:bg-zinc-700/60">
              <Plus size={12} aria-hidden="true" />
              {t('composer.interactive.addSticker')}
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-44 p-1" align="end">
            <ul>
              {STICKER_KINDS.map(({ kind, Icon }) => (
                <li key={kind}>
                  <button type="button" onClick={() => addSticker(kind)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-bold transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-800/60">
                    <Icon size={13} aria-hidden="true" />
                    {t(`composer.sticker.${kind}.label`)}
                  </button>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      </div>

      {stickers.length ? (
        <ul className="space-y-2">
          {stickers.map((sticker, i) => {
            const meta = STICKER_META[sticker.kind];
            const { Icon } = meta;
            return (
              <li key={`${sticker.kind}-${i}`} className="space-y-1.5 rounded-lg bg-white/50 p-2 ring-1 ring-zinc-900/5 dark:bg-zinc-900/30 dark:ring-white/10">
                <div className="flex items-center gap-1.5">
                  <Icon size={13} aria-hidden="true" className="text-zinc-500 dark:text-zinc-400" />
                  <span className="flex-1 text-xs font-bold">{t(`composer.sticker.${sticker.kind}.label`)}</span>
                  <IconBadge
                    tone={meta.api === 'supported' ? 'ok' : 'neutral'}
                    text={meta.api === 'supported' ? t('composer.sticker.api.supported') : t('composer.sticker.api.preview')}
                    label={meta.api === 'supported' ? t('composer.sticker.api.supportedHint') : t('composer.sticker.api.previewHint')}
                  />
                  <Tip label={t('composer.interactive.removeSticker')}>
                    <button type="button" onClick={() => removeSticker(i)} aria-label={t('composer.interactive.removeStickerKind', { kind: t(`composer.sticker.${sticker.kind}.label`) })} className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-zinc-500 dark:text-zinc-400 transition hover:bg-zinc-300/60 hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-700/60 dark:hover:text-zinc-200">
                      <Trash2 size={12} aria-hidden="true" />
                    </button>
                  </Tip>
                </div>
                <StickerFields sticker={sticker} onPatch={(next) => patchSticker(i, next)} />
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.interactive.noStickers')}</p>
      )}

      <div className="space-y-1.5 border-t border-zinc-900/5 pt-2.5 dark:border-white/10">
        <label className="flex items-center gap-2 text-xs font-bold">
          <input
            type="checkbox"
            checked={hashtagsMode === 'global'}
            onChange={(e) => onHashtagsModeChange(e.target.checked ? 'global' : 'custom')}
            className="h-4 w-4 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          />
          {t('composer.hashtags.useGlobal')}
        </label>
        {hashtagsMode === 'global' ? (
          <p className="rounded-lg bg-white/40 px-2.5 py-1.5 text-[11px] text-zinc-500 dark:bg-zinc-900/30 dark:text-zinc-400">
            {globalHashtags?.length ? globalHashtags.join(' ') : t('composer.hashtags.noGlobal')}
          </p>
        ) : (
          <input
            aria-label={t('composer.hashtags.perPost')}
            placeholder={t('composer.hashtags.perPostPlaceholder')}
            value={hashtags}
            onChange={(e) => onHashtagsChange(e.target.value)}
            className={`${FIELD} w-full`}
          />
        )}
      </div>
    </section>
  );
}

// Spec 14: rich link/CTA (Pattern P1) - Telegram inline CTA buttons + link-
// preview/format control, and a Discord rich embed card. Each is a single
// structured object riding its own lane-exclusive gate (rel.tgCta / rel.dcEmbed),
// modeled on GbpFields below (:451) + the InteractiveFields add/remove idiom above.

const TG_CTA_EMPTY = { buttons: [], linkPreview: true, format: 'plain' };
function tgCtaFormState(c) {
  return {
    ...TG_CTA_EMPTY,
    ...(c || {}),
    buttons: Array.isArray(c?.buttons) ? c.buttons.map((b) => ({ label: b.label || '', url: b.url || '' })) : [],
  };
}

// Telegram allows more than 4 inline buttons; pendpost caps the authoring
// surface there to keep it lean (spec 14 §4).
const TG_CTA_MAX_BUTTONS = 4;

export function TelegramCtaFields({ cta, onChange }) {
  const t = useT();
  const set = (patch) => onChange({ ...cta, ...patch });
  const addButton = () => set({ buttons: [...cta.buttons, { label: '', url: '' }] });
  const patchButton = (i, patch) => set({ buttons: cta.buttons.map((b, idx) => (idx === i ? { ...b, ...patch } : b)) });
  const removeButton = (i) => set({ buttons: cta.buttons.filter((_, idx) => idx !== i) });
  return (
    <section className={`space-y-3 rounded-xl p-3 ${INNER_SURFACE}`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className={EYEBROW}>{t('composer.tgcta.heading')}</h3>
        {cta.buttons.length < TG_CTA_MAX_BUTTONS ? (
          <button type="button" onClick={addButton} className="flex items-center gap-1 rounded-lg bg-zinc-200/60 px-2 py-1 text-[11px] font-bold transition hover:bg-zinc-300/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-zinc-800/60 dark:hover:bg-zinc-700/60">
            <Plus size={12} aria-hidden="true" />
            {t('composer.tgcta.addButton')}
          </button>
        ) : null}
      </div>
      {cta.buttons.length ? (
        <ul className="space-y-1.5">
          {cta.buttons.map((b, i) => (
            <li key={i} className="flex items-center gap-1.5">
              <input aria-label={t('composer.tgcta.buttonLabel')} placeholder={t('composer.tgcta.buttonLabel')} value={b.label} onChange={(e) => patchButton(i, { label: e.target.value })} className={`${FIELD} w-full`} />
              <input aria-label={t('composer.tgcta.buttonUrl')} placeholder="https://example.com" value={b.url} onChange={(e) => patchButton(i, { url: e.target.value })} className={`${FIELD} w-full`} />
              <Tip label={t('composer.tgcta.removeButton')}>
                <button type="button" onClick={() => removeButton(i)} aria-label={t('composer.tgcta.removeButton')} className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-zinc-500 dark:text-zinc-400 transition hover:bg-zinc-300/60 hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-700/60 dark:hover:text-zinc-200">
                  <Trash2 size={12} aria-hidden="true" />
                </button>
              </Tip>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.tgcta.noButtons')}</p>
      )}
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-xs font-bold">
          <input
            type="checkbox"
            checked={cta.linkPreview !== false}
            onChange={(e) => set({ linkPreview: e.target.checked })}
            className="h-4 w-4 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          />
          {t('composer.tgcta.linkPreview')}
        </label>
        <div className="flex items-center gap-1.5">
          <label className={EYEBROW} htmlFor="composer-tgcta-format">{t('composer.tgcta.format')}</label>
          <select id="composer-tgcta-format" value={cta.format} onChange={(e) => set({ format: e.target.value })} className={`${FIELD} w-full`}>
            <option value="plain">{t('composer.tgcta.format.plain')}</option>
            <option value="html">{t('composer.tgcta.format.html')}</option>
          </select>
        </div>
      </div>
    </section>
  );
}

// Spec 26 review (MAJOR-2): an <input type="datetime-local"> value carries no
// timezone ('2027-01-01T18:00'). `Date.parse`/`new Date(...)` interpret that
// zone-less shape using the BROWSER's own local timezone (the ECMAScript
// date-time string grammar), which is exactly the wall-clock moment the
// operator meant to author - so converting through Date and back out to a
// full ISO-8601 string (with a 'Z'/offset) HERE, at the browser layer, is the
// correct fix for the wrong-hour live event (a bare local string sent
// verbatim to Discord was being read back 1-2h off, or rejected with a 400).
function dcEventLocalToIso(localValue) {
  if (!localValue) return '';
  const ms = Date.parse(localValue);
  return Number.isNaN(ms) ? '' : new Date(ms).toISOString();
}
// The inverse: render a stored full-ISO dcEvent time (an agent-authored '…Z'
// start, or this Composer's own post-fix save) back into the zone-less
// "YYYY-MM-DDTHH:mm" shape the datetime-local control needs, so it round-trips
// on open instead of rendering blank (MINOR-4's display half).
function isoToDatetimeLocalValue(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Spec 26: Discord guild-scheduled-event intent, modelled on GBP_EMPTY/
// gbpFormState below (flat, controlled form state; every field present).
// entityType/channelId/description carry no Composer UI control (the
// authoring surface only ever creates an EXTERNAL event - see
// DiscordEventFields below) but are still tracked in state so an
// agent-authored voice/stage event round-trips byte-identical through an
// unrelated owner edit instead of being silently dropped (MINOR-4).
const DC_EVENT_EMPTY = { name: '', startTime: '', endTime: '', location: '', entityType: '', channelId: '', description: '' };
function dcEventFormState(e) {
  const out = { ...DC_EVENT_EMPTY, ...(e || {}) };
  out.name = String(out.name || '');
  out.startTime = isoToDatetimeLocalValue(out.startTime);
  out.endTime = isoToDatetimeLocalValue(out.endTime);
  for (const k of ['location', 'entityType', 'channelId', 'description']) out[k] = String(out[k] || '');
  return out;
}

// The Discord guild-scheduled-event authoring group (spec 26), modelled 1:1 on
// GbpFields (:574): name + start + optional end + optional location - the
// Composer's authoring surface only ever creates an EXTERNAL-type event (no
// channel picker), so entityType/channelId are agent/MCP-only fields. Rendered
// NESTED inside the merged discord subsection below (DiscordEmbedFields), not
// as its own top-level section - the §99 rule ("26 discord merges into ONE
// discord Composer subsection with 14's dcEmbed").
function DiscordEventFields({ dcEvent, onChange }) {
  const t = useT();
  const set = (patch) => onChange({ ...dcEvent, ...patch });
  return (
    <div className="space-y-3 border-t border-zinc-200/70 pt-3 dark:border-zinc-700/60">
      <h4 className={EYEBROW}>{t('composer.dcevent.heading')}</h4>
      <div className="space-y-1.5">
        <label className={EYEBROW} htmlFor="composer-dcevent-name">{t('composer.dcevent.name')}</label>
        <input id="composer-dcevent-name" value={dcEvent.name} onChange={(e) => set({ name: e.target.value })} className={`${FIELD} w-full`} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className={EYEBROW} htmlFor="composer-dcevent-start">{t('composer.dcevent.start')}</label>
          <input id="composer-dcevent-start" type="datetime-local" value={dcEvent.startTime} onChange={(e) => set({ startTime: e.target.value })} className={`${FIELD} w-full`} />
        </div>
        <div className="space-y-1.5">
          <label className={EYEBROW} htmlFor="composer-dcevent-end">{t('composer.dcevent.end')}</label>
          <input id="composer-dcevent-end" type="datetime-local" value={dcEvent.endTime} onChange={(e) => set({ endTime: e.target.value })} className={`${FIELD} w-full`} />
        </div>
      </div>
      <div className="space-y-1.5">
        <label className={EYEBROW} htmlFor="composer-dcevent-location">{t('composer.dcevent.location')}</label>
        <input id="composer-dcevent-location" value={dcEvent.location} onChange={(e) => set({ location: e.target.value })} placeholder={t('composer.dcevent.locationPlaceholder')} className={`${FIELD} w-full`} />
      </div>
    </div>
  );
}

const DC_EMBED_EMPTY = { title: '', description: '', url: '', color: '' };
// A saved dcEmbed.color persists as an integer (the Discord wire format); the
// authoring field is a plain hex-string input (mirrors gbpFormState's date
// slicing - convert the stored shape to what the control expects on load).
// The string members are coerced through String(... || '') so a persisted
// null (the tool prose teaches "set a field to null to remove it" - and
// validateFieldValues accepts null string members) never reaches a `.trim()`
// on a controlled input and white-screens the editor.
function dcEmbedFormState(e) {
  const out = { ...DC_EMBED_EMPTY, ...(e || {}) };
  for (const k of ['title', 'description', 'url']) out[k] = String(out[k] || '');
  out.color = typeof out.color === 'number' && Number.isInteger(out.color)
    ? `#${out.color.toString(16).padStart(6, '0').toUpperCase()}`
    : String(out.color || '');
  return out;
}

// The ONE merged Discord Composer subsection (spec 14's rich embed card PLUS
// spec 26's forum/thread targeting + guild-event group), shown only when the
// discord lane is targeted. Buttons/`components` are a documented Pattern P9
// gate - an honest one-line hint, not a live control (embeds send on any
// webhook today). The three thread/event props are optional so a standalone
// caller (the spec-14 component test) that renders only { embed, onChange }
// still gets the embed card with no crash and no extra DOM.
export function DiscordEmbedFields({ embed, onChange, threadName, threadId, onThreadNameChange, onThreadIdChange, dcEvent, onDcEventChange }) {
  const t = useT();
  const set = (patch) => onChange({ ...embed, ...patch });
  return (
    <section className={`space-y-3 rounded-xl p-3 ${INNER_SURFACE}`}>
      <h3 className={EYEBROW}>{t('composer.dcembed.heading')}</h3>
      <div className="space-y-1.5">
        <label className={EYEBROW} htmlFor="composer-dcembed-title">{t('composer.dcembed.title')}</label>
        <input id="composer-dcembed-title" value={embed.title} onChange={(e) => set({ title: e.target.value })} className={`${FIELD} w-full`} />
      </div>
      <div className="space-y-1.5">
        <label className={EYEBROW} htmlFor="composer-dcembed-description">{t('composer.dcembed.description')}</label>
        <textarea id="composer-dcembed-description" value={embed.description} onChange={(e) => set({ description: e.target.value })} rows={2} className={`${FIELD_MULTILINE} w-full resize-y`} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className={EYEBROW} htmlFor="composer-dcembed-url">{t('composer.dcembed.url')}</label>
          <input id="composer-dcembed-url" value={embed.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://example.com" className={`${FIELD} w-full`} />
        </div>
        <div className="space-y-1.5">
          <label className={EYEBROW} htmlFor="composer-dcembed-color">{t('composer.dcembed.color')}</label>
          <input id="composer-dcembed-color" value={embed.color} onChange={(e) => set({ color: e.target.value })} placeholder="#5865F2" className={`${FIELD} w-full`} />
        </div>
      </div>
      <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.dcembed.buttonsGated')}</p>

      {onThreadNameChange && onThreadIdChange ? (
        <div className="space-y-1.5 border-t border-zinc-200/70 pt-3 dark:border-zinc-700/60">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-dc-thread-name">{t('composer.field.dcThreadName')}</label>
              <input id="composer-dc-thread-name" value={threadName} onChange={(e) => onThreadNameChange(e.target.value)} placeholder={t('composer.field.dcThreadNamePlaceholder')} className={`${FIELD} w-full`} />
            </div>
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-dc-thread-id">{t('composer.field.dcThreadId')}</label>
              <input id="composer-dc-thread-id" value={threadId} onChange={(e) => onThreadIdChange(e.target.value)} placeholder="123456789012345678" className={`${FIELD} w-full`} />
            </div>
          </div>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.hint.dcThreadExclusive')}</p>
        </div>
      ) : null}

      {onDcEventChange ? <DiscordEventFields dcEvent={dcEvent} onChange={onDcEventChange} /> : null}
    </section>
  );
}

// Shared over-limit counter idiom (r2-1/r2-3), used by the X (280) and Mastodon
// (500) note overrides. Over limit it pairs the red color with a lucide
// AlertTriangle icon + an over-limit word + an sr-only severity prefix (never
// color alone - WCAG 1.4.1). NOT a live region: the count stays reachable via
// aria-describedby on focus; the over/under TRANSITION is announced separately
// (useOverLimitAnnounce), so a screen reader is not spammed per keystroke.
export function CharCounter({ id, len, max, over }) {
  const t = useT();
  return (
    <p
      id={id}
      className={`flex items-center gap-1 text-[11px] font-bold tabular-nums ${over ? 'text-red-600 dark:text-red-400' : 'text-zinc-500 dark:text-zinc-400'}`}
    >
      {over ? <AlertTriangle size={12} className="shrink-0" aria-hidden="true" /> : null}
      {over ? <span className="sr-only">{t('composer.field.xCounterSeverity')} </span> : null}
      {over
        ? t('composer.field.xCounterOver', { count: len, max })
        : t('composer.field.xCounter', { count: len, max })}
    </p>
  );
}

// The polite announce half of the counter idiom: returns the message for a
// separate sr-only role=status region, populated ONLY on the over/under
// transition (r2-3) - never a fresh count per keystroke.
function useOverLimitAnnounce(over, len, max) {
  const t = useT();
  const [announce, setAnnounce] = useState('');
  const wasOverRef = useRef(false);
  useEffect(() => {
    if (over === wasOverRef.current) return;
    wasOverRef.current = over;
    setAnnounce(over ? t('composer.field.xCounterOver', { count: len, max }) : '');
  }, [over, len, max, t]);
  return announce;
}

// Google Business Profile local-post intent (mirrors lib/writes.mjs GBP_TOPICS /
// GBP_CTA_TYPES). The '' CTA value is the UI's "none" - it never reaches the
// payload. CALL uses the location's phone number, so it carries no URL.
const GBP_TOPICS = ['standard', 'offer', 'event'];
const GBP_CTA_KEYS = { '': 'none', BOOK: 'book', ORDER: 'order', SHOP: 'shop', LEARN_MORE: 'learnMore', SIGN_UP: 'signUp', CALL: 'call' };

// The flat GBP form state: every field present (controlled inputs), seeded from
// a saved post.gbp on edit. Date-only slices keep the <input type=date> happy
// even if a stored value carries a time part.
const GBP_EMPTY = { topic: 'standard', ctaType: '', ctaUrl: '', eventTitle: '', eventStart: '', eventEnd: '', couponCode: '', redeemUrl: '', terms: '' };
function gbpFormState(g) {
  const out = { ...GBP_EMPTY, ...(g || {}) };
  out.eventStart = String(out.eventStart || '').slice(0, 10);
  out.eventEnd = String(out.eventEnd || '').slice(0, 10);
  return out;
}

// The GBP authoring section, shown only when the gbp lane is targeted. Topic
// gates the event/offer field groups; the CTA URL hides for "none" (nothing to
// link) and CALL (uses the location's phone number).
function GbpFields({ gbp, onChange }) {
  const t = useT();
  const set = (patch) => onChange({ ...gbp, ...patch });
  const showCtaUrl = Boolean(gbp.ctaType) && gbp.ctaType !== 'CALL';
  return (
    <section className={`space-y-3 rounded-xl p-3 ${INNER_SURFACE}`}>
      <h3 className={EYEBROW}>{t('composer.gbp.heading')}</h3>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <label className={EYEBROW} htmlFor="composer-gbp-topic">{t('composer.gbp.topic')}</label>
          <select id="composer-gbp-topic" value={gbp.topic} onChange={(e) => set({ topic: e.target.value })} className={`${FIELD} w-full`}>
            {GBP_TOPICS.map((k) => (
              <option key={k} value={k}>{t(`composer.gbp.topic.${k}`)}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label className={EYEBROW} htmlFor="composer-gbp-cta">{t('composer.gbp.ctaType')}</label>
          <select id="composer-gbp-cta" value={gbp.ctaType} onChange={(e) => set({ ctaType: e.target.value })} className={`${FIELD} w-full`}>
            {Object.entries(GBP_CTA_KEYS).map(([value, key]) => (
              <option key={key} value={value}>{t(`composer.gbp.cta.${key}`)}</option>
            ))}
          </select>
        </div>
      </div>
      {showCtaUrl ? (
        <div className="space-y-1.5">
          <label className={EYEBROW} htmlFor="composer-gbp-cta-url">{t('composer.gbp.ctaUrl')}</label>
          <input id="composer-gbp-cta-url" value={gbp.ctaUrl} onChange={(e) => set({ ctaUrl: e.target.value })} placeholder="https://example.com/book" className={`${FIELD} w-full`} />
        </div>
      ) : null}
      {gbp.topic === 'event' ? (
        <>
          <div className="space-y-1.5">
            <label className={EYEBROW} htmlFor="composer-gbp-event-title">{t('composer.gbp.eventTitle')}</label>
            <input id="composer-gbp-event-title" value={gbp.eventTitle} onChange={(e) => set({ eventTitle: e.target.value })} className={`${FIELD} w-full`} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-gbp-event-start">{t('composer.gbp.eventStart')}</label>
              <input id="composer-gbp-event-start" type="date" value={gbp.eventStart} onChange={(e) => set({ eventStart: e.target.value })} className={`${FIELD} w-full`} />
            </div>
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-gbp-event-end">{t('composer.gbp.eventEnd')}</label>
              <input id="composer-gbp-event-end" type="date" value={gbp.eventEnd} onChange={(e) => set({ eventEnd: e.target.value })} className={`${FIELD} w-full`} />
            </div>
          </div>
        </>
      ) : null}
      {gbp.topic === 'offer' ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-gbp-coupon">{t('composer.gbp.couponCode')}</label>
              <input id="composer-gbp-coupon" value={gbp.couponCode} onChange={(e) => set({ couponCode: e.target.value })} className={`${FIELD} w-full`} />
            </div>
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-gbp-redeem">{t('composer.gbp.redeemUrl')}</label>
              <input id="composer-gbp-redeem" value={gbp.redeemUrl} onChange={(e) => set({ redeemUrl: e.target.value })} placeholder="https://example.com/offer" className={`${FIELD} w-full`} />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className={EYEBROW} htmlFor="composer-gbp-terms">{t('composer.gbp.terms')}</label>
            <textarea id="composer-gbp-terms" value={gbp.terms} onChange={(e) => set({ terms: e.target.value })} rows={2} className={`${FIELD_MULTILINE} w-full resize-y`} />
          </div>
        </>
      ) : null}
    </section>
  );
}

// Spec 25: disclosure & interaction settings (Pattern P1). TikTok's interaction/
// disclosure post_info flags as a structured group (modeled on GbpFields above);
// Mastodon's content-warning and X's reply-audience enum are single fields
// rendered inline near their lane's own caption/reply-to block below.

// The seven TikTok post_info toggles, in menu order. brandedContent/brandOrganic
// are TikTok's own "Branded content"/"Your brand" disclosure pair; aiGenerated is
// the AI-label. Every flag is audit-gated server-side for an unaudited app
// (Pattern P9) - the toggle always renders (honest, matches TikTok's own
// creator-tools UI); TikTok enforces or rejects it at publish time.
const TT_INTERACTION_CHECKS = ['disableComment', 'disableDuet', 'disableStitch', 'aiGenerated', 'brandedContent', 'brandOrganic'];
const TT_INTERACTION_EMPTY = { disableComment: false, disableDuet: false, disableStitch: false, aiGenerated: false, brandedContent: false, brandOrganic: false, coverTimestampMs: '' };

// The flat TikTok interaction form state: every flag present (controlled
// checkboxes) + the cover-frame timestamp as a string (numeric <input> friendly),
// seeded from a saved post.ttInteraction on edit.
function ttInteractionFormState(i) {
  const out = { ...TT_INTERACTION_EMPTY, ...(i || {}) };
  for (const k of TT_INTERACTION_CHECKS) out[k] = out[k] === true;
  out.coverTimestampMs = out.coverTimestampMs === undefined || out.coverTimestampMs === null ? '' : String(out.coverTimestampMs);
  return out;
}

// The TikTok interaction/disclosure authoring section, shown only when the
// tiktok lane is targeted.
export function TiktokFields({ interaction, onChange }) {
  const t = useT();
  const set = (patch) => onChange({ ...interaction, ...patch });
  return (
    <section className={`space-y-3 rounded-xl p-3 ${INNER_SURFACE}`}>
      <h3 className={EYEBROW}>{t('composer.tiktok.heading')}</h3>
      <div className="grid grid-cols-2 gap-2">
        {TT_INTERACTION_CHECKS.map((k) => (
          <label key={k} className="flex items-center gap-2 text-xs font-bold">
            <input
              type="checkbox"
              checked={interaction[k]}
              onChange={(e) => set({ [k]: e.target.checked })}
              className="h-4 w-4 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            />
            {t(`composer.tiktok.${k}`)}
          </label>
        ))}
      </div>
      <div className="space-y-1.5">
        <label className={EYEBROW} htmlFor="composer-tiktok-cover-ts">{t('composer.tiktok.coverTimestamp')}</label>
        <input id="composer-tiktok-cover-ts" type="number" min="0" value={interaction.coverTimestampMs} onChange={(e) => set({ coverTimestampMs: e.target.value })} className={`${FIELD} w-24`} />
      </div>
    </section>
  );
}

// X's reply_settings CREATE enum (who may reply). The '' option is the UI's
// "Default (everyone)" - it omits the param, which IS how X expresses "everyone"
// (the create API 400s on reply_settings:'everyone', so it is deliberately not
// an option here).
const X_REPLY_SETTINGS = ['following', 'mentionedUsers', 'subscribers', 'verified'];

// Spec 10: native poll authoring (Pattern P1), shown ONLY for a type=poll post.
// The QUESTION is the shared caption above; this block owns the choices + duration.
// Per-lane native option caps (mirrors lib/writes.mjs POLL_OPTION_CAP); nostr is
// uncapped. The effective max for a post is the MIN across its targeted poll lanes,
// so the add-option control + the hint never offer more than the tightest lane.
const POLL_LANE_MAX = { x: 4, linkedin: 4, mastodon: 4, reddit: 6, telegram: 10, discord: 10 };
function pollMaxOptions(platforms) {
  const caps = (platforms || []).map((p) => POLL_LANE_MAX[p]).filter((n) => typeof n === 'number');
  return caps.length ? Math.min(...caps) : 10;
}

// Flat poll form state: at least two option rows (controlled inputs), a duration in
// minutes, and the multi-select flag - seeded from a saved post.poll on edit.
function pollFormState(p) {
  if (!p || typeof p !== 'object') return { options: ['', ''], durationMinutes: POLL_DEFAULT_DURATION, multiple: false };
  const raw = Array.isArray(p.options) ? p.options.map((o) => String(o || '')) : [];
  const options = raw.length >= 2 ? raw : [...raw, ...Array(2 - raw.length).fill('')];
  return { options, durationMinutes: Number(p.durationMinutes) || POLL_DEFAULT_DURATION, multiple: p.multiple === true };
}

// The poll options/duration authoring section. `max` is the tightest targeted-lane
// option cap; removing an option is blocked at 2 (a poll needs at least two choices),
// and adding is blocked at `max`.
export function PollFields({ poll, onChange, max }) {
  const t = useT();
  const setOption = (i, val) => onChange({ ...poll, options: poll.options.map((o, idx) => (idx === i ? val : o)) });
  const addOption = () => onChange({ ...poll, options: [...poll.options, ''] });
  const removeOption = (i) => onChange({ ...poll, options: poll.options.filter((_, idx) => idx !== i) });
  return (
    <section className={`space-y-3 rounded-xl p-3 ${INNER_SURFACE}`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className={EYEBROW}>{t('composer.poll.heading')}</h3>
        {poll.options.length < max ? (
          <button type="button" onClick={addOption} className="flex items-center gap-1 rounded-lg bg-zinc-200/60 px-2 py-1 text-[11px] font-bold transition hover:bg-zinc-300/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-zinc-800/60 dark:hover:bg-zinc-700/60">
            <Plus size={12} aria-hidden="true" />
            {t('composer.poll.addOption')}
          </button>
        ) : null}
      </div>
      <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.poll.question')}</p>
      <ul className="space-y-1.5">
        {poll.options.map((o, i) => (
          <li key={i} className="flex items-center gap-1.5">
            <input
              aria-label={t('composer.poll.option', { n: i + 1 })}
              placeholder={t('composer.poll.option', { n: i + 1 })}
              value={o}
              onChange={(e) => setOption(i, e.target.value)}
              className={`${FIELD} w-full`}
            />
            {poll.options.length > 2 ? (
              <Tip label={t('composer.poll.removeOption')}>
                <button type="button" onClick={() => removeOption(i)} aria-label={t('composer.poll.removeOption')} className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-zinc-500 dark:text-zinc-400 transition hover:bg-zinc-300/60 hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-700/60 dark:hover:text-zinc-200">
                  <Trash2 size={12} aria-hidden="true" />
                </button>
              </Tip>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.poll.hint', { max })}</p>
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-1.5">
          <label className={EYEBROW} htmlFor="composer-poll-duration">{t('composer.poll.duration')}</label>
          <select id="composer-poll-duration" value={poll.durationMinutes} onChange={(e) => onChange({ ...poll, durationMinutes: Number(e.target.value) })} className={`${FIELD} w-full`}>
            {/* A non-preset (e.g. MCP-authored) durationMinutes isn't among the presets;
                synthesize an option so the select shows + preserves it instead of
                silently rendering the first preset (mirrors PostDetail's "<n> min"
                fallback). */}
            {!pollDurationKey(poll.durationMinutes) ? (
              <option value={poll.durationMinutes}>{t('postDetail.poll.minutes', { count: poll.durationMinutes })}</option>
            ) : null}
            {POLL_DURATIONS.map((d) => (
              <option key={d.key} value={d.minutes}>{t(`composer.poll.duration.${d.key}`)}</option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 text-xs font-bold">
          <input
            type="checkbox"
            checked={poll.multiple}
            onChange={(e) => onChange({ ...poll, multiple: e.target.checked })}
            className="h-4 w-4 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          />
          {t('composer.poll.multiple')}
        </label>
      </div>
    </section>
  );
}

// Spec 05: native carousel authoring (Pattern P1), shown ONLY for a type=carousel post.
// The ordered slides are an array of media path strings (the same `${assetsDir}/${file}`
// shape the single VideoPicker emits); each row reuses the VideoPicker so a slide is
// picked exactly like a single video. Add/remove keep the count within 2..max, and the
// up/down controls reorder (the album order is what publishes). `max` is the tightest
// targeted-lane cap so the add control never offers more than the strictest lane allows.
// A carousel of fewer than two slides is still SAVEABLE (Pruefen surfaces "needs 2").
export function CarouselPicker({ assets, assetsDir, items, onChange, max, slideUrls, onSlideUrlChange, showSlideUrl, platforms = [] }) {
  const t = useT();
  // Spec 39: image-kind detection by extension, mirroring lib/carousel.mjs
  // carouselItemKind (video extensions upload locally; everything else is an
  // image slide, which IG publishes from its public per-slide url).
  const isImageRef = (ref) => !/\.(mp4|mov|m4v|webm)$/i.test(String(ref || ''));
  // Display always shows at least two rows (a carousel needs two); the padded rows are
  // the array we mutate, so editing an empty slot writes back a real two-slot array.
  const rows = items.length >= 2 ? items : [...items, ...Array(2 - items.length).fill('')];
  const setSlot = (i, val) => onChange(rows.map((v, idx) => (idx === i ? val : v)));
  const addSlot = () => onChange([...rows, '']);
  const removeSlot = (i) => onChange(rows.filter((_, idx) => idx !== i));
  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };
  // H4: X cannot mix images and video in one album. Prevent it at the control rather
  // than letting the author form the album and having Pruefen refuse it afterwards.
  // The reason is computed per SLOT against the OTHER slots, so replacing the very slide
  // that set the kind is never blocked by itself. When the other slots already hold both
  // kinds (possible on legacy data), nothing is disabled: that would be a dead end, and
  // the album is already mixed.
  const noMixLane = (platforms || []).find((p) => CAROUSEL_LANE_NOMIX[p]) || null;
  const kindOf = (ref) => (isImageRef(ref) ? 'image' : 'video');
  const slotOptionReason = (i) => (asset) => {
    if (!noMixLane) return null;
    const others = rows.filter((v, idx) => idx !== i && v).map(kindOf);
    if (!others.length) return null;
    return others.includes(kindOf(asset.file)) ? null : t('blockers.validate.carouselNoMix', { platform: noMixLane });
  };
  // The Add control stops vanishing at the cap and becomes disabled-with-reason: one
  // state machine instead of two. A control that disappears answers nothing, because the
  // author cannot tell "at the cap" from "this build has no Add button".
  const atCap = rows.length >= max;
  const addReason = atCap ? t('composer.carousel.atCap', { max }) : null;
  // US-MEDIA-UP: drop several files onto the album to upload them all and append
  // each as a new slide (per-slot upload already comes free via the shared
  // VideoPicker inside each row). itemsRef tracks the latest array so sequential
  // uploads append rather than clobber, and the strictest-lane cap is honored so a
  // bulk drop can never overflow it.
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const upload = useAssetUpload({ onUploaded: (name) => {
    if (itemsRef.current.length >= max) return;
    onChange([...itemsRef.current, `${assetsDir}/${name}`]);
  } });
  return (
    <section className={`relative space-y-3 rounded-xl p-3 ${INNER_SURFACE}`} {...upload.dragHandlers}>
      <input
        ref={upload.inputRef}
        type="file"
        accept={MEDIA_UPLOAD_ACCEPT}
        multiple
        aria-label={t('composer.carousel.upload')}
        className="hidden"
        onChange={(e) => { upload.handleFiles(e.target.files); e.target.value = ''; }}
      />
      {upload.dragging ? (
        <div role="region" aria-label={t('assets.drop.region')} className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-xl border-2 border-dashed border-brand bg-brand/5 text-[11px] font-bold text-brand backdrop-blur-sm dark:text-brand-light">
          {t('composer.carousel.dropHint')}
        </div>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <h3 className={EYEBROW}>{t('composer.carousel.heading')}</h3>
        <div className="flex items-center gap-1.5">
          <Tip label={atCap ? addReason : t('composer.carousel.upload')}>
            <button
              type="button"
              aria-disabled={atCap ? true : undefined}
              aria-label={atCap ? `${t('composer.carousel.upload')}: ${addReason}` : t('composer.carousel.upload')}
              onClick={atCap ? undefined : upload.openPicker}
              className={`flex items-center gap-1 rounded-lg bg-zinc-200/60 px-2 py-1 text-[11px] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-zinc-800/60 ${atCap ? 'cursor-not-allowed opacity-40' : 'hover:bg-zinc-300/60 dark:hover:bg-zinc-700/60'}`}
            >
              <Upload size={12} aria-hidden="true" />
              {t('composer.carousel.upload')}
            </button>
          </Tip>
          <Tip label={addReason || t('composer.carousel.add')}>
            <button
              type="button"
              aria-disabled={atCap ? true : undefined}
              aria-label={addReason ? `${t('composer.carousel.add')}: ${addReason}` : undefined}
              onClick={atCap ? undefined : addSlot}
              className={`flex items-center gap-1 rounded-lg bg-zinc-200/60 px-2 py-1 text-[11px] font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-zinc-800/60 ${atCap ? 'cursor-not-allowed opacity-40' : 'hover:bg-zinc-300/60 dark:hover:bg-zinc-700/60'}`}
            >
              <Plus size={12} aria-hidden="true" />
              {t('composer.carousel.add')}
            </button>
          </Tip>
        </div>
      </div>
      <UploadStatus uploads={upload.uploads} onDismiss={upload.dismissUpload} />
      <ul className="space-y-1.5">
        {rows.map((val, i) => (
          <li key={i} className="flex items-center gap-1.5">
            <span className="w-4 shrink-0 text-center text-[11px] font-bold text-zinc-500" aria-hidden="true">{i + 1}</span>
            <div className="min-w-0 flex-1 space-y-1">
              <VideoPicker assets={assets} assetsDir={assetsDir} value={val} onChange={(v) => setSlot(i, v)} placeholderKey="composer.media.choose" optionDisabledReason={slotOptionReason(i)} />
              {showSlideUrl && val && isImageRef(val) ? (
                <input
                  value={(slideUrls && slideUrls[val]) || ''}
                  onChange={(e) => onSlideUrlChange(val, e.target.value)}
                  placeholder="https://res.cloudinary.com/<your-cloud>/..."
                  aria-label={t('composer.carousel.slideUrl')}
                  className={`${FIELD} w-full`}
                />
              ) : null}
            </div>
            <Tip label={t('composer.carousel.moveUp')}>
              <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={t('composer.carousel.moveUp')} className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-zinc-500 dark:text-zinc-400 transition hover:bg-zinc-300/60 hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-zinc-700/60 dark:hover:text-zinc-200">
                <ChevronDown size={12} className="rotate-180" aria-hidden="true" />
              </button>
            </Tip>
            <Tip label={t('composer.carousel.moveDown')}>
              <button type="button" onClick={() => move(i, 1)} disabled={i === rows.length - 1} aria-label={t('composer.carousel.moveDown')} className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-zinc-500 dark:text-zinc-400 transition hover:bg-zinc-300/60 hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-30 dark:hover:bg-zinc-700/60 dark:hover:text-zinc-200">
                <ChevronDown size={12} aria-hidden="true" />
              </button>
            </Tip>
            {rows.length > 2 ? (
              <Tip label={t('composer.carousel.remove')}>
                <button type="button" onClick={() => removeSlot(i)} aria-label={t('composer.carousel.remove')} className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-zinc-500 dark:text-zinc-400 transition hover:bg-zinc-300/60 hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-700/60 dark:hover:text-zinc-200">
                  <Trash2 size={12} aria-hidden="true" />
                </button>
              </Tip>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.carousel.hint', { max })}{showSlideUrl ? ` ${t('composer.carousel.slideUrlHint')}` : ''}</p>
    </section>
  );
}

// Spec 05: the Composer's carousel state seed - the ordered slide REFS taken from the RAW
// post.mediaItems (each { file } | { path }), NOT the resolved post.media.items[]. A slide
// not yet on disk resolves to path:null; a resolved seed would drop it (it.path is falsy),
// and because save sends the FULL slide set that silent drop would permanently delete the
// slide from the plan on ANY later edit. Each raw ref becomes its path-or-file string (the
// VideoPicker value shape); blanks are filtered. Shared by the state AND the isDirty
// snapshot so an unedited carousel never reads as dirty.
function carouselSeedRefs(isEdit, post) {
  if (!isEdit || !Array.isArray(post?.mediaItems)) return [];
  return post.mediaItems.map((it) => (it && (it.path || it.file)) || '').filter(Boolean);
}

// Create + edit composer as a full page. Edit mode never touches approval/cover/
// publish fields - those have their own controls in PostDetail.
export default function Composer({ mode, post, campaigns, onClose, onSaved, seed, onNavigate, accounts, posting, onStartThread, onDirtyChange }) {
  const t = useT();
  const locale = useLocale();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { activeClient } = useActiveClient();
  const { data: assetsData } = useAssets(true);
  const { data: configData } = useConfig(true);
  const isEdit = mode === 'edit';
  // B2: in edit mode, surface the SAVED post's publish-readiness blockers near
  // the save action so the owner sees a bad post before publishing. Validation
  // is server-side against the persisted post, so create-before-save shows
  // nothing (gated off until first save). Read-only; never writes/pokes a lane.
  const { data: platformValidate } = usePlatformValidate(post?.campaign, post?.id, isEdit, post?.rev);
  // CI-2: skip the probe for a media-less SAVED type (text/poll/nostr-longform) -
  // no local media to spec-check, and the server 404s (media_missing) otherwise
  // (console noise, never a real advisory).
  const { data: validateMedia } = useValidateMedia(post?.campaign, post?.id, isEdit && postNeedsMedia(post), post?.rev);
  // B9: in create mode an "Attach to a post" CTA may pass a seed { mediaPath, type }
  // built from the same data.dir VideoPicker reads, so the media path matches the
  // canonical `${assetsDir}/${file}` shape and the picker shows it as selected. The
  // seed is ignored in edit mode (the post's own fields win).
  const seedMediaPath = !isEdit ? seed?.mediaPath || '' : '';
  // U: the ordered slide refs a library multi-select attach seeds a fresh album with.
  const seedMediaItems = !isEdit && Array.isArray(seed?.mediaItems) ? seed.mediaItems.filter(Boolean) : [];
  const seedType = !isEdit && TYPES.includes(seed?.type) ? seed.type : null;
  // The Radar "answer as a post" path seeds a starting caption (the thread's line + link);
  // plain pre-fill, same rules as the media seed - create mode only, gated createPost unchanged.
  const seedCaption = !isEdit ? seed?.caption || '' : '';

  const [campaign, setCampaign] = useState(isEdit ? post.campaign : campaigns.find((c) => c.active)?.id || campaigns[0]?.id || '');
  const [id, setId] = useState(isEdit ? post.id : '');
  const [idEdited, setIdEdited] = useState(isEdit);
  const [type, setType] = useState(isEdit ? post.type : seedType || 'reel');
  const [platforms, setPlatforms] = useState(isEdit ? post.platforms : ['instagram']);
  const [scheduledIso, setScheduledIso] = useState(isEdit ? post.scheduledAt || null : null);
  const [caption, setCaption] = useState(isEdit ? post.caption : seedCaption);
  const [firstComment, setFirstComment] = useState(isEdit ? post.firstComment || '' : '');
  const [altText, setAltText] = useState(isEdit ? post.altText || '' : '');
  const [title, setTitle] = useState(isEdit ? post.title || '' : '');
  const [link, setLink] = useState(isEdit ? post.link || '' : '');
  const [image, setImage] = useState(isEdit ? post.image || '' : '');
  // Specs 17+39: the public media URL for the URL-only lanes (pinterest pin /
  // video-pin cover, instagram feed IMAGE container). The operator vouches it
  // serves the same image as the attached local render.
  const [imageUrl, setImageUrl] = useState(isEdit ? post.imageUrl || '' : '');
  const [mediaPath, setMediaPath] = useState(isEdit ? post.media?.path || '' : seedMediaPath);
  // Spec 05: native-carousel ordered slides as an array of media ref strings (the same
  // `${assetsDir}/${file}` shape the single VideoPicker emits for a resolved pick),
  // serialized to mediaItems:[{file}|{path}] at save time. Seeded from the RAW
  // post.mediaItems (surfaced verbatim on the DTO), NOT the resolved post.media.items[]:
  // a slide whose file is not yet on disk (path:null, e.g. an MCP-authored { file:'c.jpg' }
  // before the render lands) resolves to path:null and would be DROPPED by a resolved seed,
  // so ANY later save (which sends the full slide set) would silently delete it from the
  // plan. Seeding from raw preserves every ref (PostDetail already tolerates a missing
  // slide with an amber badge). carouselRawRefs remembers each seeded ref's ORIGINAL
  // { file } vs { path } shape so an untouched unresolved slide round-trips losslessly on
  // save (a new picker pick is an absolute path -> { path }); see mediaItemsPayload.
  const [mediaItems, setMediaItems] = useState(isEdit ? carouselSeedRefs(isEdit, post) : seedMediaItems);
  const carouselRawRefs = useRef(new Map(
    (isEdit && Array.isArray(post.mediaItems) ? post.mediaItems : [])
      .filter((it) => it && (it.path || it.file))
      .map((it) => [String(it.path || it.file), it.path ? { path: it.path } : { file: it.file }]),
  ));
  // Spec 39: per-slide PUBLIC urls (IG IMAGE children publish from these), keyed by
  // the same ref string as carouselRawRefs so reorder/remove keeps each url with
  // its slide. Editable in the CarouselPicker for image-kind slides when
  // instagram is targeted; blank removes the url on save.
  const [slideUrls, setSlideUrls] = useState(() => Object.fromEntries(
    (isEdit && Array.isArray(post?.mediaItems) ? post.mediaItems : [])
      .filter((it) => it && (it.path || it.file) && it.url)
      .map((it) => [String(it.path || it.file), it.url]),
  ));
  const [description, setDescription] = useState(isEdit ? post.description || '' : '');
  const [liDescription, setLiDescription] = useState(isEdit ? post.liDescription || '' : '');
  // X per-platform tweet-text override (capped 280); empty falls back to caption.
  const [xCaption, setXCaption] = useState(isEdit ? post.xCaption || '' : '');
  // X reply-chain intent: the same-campaign post id this tweet threads under.
  // Empty saves as null - the escape hatch for a dangling reference (parent
  // deleted -> the fail-closed X lane holds the child forever).
  const [xReplyTo, setXReplyTo] = useState(isEdit ? post.xReplyTo || '' : '');
  // Thread split (X hard cap): pending continuation texts, materialized as
  // sibling posts (xReplyTo chain) AFTER the main post saves. Each becomes its
  // own approvable draft - the split never publishes anything by itself.
  const [threadParts, setThreadParts] = useState([]);
  const threadOriginalRef = useRef(null);
  const [tags, setTags] = useState(isEdit ? post.tags || '' : '');
  const [blogSlug, setBlogSlug] = useState(isEdit ? post.blogSlug || '' : '');
  // Wave-2 article fields (wordpress/ghost): markdown body (falls back to the
  // caption when empty), short excerpt, Ghost's canonical source URL + the
  // "also send as newsletter" opt-in.
  const [body, setBody] = useState(isEdit ? post.body || '' : '');
  const [excerpt, setExcerpt] = useState(isEdit ? post.excerpt || '' : '');
  // Spec 13: rich long-form metadata - SEO meta title/description + feature-image
  // alt (wordpress/ghost), WordPress-only category taxonomy (distinct from tags).
  const [metaTitle, setMetaTitle] = useState(isEdit ? post.metaTitle || '' : '');
  const [metaDescription, setMetaDescription] = useState(isEdit ? post.metaDescription || '' : '');
  const [wpCategories, setWpCategories] = useState(isEdit ? post.wpCategories || '' : '');
  const [featureImageAlt, setFeatureImageAlt] = useState(isEdit ? post.featureImageAlt || '' : '');
  // Spec 27: draft/pending-review publish status - hand off a native WordPress
  // draft or the TikTok inbox for a human to finish + publish. Approval (§H.2)
  // still gates whether the engine may act at all; this only changes the
  // destination status once that gate has passed.
  const [publishAsDraft, setPublishAsDraft] = useState(isEdit ? post.publishAsDraft === true : false);
  const [canonicalUrl, setCanonicalUrl] = useState(isEdit ? post.canonicalUrl || '' : '');
  const [ghostEmail, setGhostEmail] = useState(isEdit ? post.ghostEmail === true : false);
  // Spec 01: Ghost newsletter refinements, nested under the ghostEmail opt-in -
  // which newsletter (blank = first active), which audience segment (blank =
  // every subscriber), and email-only (no web version).
  const [newsletter, setNewsletter] = useState(isEdit ? post.newsletter || '' : '');
  const [emailSegment, setEmailSegment] = useState(isEdit ? post.emailSegment || '' : '');
  const [emailOnly, setEmailOnly] = useState(isEdit ? post.emailOnly === true : false);
  // Per-platform note overrides (additive xCaption pattern); empty falls back
  // to the shared caption.
  const [mastodonCaption, setMastodonCaption] = useState(isEdit ? post.mastodonCaption || '' : '');
  const [nostrCaption, setNostrCaption] = useState(isEdit ? post.nostrCaption || '' : '');
  // B1 (ux-audit dim-6 P1): the remaining per-lane prose overrides the engines
  // publish - MCP-writable, so the approver must be able to see and author them
  // here too. Same additive xCaption pattern; empty falls back to the caption
  // (pinTitle falls back to the title - the engine's pinTitle || title).
  const [tgCaption, setTgCaption] = useState(isEdit ? post.tgCaption || '' : '');
  const [dcCaption, setDcCaption] = useState(isEdit ? post.dcCaption || '' : '');
  const [ttCaption, setTtCaption] = useState(isEdit ? post.ttCaption || '' : '');
  const [redditText, setRedditText] = useState(isEdit ? post.redditText || '' : '');
  const [pinTitle, setPinTitle] = useState(isEdit ? post.pinTitle || '' : '');
  const [pinDescription, setPinDescription] = useState(isEdit ? post.pinDescription || '' : '');
  // Spec 16: the Reddit link submission URL + the picked link-flair template (id + the
  // editable-template text). The flair select drives both id and text together.
  const [redditUrl, setRedditUrl] = useState(isEdit ? post.redditUrl || '' : '');
  const [redditFlairId, setRedditFlairId] = useState(isEdit ? post.redditFlairId || '' : '');
  const [redditFlairText, setRedditFlairText] = useState(isEdit ? post.redditFlairText || '' : '');
  // Spec 36: the per-post destination subreddit (falls back to the connection default).
  const [redditSubreddit, setRedditSubreddit] = useState(isEdit ? post.redditSubreddit || '' : '');
  // Spec 37: organic-vs-promotional. Default PROMO (absence = promo, the safe manual-tier
  // default); an existing post is organic only when isPromo === false was explicitly set.
  const [isPromo, setIsPromo] = useState(isEdit ? post.isPromo !== false : true);
  // Spec 17: the Pinterest board-section target (rides POST /v5/pins on either pin path).
  const [pinBoardSection, setPinBoardSection] = useState(isEdit ? post.pinBoardSection || '' : '');
  // GBP local-post intent as flat form state; serialized back to a post.gbp
  // object (or null when it says nothing) at save time.
  const [gbp, setGbp] = useState(isEdit ? gbpFormState(post.gbp) : gbpFormState(null));
  // Spec 14: Telegram CTA + Discord embed, as flat form state serialized back to
  // post.tgCta/post.dcEmbed (or null when neither carries content) at save time.
  const [tgCta, setTgCta] = useState(isEdit ? tgCtaFormState(post.tgCta) : tgCtaFormState(null));
  const [dcEmbed, setDcEmbed] = useState(isEdit ? dcEmbedFormState(post.dcEmbed) : dcEmbedFormState(null));
  // Spec 26: Discord forum/thread targeting (plain content strings, mutually
  // exclusive - platformValidate warns) + the guild-scheduled-event intent as
  // flat form state (mirrors dcEmbed/gbp), serialized back to post.dcEvent (or
  // null when it says nothing) at save time.
  const [dcThreadName, setDcThreadName] = useState(isEdit ? post.dcThreadName || '' : '');
  const [dcThreadId, setDcThreadId] = useState(isEdit ? post.dcThreadId || '' : '');
  const [dcEvent, setDcEvent] = useState(isEdit ? dcEventFormState(post.dcEvent) : dcEventFormState(null));
  // Spec 25: disclosure & interaction settings - TikTok interaction/disclosure
  // flags (structured, mirrors gbp/tgCta/dcEmbed), a Mastodon content-warning
  // text, and an X reply-audience enum.
  const [ttInteraction, setTtInteraction] = useState(isEdit ? ttInteractionFormState(post.ttInteraction) : ttInteractionFormState(null));
  const [spoilerText, setSpoilerText] = useState(isEdit ? post.spoilerText || '' : '');
  const [xReplySettings, setXReplySettings] = useState(isEdit ? post.xReplySettings || '' : '');
  // Spec 10: native-poll options/duration as flat form state, serialized back to
  // post.poll (or null for a non-poll post) at save time.
  const [poll, setPoll] = useState(isEdit ? pollFormState(post.poll) : pollFormState(null));
  // FR4: interactive-story stickers + per-post hashtags override. hashtagsMode
  // 'global' inherits the global presets (hashtags payload = null); 'custom' sends
  // the typed list. On edit, an existing post.hashtags array switches to custom.
  const [stickers, setStickers] = useState(isEdit ? post.interactiveStory?.stickers || [] : []);
  const [hashtagsMode, setHashtagsMode] = useState(isEdit && Array.isArray(post.hashtags) ? 'custom' : 'global');
  const [hashtags, setHashtags] = useState(isEdit && Array.isArray(post.hashtags) ? post.hashtags.join(' ') : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [showPreview, setShowPreview] = useState(false);
  const idRef = useRef(null);
  const xReplyToRef = useRef(null);
  // Focus targets for the no-platforms / no-campaign save() guards, mirroring
  // idRef so a keyboard user lands on the blocking field, not just an alert.
  const platformsFieldsetRef = useRef(null);
  const campaignSelectRef = useRef(null);
  const scheduleFieldRef = useRef(null);
  // B9: guard the one-shot SRT caption seed so it runs at most once (and only
  // until the operator starts editing the caption).
  const srtSeededRef = useRef(false);

  // Snapshot the editable fields at mount so the close handler can warn before
  // discarding a drafted caption/video (finding #12). Captured once via the lazy
  // initializer; the live values below are diffed against it for isDirty. The owner
  // confirms before a dirty draft is dropped.
  const [initialSnapshot] = useState(() => JSON.stringify({
    campaign: isEdit ? post.campaign : campaigns.find((c) => c.active)?.id || campaigns[0]?.id || '',
    id: isEdit ? post.id : '',
    type: isEdit ? post.type : seedType || 'reel',
    platforms: isEdit ? post.platforms : ['instagram'],
    scheduledIso: isEdit ? post.scheduledAt || null : null,
    caption: isEdit ? post.caption : '',
    firstComment: isEdit ? post.firstComment || '' : '',
    altText: isEdit ? post.altText || '' : '',
    title: isEdit ? post.title || '' : '',
    link: isEdit ? post.link || '' : '',
    image: isEdit ? post.image || '' : '',
    imageUrl: isEdit ? post.imageUrl || '' : '',
    mediaPath: isEdit ? post.media?.path || '' : seedMediaPath,
    mediaItems: isEdit ? carouselSeedRefs(isEdit, post) : seedMediaItems,
    slideUrls: Object.fromEntries((isEdit && Array.isArray(post?.mediaItems) ? post.mediaItems : []).filter((it) => it && (it.path || it.file) && it.url).map((it) => [String(it.path || it.file), it.url])),
    description: isEdit ? post.description || '' : '',
    liDescription: isEdit ? post.liDescription || '' : '',
    xCaption: isEdit ? post.xCaption || '' : '',
    xReplyTo: isEdit ? post.xReplyTo || '' : '',
    tags: isEdit ? post.tags || '' : '',
    blogSlug: isEdit ? post.blogSlug || '' : '',
    body: isEdit ? post.body || '' : '',
    excerpt: isEdit ? post.excerpt || '' : '',
    metaTitle: isEdit ? post.metaTitle || '' : '',
    metaDescription: isEdit ? post.metaDescription || '' : '',
    wpCategories: isEdit ? post.wpCategories || '' : '',
    featureImageAlt: isEdit ? post.featureImageAlt || '' : '',
    publishAsDraft: isEdit ? post.publishAsDraft === true : false,
    canonicalUrl: isEdit ? post.canonicalUrl || '' : '',
    ghostEmail: isEdit ? post.ghostEmail === true : false,
    newsletter: isEdit ? post.newsletter || '' : '',
    emailSegment: isEdit ? post.emailSegment || '' : '',
    emailOnly: isEdit ? post.emailOnly === true : false,
    mastodonCaption: isEdit ? post.mastodonCaption || '' : '',
    nostrCaption: isEdit ? post.nostrCaption || '' : '',
    tgCaption: isEdit ? post.tgCaption || '' : '',
    dcCaption: isEdit ? post.dcCaption || '' : '',
    ttCaption: isEdit ? post.ttCaption || '' : '',
    redditText: isEdit ? post.redditText || '' : '',
    pinTitle: isEdit ? post.pinTitle || '' : '',
    pinDescription: isEdit ? post.pinDescription || '' : '',
    redditUrl: isEdit ? post.redditUrl || '' : '',
    redditFlairId: isEdit ? post.redditFlairId || '' : '',
    redditFlairText: isEdit ? post.redditFlairText || '' : '',
    redditSubreddit: isEdit ? post.redditSubreddit || '' : '',
    isPromo: isEdit ? post.isPromo !== false : true,
    pinBoardSection: isEdit ? post.pinBoardSection || '' : '',
    gbp: isEdit ? gbpFormState(post.gbp) : gbpFormState(null),
    tgCta: isEdit ? tgCtaFormState(post.tgCta) : tgCtaFormState(null),
    dcEmbed: isEdit ? dcEmbedFormState(post.dcEmbed) : dcEmbedFormState(null),
    dcThreadName: isEdit ? post.dcThreadName || '' : '',
    dcThreadId: isEdit ? post.dcThreadId || '' : '',
    dcEvent: isEdit ? dcEventFormState(post.dcEvent) : dcEventFormState(null),
    ttInteraction: isEdit ? ttInteractionFormState(post.ttInteraction) : ttInteractionFormState(null),
    spoilerText: isEdit ? post.spoilerText || '' : '',
    xReplySettings: isEdit ? post.xReplySettings || '' : '',
    poll: isEdit ? pollFormState(post.poll) : pollFormState(null),
    stickers: isEdit ? post.interactiveStory?.stickers || [] : [],
    hashtagsMode: isEdit && Array.isArray(post.hashtags) ? 'custom' : 'global',
    hashtags: isEdit && Array.isArray(post.hashtags) ? post.hashtags.join(' ') : '',
  }));

  // The single platform whose caps the live lint should use (most-permissive of
  // the multi-select). Memoized so useLint's effect deps stay stable while typing.
  const lintPlatform = useMemo(() => representativePlatform(platforms), [platforms]);
  const lint = useLint(caption, lintPlatform);
  const descLint = useLint(description, lintPlatform);
  const commentLint = useLint(firstComment, lintPlatform); // S4: anti-slop the first comment too
  const assets = useMemo(() => assetsData?.assets || [], [assetsData]);
  const assetsDir = assetsData?.dir || '';
  // B10: the inherited global hashtag presets, read from the active client's
  // config (same shape Settings.jsx reads). Guarded so a still-loading config
  // never crashes the global-mode panel; the InteractiveFields fallback copy
  // shows when the array is empty.
  const globalHashtags = useMemo(() => configData?.posting?.hashtagPresets || [], [configData]);
  const selectedAsset = useMemo(() => assets.find((a) => `${assetsDir}/${a.file}` === mediaPath), [assets, assetsDir, mediaPath]);
  const campaignPosts = useMemo(() => campaigns.find((c) => c.id === campaign)?.posts || [], [campaigns, campaign]);
  // The picker offers only connected + enabled + not-skipped lanes, EXCEPT it always
  // keeps any lane the post being edited already targets so a real target is never
  // silently dropped. Union of visiblePlatforms(accounts, posting) and the post's
  // ORIGINAL targets (never the live selection: derived from the selection, deselecting
  // a targeted-but-unconnected lane unrendered its chip on the first click with no way
  // back), in PLATFORMS order. Falls back to the full list when accounts/posting are
  // unavailable, so the picker is never empty on any render path.
  const pickerPlatforms = useMemo(() => {
    if (!accounts) return PLATFORMS;
    const visible = visiblePlatforms(accounts, posting);
    const allowed = new Set([...visible, ...(isEdit ? post.platforms : [])]);
    return PLATFORMS.filter((p) => allowed.has(p));
  }, [accounts, posting, isEdit, post]);
  // Are all offered platforms selected? Drives the select-all/clear control's label.
  const allPlatformsSelected = pickerPlatforms.length > 0 && pickerPlatforms.every((p) => platforms.includes(p));
  // The SHARED field-relevance model (lib/format.js), consumed identically by the
  // PostDetail review dialog so the authoring form and the review view can never
  // drift on which fields a post uses. Every conditional field below gates on
  // `rel.<field>` instead of an ad-hoc inline check.
  const rel = useMemo(() => fieldRelevance(platforms, type), [platforms, type]);
  // Spec 16: the connected subreddit + its link-flair templates for the flair picker.
  // Only fetched when reddit is actually targeted (rel.redditFlairId), so a non-reddit
  // post never hits the read. A scope-absent/failed read resolves ok:false -> the picker
  // shows an honest "flair unavailable" affordance (publishing still works flair-less).
  const connectedSubreddit = accounts?.reddit?.subreddit || '';
  // Spec 36: the flair picker + hints key to the EFFECTIVE sub - the per-post
  // redditSubreddit (a leading r/ stripped) else the connection default.
  const effectiveSubreddit = (redditSubreddit || '').replace(/^\/?r\//, '').trim() || connectedSubreddit;
  const { data: redditFlairsData, isLoading: redditFlairsLoading, isError: redditFlairsError } = useRedditFlairs(effectiveSubreddit, rel.redditFlairId);
  const redditFlairs = useMemo(() => (redditFlairsData?.ok ? redditFlairsData.items || [] : []), [redditFlairsData]);
  // A transport failure (react-query isError, data:undefined) OR an explicit ok:false read
  // both mean "couldn't load flairs" - map BOTH to the unavailable affordance, never the
  // empty "no flairs" state (which would masquerade a failed read as a flair-less sub).
  const redditFlairsUnavailable = Boolean(redditFlairsError) || (Boolean(redditFlairsData) && redditFlairsData.ok === false);
  // Spec 17: the connected board's sections for the Pinterest section picker. Only
  // fetched when pinterest is actually targeted (rel.pinBoardSection); a read
  // failure resolves ok:false (never a false-empty items:[]) so the select shows an
  // honest "unavailable" affordance - publishing still works with no section picked.
  const pinterestBoardId = accounts?.pinterest?.boardId || '';
  const { data: pinterestSectionsData, isLoading: pinterestSectionsLoading, isError: pinterestSectionsError } = usePinterestBoardSections(pinterestBoardId, rel.pinBoardSection);
  const pinterestSections = useMemo(() => (pinterestSectionsData?.ok ? pinterestSectionsData.items || [] : []), [pinterestSectionsData]);
  const pinterestSectionsUnavailable = Boolean(pinterestSectionsError) || (Boolean(pinterestSectionsData) && pinterestSectionsData.ok === false);
  // Single-lane override collapse (shared rule, lib/format.js): a post targeting
  // ONE override lane authors ONE text — the caption — so its override field is
  // hidden unless it already carries content (saved on the post, or typed in
  // this session before the platform set changed). Covers every OVERRIDE_FIELD
  // lane (x/mastodon/nostr + the B1 lanes telegram/discord/tiktok/reddit/pinterest).
  const hiddenOverride = useMemo(() => collapsedOverrideKey(platforms, {
    xCaption: (isEdit && post.xCaption) || xCaption,
    mastodonCaption: (isEdit && post.mastodonCaption) || mastodonCaption,
    nostrCaption: (isEdit && post.nostrCaption) || nostrCaption,
    tgCaption: (isEdit && post.tgCaption) || tgCaption,
    dcCaption: (isEdit && post.dcCaption) || dcCaption,
    ttCaption: (isEdit && post.ttCaption) || ttCaption,
    redditText: (isEdit && post.redditText) || redditText,
    pinDescription: (isEdit && post.pinDescription) || pinDescription,
  }), [platforms, isEdit, post, xCaption, mastodonCaption, nostrCaption, tgCaption, dcCaption, ttCaption, redditText, pinDescription]);
  const isLinkedinArticle = platforms.includes('linkedin') && type === 'text';
  // Article authoring (wave 2): the long-form fields apply whenever a blog lane
  // is targeted - WordPress and Ghost publish title + markdown body (falling
  // back to the caption), excerpt, hero image and tags.
  const isArticle = platforms.includes('wordpress') || platforms.includes('ghost');
  // Spec 18: a Nostr NIP-23 long-form article (kind 30023) - reuses the blog long-form
  // authoring fields (title/body/excerpt/image/hashtags); media-less (the image is a
  // URL tag, not an uploaded render). Only offered when nostr is targeted.
  const isNostrArticle = platforms.includes('nostr') && type === 'nostr-longform';
  const showGbp = rel.gbp;
  // A poll is media-less like a text post - hide the VideoPicker (spec 10). A carousel
  // is media-BACKED but multi-file, so it swaps the single VideoPicker for the
  // CarouselPicker (spec 05) - hide the single picker here. A nostr-longform article is
  // media-less too (spec 18: the header image is a URL, not a local render).
  const needsMedia = type !== 'text' && type !== 'poll' && type !== 'carousel' && type !== 'nostr-longform';
  // Nothing to preview: a pure text/poll/carousel/nostr-longform post with no link and
  // no image, targeting neither a blog lane nor LinkedIn, renders no single-media card
  // (PostPreview returns null). Mirror that here so we hide the "Vorschau" label +
  // toggle rather than leave an empty labelled region dangling over nothing (a carousel
  // previews its slides inline in the CarouselPicker, not the single-media card).
  const nothingToPreview = !isLinkedinArticle && !isArticle && (type === 'text' || type === 'poll' || type === 'carousel' || type === 'nostr-longform') && !link && !image;
  const showFirstComment = rel.firstComment;
  // FR4: interactive-story authoring applies only to an Instagram story - there is
  // no story surface to attach stickers to for any other type or platform.
  const showInteractive = rel.interactiveStory;

  // Note-override counters (findings r2-1/r2-3): the effective text is the
  // per-platform override else the shared caption; CharCounter +
  // useOverLimitAnnounce carry the shared accessibility contract (icon +
  // sr-only severity, transition-only announce). X caps at 280, Mastodon at 500.
  const xLen = (xCaption || caption).length;
  const xOver = xLen > CAPTION_CAPS.x;
  const xOverAnnounce = useOverLimitAnnounce(xOver, xLen, CAPTION_CAPS.x);
  const mastodonLen = (mastodonCaption || caption).length;
  const mastodonOver = mastodonLen > CAPTION_CAPS.mastodon;
  const mastodonOverAnnounce = useOverLimitAnnounce(mastodonOver, mastodonLen, CAPTION_CAPS.mastodon);

  // Unsaved-changes guard (finding #12): diff the live editable fields against the
  // mount snapshot; the close handler confirms before discarding a dirty draft.
  const isDirty = useMemo(
    // Key order MUST mirror the initialSnapshot literal exactly: JSON.stringify
    // preserves insertion order, so a mis-ordered key (altText once trailed here
    // while the snapshot lists it after firstComment) makes the strings differ
    // forever and the composer reads dirty from mount.
    // The id is compared only once the OWNER edited it: the auto-suggest effect
    // (suggestPostId) rewrites it right after mount, and a machine suggestion
    // must never make an untouched composer read dirty.
    () => JSON.stringify({
      campaign, id: idEdited ? id : '', type, platforms, scheduledIso, caption, firstComment, altText, title,
      link, image, imageUrl, mediaPath, mediaItems, slideUrls, description, liDescription, xCaption, xReplyTo, tags, blogSlug,
      body, excerpt, metaTitle, metaDescription, wpCategories, featureImageAlt, publishAsDraft, canonicalUrl, ghostEmail, newsletter, emailSegment, emailOnly, mastodonCaption, nostrCaption, tgCaption, dcCaption, ttCaption, redditText, pinTitle, pinDescription, redditUrl, redditFlairId, redditFlairText, redditSubreddit, isPromo, pinBoardSection, gbp, tgCta, dcEmbed, dcThreadName, dcThreadId, dcEvent,
      ttInteraction, spoilerText, xReplySettings, poll,
      stickers, hashtagsMode, hashtags,
    }) !== initialSnapshot,
    [campaign, id, idEdited, type, platforms, scheduledIso, caption, firstComment, title, link, image, imageUrl, mediaPath, mediaItems, slideUrls, description, liDescription, xCaption, xReplyTo, tags, blogSlug, body, excerpt, metaTitle, metaDescription, wpCategories, featureImageAlt, publishAsDraft, canonicalUrl, ghostEmail, newsletter, emailSegment, emailOnly, mastodonCaption, nostrCaption, tgCaption, dcCaption, ttCaption, redditText, pinTitle, pinDescription, redditUrl, redditFlairId, redditFlairText, redditSubreddit, isPromo, pinBoardSection, gbp, tgCta, dcEmbed, dcThreadName, dcThreadId, dcEvent, ttInteraction, spoilerText, xReplySettings, poll, stickers, hashtagsMode, hashtags, altText, initialSnapshot],
  );

  // Report dirtiness upward so App's client-switch guard (lib/clientSwitchGuard.js)
  // can refuse a silent re-scope while this draft is unsaved. Cleared on unmount.
  useEffect(() => {
    if (!onDirtyChange) return undefined;
    onDirtyChange(isDirty);
    return () => onDirtyChange(false);
  }, [isDirty, onDirtyChange]);

  const requestClose = async () => {
    if (isDirty) {
      const ok = await confirm({
        title: t('composer.discard.title'),
        // B4: name the active client so the owner knows whose draft is discarded.
        body: activeClient?.displayName
          ? `${t('composer.discard.body')}\n\n${t('confirm.forClient', { client: activeClient.displayName })}`
          : t('composer.discard.body'),
        confirmLabel: t('composer.discard.confirm'),
        danger: true,
        rememberKey: 'composer.discard',
      });
      if (!ok) return;
    }
    onClose();
  };

  // Auto-suggest the next free post ID (create only, until the owner edits it).
  useEffect(() => {
    if (!isEdit && !idEdited) setId(suggestPostId(type, campaignPosts));
  }, [type, campaignPosts, isEdit, idEdited]);

  // B9: best-effort seed the caption from the attached asset's voiceover SRT. Runs
  // once, only in create mode with a seeded media path whose asset carries
  // captions[]. The SRT is fetched from its local /media?p=... URL (a 127.0.0.1
  // read, no new endpoint) and reduced to plain cue text via srtToText. Strictly
  // best-effort: an absent sidecar, a failed fetch, or an empty transcript leaves
  // the caption empty so attaching never blocks draft creation. A pre-existing
  // caption (user already typed) is never clobbered.
  useEffect(() => {
    if (isEdit || srtSeededRef.current) return undefined;
    if (!seedMediaPath || !selectedAsset || !selectedAsset.captions?.length) return undefined;
    srtSeededRef.current = true;
    // Deterministic pick: prefer the active UI locale's language, else the first.
    const lang = (locale || '').slice(0, 2).toLowerCase();
    const captions = selectedAsset.captions;
    const chosen = captions.find((c) => (c.lang || '').toLowerCase() === lang) || captions[0];
    if (!chosen?.srtUrl) return undefined;
    let cancelled = false;
    fetch(chosen.srtUrl)
      .then((res) => (res && res.ok ? res.text() : ''))
      .then((text) => {
        if (cancelled) return;
        const seeded = srtToText(text);
        // Only fill an empty caption (do not overwrite typing-in-progress).
        if (seeded) setCaption((prev) => (prev ? prev : seeded));
      })
      .catch(() => { /* best-effort: leave the caption empty */ });
    return () => { cancelled = true; };
    // Intentionally one-shot (srtSeededRef guard); selectedAsset is the resolved
    // asset for the seeded path and stable for this mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, seedMediaPath, selectedAsset, locale]);

  // B10 Part B: a pending change strands the interactive stickers when the
  // IG-story surface is currently showing them (showInteractive && stickers.length)
  // and the change would flip that surface off - i.e. moving the type off 'story'
  // or deselecting instagram. With 0 stickers there is nothing to strand. The
  // async confirm() must settle BEFORE the controlled state commits so a cancel
  // leaves the select/toggle untouched; on confirm we both apply the change and
  // clear the now-orphaned stickers.
  const confirmStrand = () => confirm({
    title: t('composer.stranded.title'),
    body: t('composer.stranded.body'),
    confirmLabel: t('composer.stranded.confirm'),
    danger: true,
    rememberKey: 'composer.strand',
  });

  const onTypeChange = async (next) => {
    const willStrand = showInteractive && stickers.length > 0 && next !== 'story';
    if (willStrand && !(await confirmStrand())) return;
    if (willStrand) setStickers([]);
    setType(next);
  };

  const togglePlatform = async (p) => {
    const willStrand = showInteractive && stickers.length > 0 && p === 'instagram' && platforms.includes(p);
    if (willStrand && !(await confirmStrand())) return;
    if (willStrand) setStickers([]);
    setPlatforms((prev) => (prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]));
  };

  // FR4: derive the payload shape from the authoring state. interactiveStory is
  // null unless this is an IG story with at least one sticker; hashtags is null
  // (inherit global presets) unless the operator chose a custom per-post list.
  const interactiveStoryPayload = showInteractive && stickers.length ? { stickers } : null;
  const hashtagsPayload = hashtagsMode === 'custom'
    ? hashtags.split(/[\s,]+/).map((h) => h.trim()).filter(Boolean)
    : null;
  // GBP intent, serialized from the flat form state: only the fields the chosen
  // topic/CTA actually use, and null when it says nothing at all (topic
  // standard, no CTA) - a plain "What's new" post needs no gbp object.
  const gbpPayload = (() => {
    if (!showGbp) return null;
    const hasCta = Boolean(gbp.ctaType);
    if (gbp.topic === 'standard' && !hasCta) return null;
    const out = { topic: gbp.topic };
    if (hasCta) {
      out.ctaType = gbp.ctaType;
      if (gbp.ctaType !== 'CALL' && gbp.ctaUrl) out.ctaUrl = gbp.ctaUrl;
    }
    if (gbp.topic === 'event') {
      if (gbp.eventTitle) out.eventTitle = gbp.eventTitle;
      if (gbp.eventStart) out.eventStart = gbp.eventStart;
      if (gbp.eventEnd) out.eventEnd = gbp.eventEnd;
    }
    if (gbp.topic === 'offer') {
      if (gbp.couponCode) out.couponCode = gbp.couponCode;
      if (gbp.redeemUrl) out.redeemUrl = gbp.redeemUrl;
      if (gbp.terms) out.terms = gbp.terms;
    }
    return out;
  })();

  // Spec 14: tgCta is null unless at least one complete button exists OR the
  // preview/format flags are non-default (a plain post needs no tgCta object -
  // the "byte-identical" empty scenario). An incomplete row (label typed, url
  // still empty, or vice versa) is dropped rather than sent half-formed; a
  // present-but-malformed url is kept so the server rejects it (bad-URL scenario).
  const tgCtaPayload = (() => {
    if (!rel.tgCta) return null;
    const buttons = tgCta.buttons
      .filter((b) => b.label.trim() && b.url.trim())
      .map((b) => ({ label: b.label.trim(), url: b.url.trim() }));
    const nonDefault = buttons.length > 0 || tgCta.linkPreview !== true || tgCta.format !== 'plain';
    return nonDefault ? { buttons, linkPreview: tgCta.linkPreview, format: tgCta.format } : null;
  })();
  // dcEmbed is null unless a field carries content. color is authored as a hex
  // string (#RRGGBB) and converted to the Discord wire integer here; an
  // unparsable value is simply omitted (never sent as garbage).
  const dcEmbedPayload = (() => {
    if (!rel.dcEmbed) return null;
    const out = {};
    if (dcEmbed.title.trim()) out.title = dcEmbed.title.trim();
    if (dcEmbed.description.trim()) out.description = dcEmbed.description.trim();
    if (dcEmbed.url.trim()) out.url = dcEmbed.url.trim();
    const hexMatch = /^#?([0-9a-fA-F]{6})$/.exec(dcEmbed.color.trim());
    if (hexMatch) out.color = parseInt(hexMatch[1], 16);
    return Object.keys(out).length ? out : null;
  })();

  // Spec 26 review: dcEvent is null unless the group is COMPLETE enough for
  // lib/writes.mjs to accept it - name + a parseable startTime always
  // required, plus (voice/stage) a channelId, or (external, the default) a
  // parseable endTime + non-empty location. An incomplete group (e.g. a
  // name-only draft, or an external event with no end/location yet) is
  // OMITTED from the payload entirely, mirroring the tgCta button-completeness
  // precedent above, rather than sent half-filled - validateFieldValues now
  // REJECTS an incomplete dcEvent outright (MAJOR-1), which would otherwise
  // block the WHOLE post save on a stray dcEvent.startTime:'' (MINOR-5).
  // entityType/channelId/description are carried through even though the
  // Composer never authors them itself, so an agent-authored voice/stage
  // event survives an unrelated owner tweak (MINOR-4). The <input
  // type="datetime-local"> value has no timezone, so it is converted to a
  // full ISO-8601 string (via the browser's own Date) HERE, at save time
  // (MAJOR-2) - never sent to the server verbatim.
  const dcEventPayload = (() => {
    if (!rel.dcEmbed) return null;
    const name = dcEvent.name.trim();
    const startIso = dcEventLocalToIso(dcEvent.startTime);
    if (!name || !startIso) return null;
    const entityType = dcEvent.entityType === 'voice' || dcEvent.entityType === 'stage' ? dcEvent.entityType : '';
    const isVoiceOrStage = Boolean(entityType);
    const channelId = dcEvent.channelId.trim();
    if (isVoiceOrStage && !channelId) return null;
    const endIso = dcEventLocalToIso(dcEvent.endTime);
    const location = dcEvent.location.trim();
    if (!isVoiceOrStage && (!endIso || !location)) return null;
    const out = { name, startTime: startIso };
    if (endIso) out.endTime = endIso;
    if (location) out.location = location;
    if (entityType) out.entityType = entityType;
    if (channelId) out.channelId = channelId;
    if (dcEvent.description.trim()) out.description = dcEvent.description.trim();
    return out;
  })();

  // Spec 25: ttInteraction is null unless at least one flag is toggled or a cover
  // timestamp is set (a plain upload needs no ttInteraction object - the "byte-
  // identical empty scenario"). Only true flags are sent (an untouched checkbox
  // is never forced false).
  const ttInteractionPayload = (() => {
    if (!rel.ttInteraction) return null;
    const out = {};
    for (const k of TT_INTERACTION_CHECKS) if (ttInteraction[k]) out[k] = true;
    // Floor a decimal (e.g. 1500.5) to a whole millisecond so it is preserved
    // rather than silently dropped by the integer check (validateFieldValues
    // requires a non-negative INTEGER coverTimestampMs).
    const ms = Math.floor(Number(ttInteraction.coverTimestampMs));
    if (ttInteraction.coverTimestampMs !== '' && Number.isInteger(ms) && ms >= 0) out.coverTimestampMs = ms;
    return Object.keys(out).length ? out : null;
  })();

  // Spec 10: the poll object (options trimmed + de-blanked, duration, multi-select).
  // Sent WHENEVER type=poll (rel.poll) - even with < 2 options - so the draft saves
  // and Prüfen (platform_validate) surfaces the "needs at least 2 options" problem
  // (spec §2); a non-poll post sends null (clears any stale poll). `multiple` rides
  // only when set, mirroring the byte-identical-empty idiom of the sibling blocks.
  const pollMax = pollMaxOptions(platforms);
  const pollPayload = rel.poll
    ? { options: poll.options.map((o) => o.trim()).filter(Boolean), durationMinutes: poll.durationMinutes, ...(poll.multiple ? { multiple: true } : {}) }
    : null;

  // Spec 05: the ordered carousel slides ({ path } refs, blanks dropped). Sent WHENEVER
  // type=carousel (rel.mediaItems) - even with < 2 slides - so the draft saves and Prüfen
  // surfaces the "needs at least 2 media items" problem (spec §2); a non-carousel post
  // sends null (clears any stale slide set). The tightest targeted-lane cap gates the
  // add control in the picker (min across x=4/pinterest=5/ig=telegram=discord=10/li=20/
  // reddit=20).
  const carouselMax = (() => {
    const caps = (platforms || []).map((p) => CAROUSEL_LANE_MAX[p]).filter((n) => typeof n === 'number');
    // H4: with no carousel-capable lane targeted, the bound is the STRUCTURAL one the
    // server enforces. The old fallback of 10 was invented and hid Add on a lawful album.
    return caps.length ? Math.min(...caps) : CAROUSEL_STRUCTURAL_MAX;
  })();
  // Preserve each ref's ORIGINAL { file } vs { path } shape on save: an untouched seeded
  // slide re-emits verbatim (a relative { file } stays { file } - flattening it to { path }
  // would mis-anchor its on-disk resolution), while a freshly picked slide (an absolute
  // `${assetsDir}/${file}` value not in the ref map) serializes to { path }. This is what
  // makes an unresolved MCP-authored slide survive a round-trip save instead of vanishing.
  const mediaItemsPayload = rel.mediaItems
    ? mediaItems.map((p) => String(p || '').trim()).filter(Boolean).map((p) => {
      const { url: _seededUrl, ...base } = carouselRawRefs.current.get(p) || { path: p };
      const u = String(slideUrls[p] || '').trim();
      return u ? { ...base, url: u } : base;
    })
    : null;

  // The preview's media for a CAROUSEL, resolved from the slides actually picked in this
  // form. Without it the preview always read post.media.items as empty and printed
  // "No slides yet" directly above two attached slides: the screen contradicting itself
  // in one glance. Resolved the same way selectedAsset resolves the single picker, so a
  // ref that is not in the library yet reads honestly as exists:false rather than
  // vanishing.
  const previewItems = type === 'carousel'
    ? mediaItems.map((ref) => String(ref || '').trim()).filter(Boolean).map((ref) => {
      const a = assets.find((x) => `${assetsDir}/${x.file}` === ref);
      return a
        ? { file: a.file, url: a.url, path: ref, exists: true, resolution: a.checks?.resolution || null }
        : { file: ref.split('/').pop() || null, url: null, path: ref, exists: false, resolution: null };
    })
    : [];

  const previewPost = {
    type,
    platforms,
    title,
    caption,
    link,
    image,
    excerpt,
    description,
    liDescription,
    xCaption,
    tags,
    interactiveStory: interactiveStoryPayload,
    media: type === 'carousel'
      ? { url: null, cover: null, file: null, items: previewItems }
      : (selectedAsset ? { url: selectedAsset.url, cover: selectedAsset.cover || null, file: selectedAsset.file } : null),
  };

  const save = async () => {
    setError(null);
    if (!isEdit && !/^[a-zA-Z0-9_-]+$/.test(id)) {
      setError(t('composer.error.idFormat'));
      idRef.current?.focus();
      return;
    }
    // Reply-chain target: same charset as post ids (mirrors lib/writes.mjs
    // ID_RE) and never the post itself - a self-thread can never publish.
    const xReplyToClean = xReplyTo.trim();
    if (xReplyToClean && (!/^[a-zA-Z0-9_-]+$/.test(xReplyToClean) || xReplyToClean === (isEdit ? post.id : id))) {
      setError(t('composer.error.xReplyToFormat'));
      xReplyToRef.current?.focus();
      return;
    }
    if (!platforms.length) {
      setError(t('composer.error.noPlatform'));
      // The platform chips carry aria-pressed; the select-all control does not, so this
      // targets the first actual platform toggle, not the select-all button beside it.
      platformsFieldsetRef.current?.querySelector('button[aria-pressed]')?.focus();
      return;
    }
    // US-CFG-12: on a brand-new project the campaign select is empty; refuse to
    // create a post with no campaign rather than let createPost('', ...) fail
    // silently. (Edit mode always carries the post's own campaign.)
    if (!isEdit && !campaign) {
      setError(t('composer.error.noCampaign'));
      campaignSelectRef.current?.focus();
      return;
    }
    // A Termin (date+time) is mandatory - a time-less post never publishes, so it
    // may not be saved without one (mirrors the server createPost gate). Covers
    // create AND edit; both branches send scheduledAt: scheduledIso below.
    if (!scheduledIso) {
      setError(t('composer.error.noSchedule'));
      scheduleFieldRef.current?.querySelector('button')?.focus();
      return;
    }
    setBusy(true);
    try {
      // R6b receipt: the create/update response carries the humanizer gate's own
      // change report ({fixes, findings}) when it rewrote prose at save (present-
      // when-telly, absent-when-clean; lib/writes.mjs). Thread it to onSaved so the
      // App shell can show ONE quiet dismissable line naming what was auto-fixed.
      let saveRes;
      if (isEdit) {
        saveRes = await updatePost(post.campaign, post.id, post.rev, {
          type,
          platforms,
          scheduledAt: scheduledIso,
          caption,
          firstComment: firstComment || null,
          title: title || null,
          link: link || null,
          image: image || null,
          imageUrl: imageUrl.trim() || null,
          path: mediaPath || null,
          description: description || null,
          liDescription: liDescription || null,
          xCaption: xCaption || null,
          xReplyTo: xReplyToClean || null,
          tags: tags || null,
          blogSlug: blogSlug || null,
          body: body || null,
          excerpt: excerpt || null,
          metaTitle: metaTitle || null,
          metaDescription: metaDescription || null,
          wpCategories: wpCategories || null,
          featureImageAlt: featureImageAlt || null,
          publishAsDraft: publishAsDraft === true ? true : null,
          canonicalUrl: canonicalUrl || null,
          ghostEmail: ghostEmail === true ? true : null,
          newsletter: newsletter || null,
          emailSegment: emailSegment || null,
          emailOnly: emailOnly === true ? true : null,
          mastodonCaption: mastodonCaption || null,
          nostrCaption: nostrCaption || null,
          tgCaption: tgCaption || null,
          dcCaption: dcCaption || null,
          ttCaption: ttCaption || null,
          redditText: redditText || null,
          pinTitle: pinTitle || null,
          pinDescription: pinDescription || null,
          redditUrl: redditUrl || null,
          redditFlairId: redditFlairId || null,
          redditFlairText: redditFlairText || null,
          redditSubreddit: redditSubreddit || null,
          // Spec 37: persist FALSE (organic) only; clear (null) when promo so absence
          // reads as promo. NOT `|| null` - that would drop the meaningful false.
          isPromo: isPromo === false ? false : null,
          pinBoardSection: pinBoardSection || null,
          gbp: gbpPayload,
          tgCta: tgCtaPayload,
          dcEmbed: dcEmbedPayload,
          dcThreadName: dcThreadName || null,
          dcThreadId: dcThreadId || null,
          dcEvent: dcEventPayload,
          ttInteraction: ttInteractionPayload,
          spoilerText: spoilerText || null,
          xReplySettings: xReplySettings || null,
          poll: pollPayload,
          mediaItems: mediaItemsPayload,
          interactiveStory: interactiveStoryPayload,
          hashtags: hashtagsPayload,
          altText: altText || null,
        });
      } else {
        saveRes = await createPost(campaign, {
          id,
          type,
          platforms,
          scheduledAt: scheduledIso,
          caption,
          firstComment: firstComment || undefined,
          title: title || undefined,
          link: link || undefined,
          image: image || undefined,
          imageUrl: imageUrl.trim() || undefined,
          path: mediaPath || undefined,
          description: description || undefined,
          liDescription: liDescription || undefined,
          xCaption: xCaption || undefined,
          xReplyTo: xReplyToClean || undefined,
          tags: tags || undefined,
          blogSlug: blogSlug || undefined,
          body: body || undefined,
          excerpt: excerpt || undefined,
          metaTitle: metaTitle || undefined,
          metaDescription: metaDescription || undefined,
          wpCategories: wpCategories || undefined,
          featureImageAlt: featureImageAlt || undefined,
          publishAsDraft: publishAsDraft === true ? true : undefined,
          canonicalUrl: canonicalUrl || undefined,
          ghostEmail: ghostEmail === true ? true : undefined,
          newsletter: newsletter || undefined,
          emailSegment: emailSegment || undefined,
          emailOnly: emailOnly === true ? true : undefined,
          mastodonCaption: mastodonCaption || undefined,
          nostrCaption: nostrCaption || undefined,
          tgCaption: tgCaption || undefined,
          dcCaption: dcCaption || undefined,
          ttCaption: ttCaption || undefined,
          redditText: redditText || undefined,
          pinTitle: pinTitle || undefined,
          pinDescription: pinDescription || undefined,
          redditUrl: redditUrl || undefined,
          redditFlairId: redditFlairId || undefined,
          redditFlairText: redditFlairText || undefined,
          redditSubreddit: redditSubreddit || undefined,
          // Spec 37: send FALSE (organic) only; omit when promo (absence = promo).
          isPromo: isPromo === false ? false : undefined,
          pinBoardSection: pinBoardSection || undefined,
          gbp: gbpPayload || undefined,
          tgCta: tgCtaPayload || undefined,
          dcEmbed: dcEmbedPayload || undefined,
          dcThreadName: dcThreadName || undefined,
          dcThreadId: dcThreadId || undefined,
          dcEvent: dcEventPayload || undefined,
          ttInteraction: ttInteractionPayload || undefined,
          spoilerText: spoilerText || undefined,
          xReplySettings: xReplySettings || undefined,
          poll: pollPayload || undefined,
          mediaItems: mediaItemsPayload && mediaItemsPayload.length ? mediaItemsPayload : undefined,
          interactiveStory: interactiveStoryPayload || undefined,
          hashtags: hashtagsPayload || undefined,
          altText: altText || undefined,
        });
      }
      // Materialize pending thread parts as sibling posts chained via xReplyTo.
      // Runs AFTER the main save so the chain's parent exists; each part is a
      // plain approvable draft (text, X-only, same slot) the owner reviews in
      // Freigaben - the split itself publishes nothing.
      if (threadParts.length) {
        const threadCampaign = isEdit ? post.campaign : campaign;
        let parentId = isEdit ? post.id : id;
        for (let i = 0; i < threadParts.length; i += 1) {
          const partId = `${isEdit ? post.id : id}-t${i + 2}`;
          await createPost(threadCampaign, {
            id: partId,
            type: 'text',
            platforms: ['x'],
            scheduledAt: scheduledIso,
            caption: threadParts[i],
            xReplyTo: parentId,
          });
          parentId = partId;
        }
        setThreadParts([]);
        threadOriginalRef.current = null;
      }
      queryClient.invalidateQueries({ queryKey: ['plans'] });
      onSaved?.(campaign, isEdit ? post.id : id, saveRes?.humanizer);
      onClose();
    } catch (err) {
      setError(
        err.code === 'stale_write'
          ? t('composer.error.staleWrite')
          : err.message,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-5xl">
      <header className="mb-4 flex items-center gap-3">
        <Tip label={t('composer.back')}>
          <button type="button" onClick={requestClose} aria-label={t('composer.back')} className="rounded-xl bg-zinc-200/60 p-2 transition hover:bg-zinc-300/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-zinc-800/60 dark:hover:bg-zinc-700/60">
            <ArrowLeft size={16} aria-hidden="true" />
          </button>
        </Tip>
        <div>
          <p className={EYEBROW}>{isEdit ? `${prettyCampaign(post.campaign)} · ${post.id}` : t('composer.newDraft')}</p>
          <h2 className="font-display text-lg font-bold">{isEdit ? t('composer.editPost') : t('composer.newPost')}</h2>
        </div>
        {/* Per-client signage (B4): the composer is an overlay that covers the
            sidebar switcher, so the band names the active client here too. */}
        <div className="ml-auto">
          <ClientBand client={activeClient} />
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_19rem]">
        <div className="space-y-4">
          {/* Platforms first: they gate every conditional field below. */}
          <fieldset ref={platformsFieldsetRef} className="space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <legend className={EYEBROW}>{t('composer.field.platforms')}</legend>
              {/* Multi-select is the whole point: one post, every ticked platform. A
                  select-all/clear control makes that obvious and fast. */}
              {pickerPlatforms.length > 1 ? (
                <button
                  type="button"
                  onClick={() => setPlatforms(allPlatformsSelected ? [] : [...pickerPlatforms])}
                  className="text-[11px] font-bold text-brand transition hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light"
                >
                  {allPlatformsSelected ? t('composer.platforms.clear') : t('composer.platforms.all')}
                </button>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {pickerPlatforms.map((p) => {
                const meta = PLATFORM_META[p];
                if (!meta) return null;
                const active = platforms.includes(p);
                const { Icon } = meta;
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => togglePlatform(p)}
                    aria-pressed={active}
                    className={`flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs font-bold ring-1 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
                      active
                        ? 'bg-brand text-white ring-brand dark:bg-brand-light dark:text-zinc-900 dark:ring-brand-light'
                        : 'text-zinc-500 ring-zinc-900/10 hover:bg-zinc-200/40 dark:text-zinc-400 dark:ring-white/10 dark:hover:bg-zinc-800/40'
                    }`}
                  >
                    {active
                      ? <Check size={13} aria-hidden="true" />
                      : <Icon size={13} className={meta.color} aria-hidden="true" />}
                    {meta.label}
                  </button>
                );
              })}
            </div>
            {/* One calm line so the shared-content model is legible: the same post,
                caption and media publish to every selected platform. */}
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
              {platforms.length > 1
                ? t('composer.platforms.hintMulti', { n: platforms.length })
                : t('composer.platforms.hint')}
            </p>
          </fieldset>

          {/* Discoverability: a single X post can grow into a real thread. This
              hands the current caption to the thread composer as its opener. */}
          {!isEdit && platforms.includes('x') && onStartThread ? (
            <button
              type="button"
              onClick={() => onStartThread(caption)}
              className="flex items-center gap-1.5 text-xs font-semibold text-brand transition hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light"
            >
              <CornerUpLeft size={13} aria-hidden="true" /> {t('composer.threadHint')}
            </button>
          ) : null}

          {!isEdit ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className={EYEBROW} htmlFor="composer-campaign">{t('composer.field.campaign')}</label>
                <select id="composer-campaign" ref={campaignSelectRef} value={campaign} onChange={(e) => setCampaign(e.target.value)} className={`${FIELD} w-full`}>
                  <option value="" disabled>{t('composer.campaignPlaceholder')}</option>
                  {campaigns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {prettyCampaign(c.id)}{c.active ? '' : t('composer.campaignArchivedSuffix')}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label className={`flex items-center gap-1 ${EYEBROW}`} htmlFor="composer-id">
                  {t('composer.field.postId')}
                  {!idEdited ? <Tip label={t('composer.postIdHint')}><span className="inline-flex"><Wand2 size={11} className="text-brand dark:text-brand-light" aria-hidden="true" /></span></Tip> : null}
                </label>
                <input id="composer-id" ref={idRef} value={id} onChange={(e) => { setIdEdited(true); setId(e.target.value); }} placeholder={t('composer.postIdPlaceholder')} className={`${FIELD} w-full`} />
              </div>
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-type">{t('composer.field.format')}</label>
              {/* Format + schedule share one explicit height and the same FIELD
                  surface so the adjacent select and picker trigger read as one row.
                  A12: offer only the formats the chosen lane(s) can publish (union
                  across platforms; full list when none), keeping the current value
                  listed even if now invalid so a platform change never silently
                  rewrites the format. */}
              <select id="composer-type" value={type} onChange={(e) => onTypeChange(e.target.value)} className={`${FIELD} w-full h-10`}>
                {TYPES.filter((ty) => ty === type || (platforms.length ? platforms.some((p) => formatsForPlatform(p).includes(ty)) : true)).map((ty) => (
                  <option key={ty} value={ty}>{typeOptionLabel(t, platforms, ty)}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5" ref={scheduleFieldRef}>
              <label className={EYEBROW}>{t('composer.field.schedule')}</label>
              <DateTimePicker value={scheduledIso} onChange={setScheduledIso} triggerClassName={`${FIELD} w-full h-10`} />
            </div>
          </div>

          {/* Spec 18: a one-line note that a Nostr article is a NIP-23 kind-30023 post
              and re-publishing edits it in place (the stable d identifier). */}
          {isNostrArticle ? (
            <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.nostr.longformHint')}</p>
          ) : null}

          {needsMedia ? (
            <div className="space-y-1.5">
              <label className={EYEBROW}>{t('composer.field.video')}</label>
              <VideoPicker assets={assets} assetsDir={assetsDir} value={mediaPath} onChange={setMediaPath} />
            </div>
          ) : null}

          {/* Caption gates on rel.caption: a YouTube-only or blog-only post posts
              title+description / title+body, never a feed caption - so the field
              disappears there instead of standing empty. */}
          {rel.caption ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-caption">{t('composer.field.caption')}</label>
              <textarea id="composer-caption" value={caption} onChange={(e) => setCaption(e.target.value)} rows={growRows(caption, 4, 14)} className={`${FIELD_MULTILINE} w-full resize-y leading-relaxed`} />
              <div aria-live="polite">
                <LintPanel lint={lint} />
              </div>
            </div>
          ) : null}

          {rel.xCaption && hiddenOverride !== 'xCaption' ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-x-caption">{t('composer.field.xCaption')}</label>
              <textarea
                id="composer-x-caption"
                value={xCaption}
                onChange={(e) => setXCaption(e.target.value)}
                rows={growRows(xCaption, 3, 12)}
                placeholder={t('composer.field.xCaptionPlaceholder')}
                aria-describedby="composer-x-counter"
                className={`${FIELD_MULTILINE} w-full resize-y leading-relaxed`}
              />
              <CharCounter id="composer-x-counter" len={xLen} max={CAPTION_CAPS.x} over={xOver} />
              {/* r2-3: announce ONLY the over/under transition, not every keystroke. */}
              <p role="status" aria-live="polite" className="sr-only">{xOverAnnounce}</p>
              {/* X hard cap: over 280 the post cannot publish (non-Premium API
                  refusal). Offer the one honest way to ship the WHOLE text: a
                  visible split into thread replies, each its own approvable post. */}
              {xOver && !threadParts.length ? (
                <div className={`space-y-2 rounded-xl p-3 ${INNER_SURFACE}`}>
                  <p className="text-xs text-zinc-600 dark:text-zinc-300">{t('composer.thread.hint')}</p>
                  <button
                    type="button"
                    onClick={() => {
                      const effective = xCaption || caption;
                      const parts = splitTweetThread(effective, CAPTION_CAPS.x);
                      if (parts.length < 2) return;
                      threadOriginalRef.current = { xCaption, hadOverride: Boolean(xCaption) };
                      setXCaption(parts[0]);
                      setThreadParts(parts.slice(1));
                    }}
                    className="rounded-xl bg-brand px-3 py-1.5 text-xs font-bold text-white transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                  >
                    {t('composer.thread.split')}
                  </button>
                </div>
              ) : null}
              {threadParts.length ? (
                <div className={`space-y-2 rounded-xl p-3 ${INNER_SURFACE}`}>
                  <p className="text-xs font-bold">{t('composer.thread.partsTitle', { count: threadParts.length + 1 })}</p>
                  <p className="text-xs text-zinc-600 dark:text-zinc-300">{t('composer.thread.partsHint')}</p>
                  <ol className="space-y-1.5">
                    {threadParts.map((part, i) => (
                      <li key={i} className={`rounded-lg p-2 text-xs leading-relaxed ${FIELD_SURFACE}`}>
                        <span className="mr-1 font-bold tabular-nums text-zinc-500 dark:text-zinc-400">{i + 2}.</span>
                        {part}
                        <span className="ml-1 whitespace-nowrap text-[10px] tabular-nums text-zinc-500 dark:text-zinc-400">({part.length}/{CAPTION_CAPS.x})</span>
                      </li>
                    ))}
                  </ol>
                  <button
                    type="button"
                    onClick={() => {
                      const orig = threadOriginalRef.current;
                      setXCaption(orig && orig.hadOverride ? orig.xCaption : '');
                      setThreadParts([]);
                      threadOriginalRef.current = null;
                    }}
                    className="text-xs font-bold text-zinc-600 underline-offset-2 hover:underline dark:text-zinc-300"
                  >
                    {t('composer.thread.remove')}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {/* X reply-chain (xReplyTo): thread this tweet under a same-campaign
              post. The X lane resolves the id to the parent's live tweet at
              publish time and fail-closes while the parent has not posted, so
              clearing the field (-> null) releases a post held by a dangling
              reference. The datalist offers sibling X posts; free text stays
              allowed for ids the campaign list does not carry yet. */}
          {rel.xReplyTo ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-x-reply-to">{t('composer.field.xReplyTo')}</label>
              <input
                id="composer-x-reply-to"
                ref={xReplyToRef}
                value={xReplyTo}
                onChange={(e) => setXReplyTo(e.target.value)}
                list="composer-x-reply-to-posts"
                placeholder={t('composer.field.xReplyToPlaceholder')}
                className={`${FIELD} w-full`}
              />
              <datalist id="composer-x-reply-to-posts">
                {campaignPosts
                  .filter((p) => p.id !== (isEdit ? post.id : id) && (p.platforms || []).includes('x'))
                  .map((p) => <option key={p.id} value={p.id} />)}
              </datalist>
            </div>
          ) : null}

          {/* Spec 25: who may reply to the tweet (reply_settings) - an
              interaction/comment control. X has no paid-partnership/branded-
              content create param (not API-exposed), so this is the one
              disclosure/interaction toggle X actually offers today. Unset (the
              default option) keeps X's own default (everyone). */}
          {rel.xReplySettings ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-x-reply-settings">{t('composer.field.xReplySettings')}</label>
              <select id="composer-x-reply-settings" value={xReplySettings} onChange={(e) => setXReplySettings(e.target.value)} className={`${FIELD} w-full`}>
                <option value="">{t('composer.field.xReplySettings.default')}</option>
                {X_REPLY_SETTINGS.map((v) => (
                  <option key={v} value={v}>{t(`composer.field.xReplySettings.${v}`)}</option>
                ))}
              </select>
            </div>
          ) : null}

          {rel.mastodonCaption && hiddenOverride !== 'mastodonCaption' ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-mastodon-caption">{t('composer.field.mastodonCaption')}</label>
              <textarea
                id="composer-mastodon-caption"
                value={mastodonCaption}
                onChange={(e) => setMastodonCaption(e.target.value)}
                rows={growRows(mastodonCaption, 3, 12)}
                placeholder={t('composer.field.mastodonCaptionPlaceholder')}
                aria-describedby="composer-mastodon-counter"
                className={`${FIELD_MULTILINE} w-full resize-y leading-relaxed`}
              />
              <CharCounter id="composer-mastodon-counter" len={mastodonLen} max={CAPTION_CAPS.mastodon} over={mastodonOver} />
              <p role="status" aria-live="polite" className="sr-only">{mastodonOverAnnounce}</p>
            </div>
          ) : null}

          {/* Spec 25: a Mastodon content warning - non-empty text also marks the
              status sensitive:true, so it renders behind the CW until expanded. */}
          {rel.spoilerText ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-spoiler-text">{t('composer.field.spoilerText')}</label>
              <input id="composer-spoiler-text" value={spoilerText} onChange={(e) => setSpoilerText(e.target.value)} placeholder={t('composer.field.spoilerTextPlaceholder')} className={`${FIELD} w-full`} />
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.field.spoilerTextHint')}</p>
            </div>
          ) : null}

          {rel.nostrCaption && hiddenOverride !== 'nostrCaption' ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-nostr-caption">{t('composer.field.nostrCaption')}</label>
              <textarea
                id="composer-nostr-caption"
                value={nostrCaption}
                onChange={(e) => setNostrCaption(e.target.value)}
                rows={growRows(nostrCaption, 3, 12)}
                placeholder={t('composer.field.nostrCaptionPlaceholder')}
                className={`${FIELD_MULTILINE} w-full resize-y leading-relaxed`}
              />
            </div>
          ) : null}

          {/* B1 (ux-audit dim-6 P1): the remaining per-lane prose overrides the
              engines publish (tgCaption/dcCaption/ttCaption/redditText/
              pinTitle/pinDescription) - MCP-writable, so they must be authorable
              and reviewable here too. Same additive nostrCaption pattern:
              rendered only when the lane is targeted, single-lane-collapsed
              while empty, empty falls back to the shared caption (pinTitle: to
              the title). */}
          {rel.tgCaption && hiddenOverride !== 'tgCaption' ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-tg-caption">{t('composer.field.tgCaption')}</label>
              <textarea
                id="composer-tg-caption"
                value={tgCaption}
                onChange={(e) => setTgCaption(e.target.value)}
                rows={growRows(tgCaption, 3, 12)}
                placeholder={t('composer.field.tgCaptionPlaceholder')}
                className={`${FIELD_MULTILINE} w-full resize-y leading-relaxed`}
              />
            </div>
          ) : null}

          {rel.dcCaption && hiddenOverride !== 'dcCaption' ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-dc-caption">{t('composer.field.dcCaption')}</label>
              <textarea
                id="composer-dc-caption"
                value={dcCaption}
                onChange={(e) => setDcCaption(e.target.value)}
                rows={growRows(dcCaption, 3, 12)}
                placeholder={t('composer.field.dcCaptionPlaceholder')}
                className={`${FIELD_MULTILINE} w-full resize-y leading-relaxed`}
              />
            </div>
          ) : null}

          {rel.ttCaption && hiddenOverride !== 'ttCaption' ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-tt-caption">{t('composer.field.ttCaption')}</label>
              <textarea
                id="composer-tt-caption"
                value={ttCaption}
                onChange={(e) => setTtCaption(e.target.value)}
                rows={growRows(ttCaption, 3, 12)}
                placeholder={t('composer.field.ttCaptionPlaceholder')}
                className={`${FIELD_MULTILINE} w-full resize-y leading-relaxed`}
              />
            </div>
          ) : null}

          {rel.redditText && hiddenOverride !== 'redditText' ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-reddit-text">{t('composer.field.redditText')}</label>
              <textarea
                id="composer-reddit-text"
                value={redditText}
                onChange={(e) => setRedditText(e.target.value)}
                rows={growRows(redditText, 3, 12)}
                placeholder={t('composer.field.redditTextPlaceholder')}
                className={`${FIELD_MULTILINE} w-full resize-y leading-relaxed`}
              />
            </div>
          ) : null}

          {/* pinTitle is never collapse-hidden: it shadows the TITLE (the
              engine's pinTitle || title), and a pinterest post has no title
              field of its own to fall back to visibly. */}
          {rel.pinTitle ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-pin-title">{t('composer.field.pinTitle')}</label>
              <input
                id="composer-pin-title"
                value={pinTitle}
                onChange={(e) => setPinTitle(e.target.value)}
                placeholder={t('composer.field.pinTitlePlaceholder')}
                className={`${FIELD} w-full`}
              />
            </div>
          ) : null}

          {rel.pinDescription && hiddenOverride !== 'pinDescription' ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-pin-description">{t('composer.field.pinDescription')}</label>
              <textarea
                id="composer-pin-description"
                value={pinDescription}
                onChange={(e) => setPinDescription(e.target.value)}
                rows={growRows(pinDescription, 3, 12)}
                placeholder={t('composer.field.pinDescriptionPlaceholder')}
                className={`${FIELD_MULTILINE} w-full resize-y leading-relaxed`}
              />
            </div>
          ) : null}

          {showFirstComment ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-comment">{t('composer.field.firstComment')}</label>
              <textarea id="composer-comment" value={firstComment} onChange={(e) => setFirstComment(e.target.value)} rows={2} className={`${FIELD_MULTILINE} w-full resize-y`} />
              <LintPanel lint={commentLint} />
            </div>
          ) : null}

          {/* Spec 21: cross-lane image alt-text (X media metadata, WordPress
              attachment alt_text/caption, Pinterest pin alt_text). Meaningful only
              with an image; each engine no-ops when the post carries none. */}
          {rel.altText ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-alt-text">{t('composer.field.altText')}</label>
              <textarea id="composer-alt-text" value={altText} onChange={(e) => setAltText(e.target.value)} rows={2} className={`${FIELD_MULTILINE} w-full resize-y`} />
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.field.altTextHint')}</p>
            </div>
          ) : null}

          {showInteractive ? (
            <InteractiveFields
              stickers={stickers}
              onStickersChange={setStickers}
              hashtagsMode={hashtagsMode}
              onHashtagsModeChange={setHashtagsMode}
              hashtags={hashtags}
              onHashtagsChange={setHashtags}
              globalHashtags={globalHashtags}
            />
          ) : null}

          {rel.title ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-title">{t('composer.field.title')}</label>
              <input id="composer-title" value={title} onChange={(e) => setTitle(e.target.value)} className={`${FIELD} w-full`} />
              {isArticle ? <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.field.titleArticleHint')}</p> : null}
            </div>
          ) : null}

          {/* Wave-2 article fields (wordpress/ghost): markdown body + excerpt;
              the shared image field below doubles as the article hero. */}
          {rel.body ? (
            <>
              <div className="space-y-1.5">
                <label className={EYEBROW} htmlFor="composer-body">{t('composer.field.body')}</label>
                <textarea id="composer-body" value={body} onChange={(e) => setBody(e.target.value)} rows={10} className={`${FIELD_MULTILINE} w-full resize-y font-mono leading-relaxed`} />
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.field.bodyHint')}</p>
                {/* Spec 18: an article's content IS the body (no caption fallback on the
                    nostr lane), so an empty body is a publish blocker - surface it early. */}
                {isNostrArticle && !body.trim() ? (
                  <p role="status" className="text-[11px] text-amber-700 dark:text-amber-300">{t('composer.nostr.bodyRequired')}</p>
                ) : null}
              </div>
              <div className="space-y-1.5">
                <label className={EYEBROW} htmlFor="composer-excerpt">{t('composer.field.excerpt')}</label>
                <textarea id="composer-excerpt" value={excerpt} onChange={(e) => setExcerpt(e.target.value)} rows={2} className={`${FIELD_MULTILINE} w-full resize-y`} />
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.field.excerptHint')}</p>
              </div>
            </>
          ) : null}

          {/* Spec 13: rich long-form metadata - SEO meta title/description +
              feature-image alt (wordpress/ghost), WordPress-only category
              taxonomy (distinct from tags, resolved/auto-created on publish). */}
          {rel.metaTitle ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-meta-title">{t('composer.field.metaTitle')}</label>
              <input id="composer-meta-title" value={metaTitle} onChange={(e) => setMetaTitle(e.target.value)} className={`${FIELD} w-full`} />
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.field.metaTitleHint')}</p>
            </div>
          ) : null}

          {rel.metaDescription ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-meta-description">{t('composer.field.metaDescription')}</label>
              <textarea id="composer-meta-description" value={metaDescription} onChange={(e) => setMetaDescription(e.target.value)} rows={2} className={`${FIELD_MULTILINE} w-full resize-y`} />
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.field.metaDescriptionHint')}</p>
            </div>
          ) : null}

          {rel.wpCategories ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-wp-categories">{t('composer.field.wpCategories')}</label>
              <input id="composer-wp-categories" value={wpCategories} onChange={(e) => setWpCategories(e.target.value)} placeholder={t('composer.field.wpCategoriesPlaceholder')} className={`${FIELD} w-full`} />
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.field.wpCategoriesHint')}</p>
            </div>
          ) : null}

          {rel.featureImageAlt ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-feature-image-alt">{t('composer.field.featureImageAlt')}</label>
              <input id="composer-feature-image-alt" value={featureImageAlt} onChange={(e) => setFeatureImageAlt(e.target.value)} className={`${FIELD} w-full`} />
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.field.featureImageAltHint')}</p>
            </div>
          ) : null}

          {/* Spec 27: draft/pending-review publish status - a native WordPress
              draft or the TikTok inbox, for a human to finish + publish. Approval
              (§H.2) still gates whether the engine may act; this never bypasses it. */}
          {rel.publishAsDraft ? (
            <div className="space-y-1.5">
              <label className="flex items-center gap-2 text-xs font-bold">
                <input
                  type="checkbox"
                  checked={publishAsDraft}
                  onChange={(e) => setPublishAsDraft(e.target.checked)}
                  className="h-4 w-4 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                />
                {t('composer.field.publishAsDraft')}
              </label>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.field.publishAsDraftHint')}</p>
            </div>
          ) : null}

          {rel.link ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-link">{t('composer.field.link')}</label>
              <input id="composer-link" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://example.com/blog/..." className={`${FIELD} w-full`} />
            </div>
          ) : null}

          {/* ONE image field serves both cards: the LinkedIn link-preview
              thumbnail and the wordpress/ghost article hero (same post.image). */}
          {rel.image ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-image">{isArticle ? t('composer.field.imageArticle') : t('composer.field.image')}</label>
              <input id="composer-image" value={image} onChange={(e) => setImage(e.target.value)} placeholder="https://res.cloudinary.com/<your-cloud>/..." className={`${FIELD} w-full`} />
            </div>
          ) : null}

          {/* Specs 17+39: the public media URL the URL-only lanes fetch (pinterest
              pin image / video-pin cover, instagram feed IMAGE container). The
              operator vouches it serves the same image as the local render - the
              engine cannot fetch it to compare (local-first, no network client). */}
          {rel.imageUrl ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-image-url">{t('composer.field.imageUrl')}</label>
              <input id="composer-image-url" value={imageUrl} onChange={(e) => setImageUrl(e.target.value)} placeholder="https://res.cloudinary.com/<your-cloud>/..." className={`${FIELD} w-full`} />
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.field.imageUrlHint')}</p>
            </div>
          ) : null}

          {/* Spec 37: organic-vs-promotional. Reddit gates self-promotion (~9:1 norm); a
              promo post always stays MANUAL (Offene Aktionen). Marking a post organic lets a
              WARM account auto-post it after approval - so it defaults PROMO (checked) and the
              operator opts into organic by unchecking. Every reddit post still needs a distinct
              human approval; this only changes the post-approval tier. */}
          {rel.isPromo ? (
            <div className="space-y-1.5">
              <label className="flex items-center gap-2 text-xs font-bold">
                <input
                  type="checkbox"
                  checked={isPromo}
                  onChange={(e) => setIsPromo(e.target.checked)}
                  className="h-4 w-4 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                />
                {t('composer.field.isPromo')}
              </label>
              <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.field.isPromoHint')}</p>
            </div>
          ) : null}

          {/* Spec 36: the per-post destination subreddit (falls back to the connection
              default REDDIT_SUBREDDIT when blank). Drives the flair picker's read. */}
          {rel.redditSubreddit ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-reddit-subreddit">{t('composer.field.redditSubreddit')}</label>
              <input id="composer-reddit-subreddit" value={redditSubreddit} onChange={(e) => setRedditSubreddit(e.target.value)} placeholder={connectedSubreddit} className={`${FIELD} w-full`} />
            </div>
          ) : null}

          {/* Spec 16: the Reddit link submission URL (a type=text reddit post with a URL
              publishes as a `link`; without one it is a self/text post). */}
          {rel.redditUrl ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-reddit-url">{t('composer.field.redditUrl')}</label>
              <input id="composer-reddit-url" value={redditUrl} onChange={(e) => setRedditUrl(e.target.value)} placeholder="https://example.com/article" className={`${FIELD} w-full`} />
            </div>
          ) : null}

          {/* Spec 16: the link-flair picker (reddit_list_flairs). States: loading (a
              disabled spinner option), unavailable (scope/config - an honest hint,
              publishing still works flair-less), empty (no templates on the sub), and
              the populated select. Picking an editable template carries its flair_text. */}
          {rel.redditFlairId ? (
            <div className="space-y-1.5">
              {/* The visible header is a span (not a <label htmlFor>) because the control
                  below is conditional - the loading/populated states render a select
                  (named via aria-label), the empty/unavailable states render a hint. */}
              <span className={EYEBROW}>{t('composer.field.redditFlair')}</span>
              {!effectiveSubreddit ? (
                // No connected subreddit yet - a neutral nudge, never a fake "r/reddit".
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.reddit.flairNoSub')}</p>
              ) : redditFlairsLoading ? (
                <select aria-label={t('composer.field.redditFlair')} disabled className={`${FIELD} w-full`}>
                  <option>{t('composer.reddit.flairLoading')}</option>
                </select>
              ) : redditFlairsUnavailable ? (
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.reddit.flairUnavailable', { sub: effectiveSubreddit })}</p>
              ) : redditFlairs.length ? (
                <select
                  aria-label={t('composer.field.redditFlair')}
                  value={redditFlairId}
                  onChange={(e) => {
                    const picked = redditFlairs.find((f) => f.id === e.target.value);
                    setRedditFlairId(e.target.value);
                    // flair_text only rides an EDITABLE template (Reddit ignores it otherwise).
                    setRedditFlairText(picked && picked.editable ? (picked.text || '') : '');
                  }}
                  className={`${FIELD} w-full`}
                >
                  <option value="">{t('composer.reddit.flairNone')}</option>
                  {redditFlairs.map((f) => (
                    <option key={f.id} value={f.id}>{f.text || f.id}</option>
                  ))}
                </select>
              ) : (
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.reddit.flairEmpty', { sub: effectiveSubreddit })}</p>
              )}
            </div>
          ) : null}

          {/* Spec 17: the Pinterest board-section picker (pinterest_list_board_sections).
              States: loading (a disabled spinner option), unavailable (scope/config - an
              honest hint, publishing still works section-less), empty (board has no
              sections), and the populated select. A video pin also needs a public cover
              (imageUrl) - the hint always shows for a video-typed post. */}
          {rel.pinBoardSection ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-pin-board-section">{t('composer.field.pinBoardSection')}</label>
              {pinterestSectionsLoading ? (
                <select id="composer-pin-board-section" disabled className={`${FIELD} w-full`}>
                  <option>{t('composer.pinterest.sectionsLoading')}</option>
                </select>
              ) : pinterestSectionsUnavailable ? (
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.pinterest.sectionsUnavailable')}</p>
              ) : (
                <select
                  id="composer-pin-board-section"
                  value={pinBoardSection}
                  onChange={(e) => setPinBoardSection(e.target.value)}
                  className={`${FIELD} w-full`}
                >
                  <option value="">{t('composer.pinterest.sectionRoot')}</option>
                  {pinterestSections.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              )}
              {!pinterestSectionsLoading && !pinterestSectionsUnavailable && !pinterestSections.length ? (
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.pinterest.sectionEmpty')}</p>
              ) : null}
              {type === 'video' ? <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.pinterest.coverHint')}</p> : null}
            </div>
          ) : null}

          {rel.canonicalUrl ? (
            <>
              <div className="space-y-1.5">
                <label className={EYEBROW} htmlFor="composer-canonical-url">{t('composer.field.canonicalUrl')}</label>
                <input id="composer-canonical-url" value={canonicalUrl} onChange={(e) => setCanonicalUrl(e.target.value)} placeholder="https://example.com/original-post" className={`${FIELD} w-full`} />
              </div>
              <label className="flex items-center gap-2 text-xs font-bold">
                <input
                  type="checkbox"
                  checked={ghostEmail}
                  onChange={(e) => setGhostEmail(e.target.checked)}
                  className="h-4 w-4 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                />
                {t('composer.field.ghostEmail')}
              </label>
              {/* Spec 01: newsletter/segment/email-only refine the ghostEmail
                  opt-in above - hidden until it is checked. */}
              {ghostEmail ? (
                <div className="space-y-3 pl-1">
                  <div className="space-y-1.5">
                    <label className={EYEBROW} htmlFor="composer-newsletter">{t('composer.field.newsletter')}</label>
                    <input id="composer-newsletter" value={newsletter} onChange={(e) => setNewsletter(e.target.value)} placeholder={t('composer.field.newsletterPlaceholder')} className={`${FIELD} w-full`} />
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.field.newsletterHint')}</p>
                  </div>
                  <div className="space-y-1.5">
                    <label className={EYEBROW} htmlFor="composer-email-segment">{t('composer.field.emailSegment')}</label>
                    <select id="composer-email-segment" value={emailSegment} onChange={(e) => setEmailSegment(e.target.value)} className={`${FIELD} w-full`}>
                      <option value="">{t('composer.field.emailSegment.all')}</option>
                      <option value="free">{t('composer.field.emailSegment.free')}</option>
                      <option value="paid">{t('composer.field.emailSegment.paid')}</option>
                    </select>
                    <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.field.emailSegmentHint')}</p>
                  </div>
                  <label className="flex items-center gap-2 text-xs font-bold">
                    <input
                      id="composer-email-only"
                      type="checkbox"
                      checked={emailOnly}
                      onChange={(e) => setEmailOnly(e.target.checked)}
                      className="h-4 w-4 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                    />
                    {t('composer.field.emailOnly')}
                  </label>
                  <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.field.emailOnlyHint')}</p>
                </div>
              ) : null}
            </>
          ) : null}

          {rel.liDescription ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-li-description">{t('composer.field.liDescription')}</label>
              <textarea id="composer-li-description" value={liDescription} onChange={(e) => setLiDescription(e.target.value)} rows={3} className={`${FIELD_MULTILINE} w-full resize-y leading-relaxed`} />
            </div>
          ) : null}

          {rel.description ? (
            <>
              <div className="space-y-1.5">
                <label className={EYEBROW} htmlFor="composer-description">{t('composer.field.description')}</label>
                <textarea id="composer-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={6} className={`${FIELD_MULTILINE} w-full resize-y leading-relaxed`} />
                <div aria-live="polite">
                  <LintPanel lint={descLint} />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className={EYEBROW} htmlFor="composer-blogslug">{t('composer.field.blogSlug')}</label>
                <input id="composer-blogslug" value={blogSlug} onChange={(e) => setBlogSlug(e.target.value)} placeholder={t('composer.field.blogSlugPlaceholder')} className={`${FIELD} w-full`} />
              </div>
            </>
          ) : null}

          {/* Tags serve YouTube (video tags) and the article lanes (post tags). */}
          {rel.tags ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-tags">{t('composer.field.tags')}</label>
              <input id="composer-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder={t('composer.field.tagsPlaceholder')} className={`${FIELD} w-full`} />
            </div>
          ) : null}

          {showGbp ? <GbpFields gbp={gbp} onChange={setGbp} /> : null}

          {/* Spec 14: rich link/CTA - Telegram inline buttons + link-preview/
              format control, and a Discord rich embed card. */}
          {rel.tgCta ? <TelegramCtaFields cta={tgCta} onChange={setTgCta} /> : null}
          {rel.dcEmbed ? (
            <DiscordEmbedFields
              embed={dcEmbed}
              onChange={setDcEmbed}
              threadName={dcThreadName}
              threadId={dcThreadId}
              onThreadNameChange={setDcThreadName}
              onThreadIdChange={setDcThreadId}
              dcEvent={dcEvent}
              onDcEventChange={setDcEvent}
            />
          ) : null}

          {/* Spec 25: TikTok interaction/disclosure toggles. */}
          {rel.ttInteraction ? <TiktokFields interaction={ttInteraction} onChange={setTtInteraction} /> : null}

          {/* Spec 10: native poll options + duration (type=poll only; the question is
              the caption above). Media-less, so the VideoPicker is hidden. */}
          {rel.poll ? <PollFields poll={poll} onChange={setPoll} max={pollMax} /> : null}

          {/* Spec 05: native carousel ordered slides (type=carousel only). Media-BACKED,
              so it replaces the single VideoPicker (needsMedia is false for a carousel). */}
          {rel.mediaItems ? (
            <CarouselPicker
              assets={assets}
              assetsDir={assetsDir}
              items={mediaItems}
              onChange={setMediaItems}
              max={carouselMax}
              slideUrls={slideUrls}
              onSlideUrlChange={(ref, url) => setSlideUrls((prev) => ({ ...prev, [ref]: url }))}
              showSlideUrl={platforms.includes('instagram')}
              platforms={platforms}
            />
          ) : null}

          {/* Small-viewport preview (finding #56): the sticky <aside> is hidden
              below lg, so surface the same preview behind a toggle here. Hidden
              entirely when there is nothing to preview - no toggle over nothing. */}
          {nothingToPreview ? null : (
            <div className="lg:hidden">
              <button
                type="button"
                onClick={() => setShowPreview((v) => !v)}
                aria-expanded={showPreview}
                aria-controls="composer-preview-mobile"
                className="flex items-center gap-1.5 rounded-xl bg-zinc-200/60 px-3 py-2 text-xs font-bold text-zinc-600 transition hover:bg-zinc-300/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-zinc-800/60 dark:text-zinc-300 dark:hover:bg-zinc-700/60"
              >
                <Eye size={14} aria-hidden="true" />
                {showPreview ? t('composer.hidePreview') : t('composer.showPreview')}
              </button>
              {showPreview ? (
                <div id="composer-preview-mobile" className="mt-2 space-y-2">
                  {isLinkedinArticle ? (
                    <LinkCardPreview image={image} title={title} link={link} />
                  ) : (
                    <PostPreview post={previewPost} />
                  )}
                </div>
              ) : null}
            </div>
          )}

          {/* B2: read-only publish-readiness blockers for the saved post, surfaced
              near the save action so the owner sees a bad post before publish.
              Edit-mode only; clean post => nothing renders. */}
          {isEdit ? (
            <PlatformBlockers platformValidate={platformValidate} validateMedia={validateMedia} approval={post?.approval} onNavigate={onNavigate} />
          ) : null}

          {error ? (
            <p role="alert" className="rounded-xl bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-300">{error}</p>
          ) : null}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={requestClose} className="rounded-xl px-3.5 py-2 text-sm font-bold text-zinc-500 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:bg-zinc-700/60">
              {t('composer.cancel')}
            </button>
            <button type="button" onClick={save} disabled={busy} className={`flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-bold text-white shadow-lg shadow-brand/20 transition hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-brand-light dark:text-zinc-900 ${DISABLED_PRIMARY}`}>
              {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
              {isEdit ? t('composer.save') : t('composer.createDraft')}
            </button>
          </div>
        </div>

        {/* Live preview - the post's real shape as the owner edits. */}
        <aside className="hidden lg:block">
          <div className="sticky top-0 space-y-2">
            {nothingToPreview ? null : <p className={EYEBROW}>{t('composer.preview')}</p>}
            {isLinkedinArticle ? (
              <LinkCardPreview image={image} title={title} link={link} />
            ) : (
              <PostPreview post={previewPost} />
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
