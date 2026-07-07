import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Loader2, ArrowLeft, Clapperboard, ChevronDown, X, Search, Wand2, Eye, Plus, Trash2, BarChart3, HelpCircle, Link2, AtSign, MapPin, Hash, Music, CornerUpLeft } from 'lucide-react';
import { useAssets, useConfig, usePlatformValidate, useValidateMedia, useActiveClient, createPost, updatePost, lintText } from '../lib/api.js';
import { useT, useLocale } from '../lib/i18n.js';
import { PLATFORMS, prettyCampaign, suggestPostId, visiblePlatforms, fieldRelevance } from '../lib/format.js';
import { PLATFORM_META, INNER_SURFACE, LinkCardPreview, PostPreview, PlatformBlockers, CoverThumb, EYEBROW } from './ui.jsx';
import ClientBand from './ClientBand.jsx';
import { DateTimePicker } from './ui/DateTimePicker.jsx';
import { Popover, PopoverTrigger, PopoverContent } from './ui/Popover.jsx';
import { Tip } from './ui/Tooltip.jsx';
import { IconBadge } from './ui/IconBadge.jsx';
import { useConfirm } from './ui/confirm.jsx';

const FIELD_CLS = `w-full rounded-xl border-0 px-3 py-2 text-sm ${INNER_SURFACE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`;
const TYPES = ['reel', 'story', 'video', 'text', 'youtube-short', 'youtube-longform'];

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
  if (lint.clean && !lint.warnings) {
    return (
      <p className="flex items-center gap-1.5 text-[11px] text-emerald-600 dark:text-emerald-300">
        <CheckCircle2 size={12} aria-hidden="true" /> {t('composer.lint.clean')}
      </p>
    );
  }
  return (
    <ul className="space-y-1">
      {lint.findings.slice(0, 8).map((f, i) => (
        <li
          key={`${f.rule}-${f.index}-${i}`}
          className={`flex items-start gap-1.5 text-[11px] ${
            f.severity === 'error' ? 'text-red-600 dark:text-red-300' : 'text-amber-600 dark:text-amber-300'
          }`}
        >
          <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            <span className="font-bold">&quot;{f.match}&quot;</span> - {f.hint}
          </span>
        </li>
      ))}
      {lint.findings.length > 8 ? (
        <li className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.lint.more', { count: lint.findings.length - 8 })}</li>
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
export function VideoPicker({ assets, assetsDir, value, onChange }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [folder, setFolder] = useState('all');
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
      <div className="relative">
        <PopoverTrigger asChild>
          <button type="button" className={`flex w-full items-center gap-2.5 ${FIELD_CLS} ${value ? 'pr-9' : ''}`}>
            {selected ? (
              // US-ASSET-13: a chosen video shows its cover, or its own first
              // frame when cover-less - never a bare icon. The clapperboard stays
              // only as the empty-state "pick a video" affordance below.
              <CoverThumb media={selected} className="h-9 w-6 shrink-0 rounded" />
            ) : (
              <Clapperboard size={16} className="shrink-0 text-zinc-400" aria-hidden="true" />
            )}
            <span className="flex-1 truncate text-left">{selected ? selected.file : t('composer.video.choose')}</span>
            {value ? null : <ChevronDown size={14} className="shrink-0 text-zinc-400" aria-hidden="true" />}
          </button>
        </PopoverTrigger>
        {value ? (
          <Tip label={t('composer.video.removeSelected')}>
            <button type="button" aria-label={t('composer.video.removeSelected')} onClick={() => onChange('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-zinc-400 transition hover:bg-zinc-300/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-600/50">
              <X size={14} aria-hidden="true" />
            </button>
          </Tip>
        ) : null}
      </div>
      <PopoverContent className="w-[420px] max-w-[90vw] space-y-2 p-3" align="start">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" aria-hidden="true" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('composer.video.searchPlaceholder')} className={`${FIELD_CLS} pl-8`} />
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
            return (
              <Tip key={a.file} label={a.file}>
                <button
                  type="button"
                  onClick={() => { onChange(`${assetsDir}/${a.file}`); setOpen(false); }}
                  className={`overflow-hidden rounded-lg text-left ring-1 transition ${isSel ? 'ring-2 ring-brand' : 'ring-zinc-900/10 hover:ring-brand/40 dark:ring-white/10'}`}
                >
                  {/* US-ASSET-13: cover JPEG, else the video's own first frame -
                      never a bare icon (CoverThumb owns that fallback). */}
                  <CoverThumb media={a} className="aspect-[9/16] w-full" />
                  <div className="space-y-0.5 p-1">
                    <p className="truncate text-[10px] font-bold">{a.file}</p>
                    <div className="flex items-center gap-1">
                      {specBadges(a, t)}
                      {a.probe?.durationSec ? <span className="text-[9px] text-zinc-400">{a.probe.durationSec}s</span> : null}
                    </div>
                  </div>
                </button>
              </Tip>
            );
          }) : <p className="col-span-3 py-6 text-center text-[11px] text-zinc-400">{t('composer.video.noMatches')}</p>}
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

const STICKER_FIELD_CLS = `w-full rounded-lg border-0 px-2.5 py-1.5 text-xs ${INNER_SURFACE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`;

// The labeled, keyboard-operable fields for one sticker (the authoritative
// content; the preview overlay is decoration). Each kind exposes its own inputs.
function StickerFields({ sticker, onPatch }) {
  const t = useT();
  const set = (patch) => onPatch({ ...sticker, ...patch });
  if (sticker.kind === 'poll') {
    return (
      <div role="group" aria-label={t('composer.sticker.poll.group')} className="space-y-1.5">
        <input aria-label={t('composer.sticker.poll.question')} placeholder={t('composer.sticker.poll.questionPlaceholder')} value={sticker.question || ''} onChange={(e) => set({ question: e.target.value })} className={STICKER_FIELD_CLS} />
        <div className="grid grid-cols-2 gap-1.5">
          <input aria-label={t('composer.sticker.poll.option1')} placeholder={t('composer.sticker.poll.option1Placeholder')} value={sticker.options?.[0] || ''} onChange={(e) => set({ options: [e.target.value, sticker.options?.[1] || ''] })} className={STICKER_FIELD_CLS} />
          <input aria-label={t('composer.sticker.poll.option2')} placeholder={t('composer.sticker.poll.option2Placeholder')} value={sticker.options?.[1] || ''} onChange={(e) => set({ options: [sticker.options?.[0] || '', e.target.value] })} className={STICKER_FIELD_CLS} />
        </div>
      </div>
    );
  }
  if (sticker.kind === 'question') {
    return <input aria-label={t('composer.sticker.question.prompt')} placeholder={t('composer.sticker.question.promptPlaceholder')} value={sticker.prompt || ''} onChange={(e) => set({ prompt: e.target.value })} className={STICKER_FIELD_CLS} />;
  }
  if (sticker.kind === 'link') {
    return (
      <div className="space-y-1.5">
        <input aria-label={t('composer.sticker.link.url')} placeholder="https://example.com" value={sticker.url || ''} onChange={(e) => set({ url: e.target.value })} className={STICKER_FIELD_CLS} />
        <input aria-label={t('composer.sticker.link.labelField')} placeholder={t('composer.sticker.link.labelPlaceholder')} value={sticker.label || ''} onChange={(e) => set({ label: e.target.value })} className={STICKER_FIELD_CLS} />
      </div>
    );
  }
  if (sticker.kind === 'mention') {
    return <input aria-label={t('composer.sticker.mention.handle')} placeholder={t('composer.sticker.mention.handlePlaceholder')} value={sticker.handle || ''} onChange={(e) => set({ handle: e.target.value })} className={STICKER_FIELD_CLS} />;
  }
  if (sticker.kind === 'location') {
    return <input aria-label={t('composer.sticker.location.name')} placeholder={t('composer.sticker.location.namePlaceholder')} value={sticker.name || ''} onChange={(e) => set({ name: e.target.value })} className={STICKER_FIELD_CLS} />;
  }
  if (sticker.kind === 'hashtag') {
    return <input aria-label={t('composer.sticker.hashtag.tag')} placeholder={t('composer.sticker.hashtag.tagPlaceholder')} value={sticker.tag || ''} onChange={(e) => set({ tag: e.target.value })} className={STICKER_FIELD_CLS} />;
  }
  if (sticker.kind === 'music') {
    return (
      <div className="grid grid-cols-2 gap-1.5">
        <input aria-label={t('composer.sticker.music.title')} placeholder={t('composer.sticker.music.titlePlaceholder')} value={sticker.title || ''} onChange={(e) => set({ title: e.target.value })} className={STICKER_FIELD_CLS} />
        <input aria-label={t('composer.sticker.music.artist')} placeholder={t('composer.sticker.music.artistPlaceholder')} value={sticker.artist || ''} onChange={(e) => set({ artist: e.target.value })} className={STICKER_FIELD_CLS} />
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
                    <button type="button" onClick={() => removeSticker(i)} aria-label={t('composer.interactive.removeStickerKind', { kind: t(`composer.sticker.${sticker.kind}.label`) })} className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-zinc-400 transition hover:bg-zinc-300/60 hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-700/60 dark:hover:text-zinc-200">
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
            className={STICKER_FIELD_CLS}
          />
        )}
      </div>
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
      className={`flex items-center gap-1 text-[11px] font-bold tabular-nums ${over ? 'text-red-600 dark:text-red-400' : 'text-zinc-400 dark:text-zinc-500'}`}
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
          <select id="composer-gbp-topic" value={gbp.topic} onChange={(e) => set({ topic: e.target.value })} className={FIELD_CLS}>
            {GBP_TOPICS.map((k) => (
              <option key={k} value={k}>{t(`composer.gbp.topic.${k}`)}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <label className={EYEBROW} htmlFor="composer-gbp-cta">{t('composer.gbp.ctaType')}</label>
          <select id="composer-gbp-cta" value={gbp.ctaType} onChange={(e) => set({ ctaType: e.target.value })} className={FIELD_CLS}>
            {Object.entries(GBP_CTA_KEYS).map(([value, key]) => (
              <option key={key} value={value}>{t(`composer.gbp.cta.${key}`)}</option>
            ))}
          </select>
        </div>
      </div>
      {showCtaUrl ? (
        <div className="space-y-1.5">
          <label className={EYEBROW} htmlFor="composer-gbp-cta-url">{t('composer.gbp.ctaUrl')}</label>
          <input id="composer-gbp-cta-url" value={gbp.ctaUrl} onChange={(e) => set({ ctaUrl: e.target.value })} placeholder="https://example.com/book" className={FIELD_CLS} />
        </div>
      ) : null}
      {gbp.topic === 'event' ? (
        <>
          <div className="space-y-1.5">
            <label className={EYEBROW} htmlFor="composer-gbp-event-title">{t('composer.gbp.eventTitle')}</label>
            <input id="composer-gbp-event-title" value={gbp.eventTitle} onChange={(e) => set({ eventTitle: e.target.value })} className={FIELD_CLS} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-gbp-event-start">{t('composer.gbp.eventStart')}</label>
              <input id="composer-gbp-event-start" type="date" value={gbp.eventStart} onChange={(e) => set({ eventStart: e.target.value })} className={FIELD_CLS} />
            </div>
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-gbp-event-end">{t('composer.gbp.eventEnd')}</label>
              <input id="composer-gbp-event-end" type="date" value={gbp.eventEnd} onChange={(e) => set({ eventEnd: e.target.value })} className={FIELD_CLS} />
            </div>
          </div>
        </>
      ) : null}
      {gbp.topic === 'offer' ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-gbp-coupon">{t('composer.gbp.couponCode')}</label>
              <input id="composer-gbp-coupon" value={gbp.couponCode} onChange={(e) => set({ couponCode: e.target.value })} className={FIELD_CLS} />
            </div>
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-gbp-redeem">{t('composer.gbp.redeemUrl')}</label>
              <input id="composer-gbp-redeem" value={gbp.redeemUrl} onChange={(e) => set({ redeemUrl: e.target.value })} placeholder="https://example.com/offer" className={FIELD_CLS} />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className={EYEBROW} htmlFor="composer-gbp-terms">{t('composer.gbp.terms')}</label>
            <textarea id="composer-gbp-terms" value={gbp.terms} onChange={(e) => set({ terms: e.target.value })} rows={2} className={`${FIELD_CLS} resize-y`} />
          </div>
        </>
      ) : null}
    </section>
  );
}

// Create + edit composer as a full page. Edit mode never touches approval/cover/
// publish fields - those have their own controls in PostDetail.
export default function Composer({ mode, post, campaigns, onClose, onSaved, seed, onNavigate, accounts, posting, onStartThread }) {
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
  const { data: platformValidate } = usePlatformValidate(post?.campaign, post?.id, isEdit);
  const { data: validateMedia } = useValidateMedia(post?.campaign, post?.id, isEdit);
  // B9: in create mode an "Attach to a post" CTA may pass a seed { mediaPath, type }
  // built from the same data.dir VideoPicker reads, so the media path matches the
  // canonical `${assetsDir}/${file}` shape and the picker shows it as selected. The
  // seed is ignored in edit mode (the post's own fields win).
  const seedMediaPath = !isEdit ? seed?.mediaPath || '' : '';
  const seedType = !isEdit && TYPES.includes(seed?.type) ? seed.type : null;

  const [campaign, setCampaign] = useState(isEdit ? post.campaign : campaigns.find((c) => c.active)?.id || campaigns[0]?.id || '');
  const [id, setId] = useState(isEdit ? post.id : '');
  const [idEdited, setIdEdited] = useState(isEdit);
  const [type, setType] = useState(isEdit ? post.type : seedType || 'reel');
  const [platforms, setPlatforms] = useState(isEdit ? post.platforms : ['instagram']);
  const [scheduledIso, setScheduledIso] = useState(isEdit ? post.scheduledAt || null : null);
  const [caption, setCaption] = useState(isEdit ? post.caption : '');
  const [firstComment, setFirstComment] = useState(isEdit ? post.firstComment || '' : '');
  const [title, setTitle] = useState(isEdit ? post.title || '' : '');
  const [link, setLink] = useState(isEdit ? post.link || '' : '');
  const [image, setImage] = useState(isEdit ? post.image || '' : '');
  const [mediaPath, setMediaPath] = useState(isEdit ? post.media?.path || '' : seedMediaPath);
  const [description, setDescription] = useState(isEdit ? post.description || '' : '');
  const [liDescription, setLiDescription] = useState(isEdit ? post.liDescription || '' : '');
  // X per-platform tweet-text override (capped 280); empty falls back to caption.
  const [xCaption, setXCaption] = useState(isEdit ? post.xCaption || '' : '');
  // X reply-chain intent: the same-campaign post id this tweet threads under.
  // Empty saves as null - the escape hatch for a dangling reference (parent
  // deleted -> the fail-closed X lane holds the child forever).
  const [xReplyTo, setXReplyTo] = useState(isEdit ? post.xReplyTo || '' : '');
  const [tags, setTags] = useState(isEdit ? post.tags || '' : '');
  const [blogSlug, setBlogSlug] = useState(isEdit ? post.blogSlug || '' : '');
  // Wave-2 article fields (wordpress/ghost): markdown body (falls back to the
  // caption when empty), short excerpt, Ghost's canonical source URL + the
  // "also send as newsletter" opt-in.
  const [body, setBody] = useState(isEdit ? post.body || '' : '');
  const [excerpt, setExcerpt] = useState(isEdit ? post.excerpt || '' : '');
  const [canonicalUrl, setCanonicalUrl] = useState(isEdit ? post.canonicalUrl || '' : '');
  const [ghostEmail, setGhostEmail] = useState(isEdit ? post.ghostEmail === true : false);
  // Per-platform note overrides (additive xCaption pattern); empty falls back
  // to the shared caption.
  const [mastodonCaption, setMastodonCaption] = useState(isEdit ? post.mastodonCaption || '' : '');
  const [nostrCaption, setNostrCaption] = useState(isEdit ? post.nostrCaption || '' : '');
  // GBP local-post intent as flat form state; serialized back to a post.gbp
  // object (or null when it says nothing) at save time.
  const [gbp, setGbp] = useState(isEdit ? gbpFormState(post.gbp) : gbpFormState(null));
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
    title: isEdit ? post.title || '' : '',
    link: isEdit ? post.link || '' : '',
    image: isEdit ? post.image || '' : '',
    mediaPath: isEdit ? post.media?.path || '' : seedMediaPath,
    description: isEdit ? post.description || '' : '',
    liDescription: isEdit ? post.liDescription || '' : '',
    xCaption: isEdit ? post.xCaption || '' : '',
    xReplyTo: isEdit ? post.xReplyTo || '' : '',
    tags: isEdit ? post.tags || '' : '',
    blogSlug: isEdit ? post.blogSlug || '' : '',
    body: isEdit ? post.body || '' : '',
    excerpt: isEdit ? post.excerpt || '' : '',
    canonicalUrl: isEdit ? post.canonicalUrl || '' : '',
    ghostEmail: isEdit ? post.ghostEmail === true : false,
    mastodonCaption: isEdit ? post.mastodonCaption || '' : '',
    nostrCaption: isEdit ? post.nostrCaption || '' : '',
    gbp: isEdit ? gbpFormState(post.gbp) : gbpFormState(null),
    stickers: isEdit ? post.interactiveStory?.stickers || [] : [],
    hashtagsMode: isEdit && Array.isArray(post.hashtags) ? 'custom' : 'global',
    hashtags: isEdit && Array.isArray(post.hashtags) ? post.hashtags.join(' ') : '',
  }));

  // The single platform whose caps the live lint should use (most-permissive of
  // the multi-select). Memoized so useLint's effect deps stay stable while typing.
  const lintPlatform = useMemo(() => representativePlatform(platforms), [platforms]);
  const lint = useLint(caption, lintPlatform);
  const descLint = useLint(description, lintPlatform);
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
  // silently dropped. Union of visiblePlatforms(accounts, posting) and the current
  // selection, in PLATFORMS order. Falls back to the full list when accounts/posting
  // are unavailable, so the picker is never empty on any render path.
  const pickerPlatforms = useMemo(() => {
    if (!accounts) return PLATFORMS;
    const visible = visiblePlatforms(accounts, posting);
    const allowed = new Set([...visible, ...platforms]);
    return PLATFORMS.filter((p) => allowed.has(p));
  }, [accounts, posting, platforms]);
  // The SHARED field-relevance model (lib/format.js), consumed identically by the
  // PostDetail review dialog so the authoring form and the review view can never
  // drift on which fields a post uses. Every conditional field below gates on
  // `rel.<field>` instead of an ad-hoc inline check.
  const rel = useMemo(() => fieldRelevance(platforms, type), [platforms, type]);
  const isLinkedinArticle = platforms.includes('linkedin') && type === 'text';
  // Article authoring (wave 2): the long-form fields apply whenever a blog lane
  // is targeted - WordPress and Ghost publish title + markdown body (falling
  // back to the caption), excerpt, hero image and tags.
  const isArticle = platforms.includes('wordpress') || platforms.includes('ghost');
  const showGbp = rel.gbp;
  const needsMedia = type !== 'text';
  // Nothing to preview: a pure text post with no link and no image, targeting
  // neither a blog lane nor LinkedIn, renders no card (PostPreview returns null).
  // Mirror that here so we hide the "Vorschau" label + toggle rather than leave
  // an empty labelled region dangling over nothing.
  const nothingToPreview = !isLinkedinArticle && !isArticle && type === 'text' && !link && !image;
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
    () => JSON.stringify({
      campaign, id, type, platforms, scheduledIso, caption, firstComment, title,
      link, image, mediaPath, description, liDescription, xCaption, xReplyTo, tags, blogSlug,
      body, excerpt, canonicalUrl, ghostEmail, mastodonCaption, nostrCaption, gbp,
      stickers, hashtagsMode, hashtags,
    }) !== initialSnapshot,
    [campaign, id, type, platforms, scheduledIso, caption, firstComment, title, link, image, mediaPath, description, liDescription, xCaption, xReplyTo, tags, blogSlug, body, excerpt, canonicalUrl, ghostEmail, mastodonCaption, nostrCaption, gbp, stickers, hashtagsMode, hashtags, initialSnapshot],
  );

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
    media: selectedAsset ? { url: selectedAsset.url, cover: selectedAsset.cover || null, file: selectedAsset.file } : null,
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
      platformsFieldsetRef.current?.querySelector('button')?.focus();
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
    setBusy(true);
    try {
      if (isEdit) {
        await updatePost(post.campaign, post.id, post.rev, {
          type,
          platforms,
          scheduledAt: scheduledIso,
          caption,
          firstComment: firstComment || null,
          title: title || null,
          link: link || null,
          image: image || null,
          path: mediaPath || null,
          description: description || null,
          liDescription: liDescription || null,
          xCaption: xCaption || null,
          xReplyTo: xReplyToClean || null,
          tags: tags || null,
          blogSlug: blogSlug || null,
          body: body || null,
          excerpt: excerpt || null,
          canonicalUrl: canonicalUrl || null,
          ghostEmail: ghostEmail === true ? true : null,
          mastodonCaption: mastodonCaption || null,
          nostrCaption: nostrCaption || null,
          gbp: gbpPayload,
          interactiveStory: interactiveStoryPayload,
          hashtags: hashtagsPayload,
        });
      } else {
        await createPost(campaign, {
          id,
          type,
          platforms,
          scheduledAt: scheduledIso,
          caption,
          firstComment: firstComment || undefined,
          title: title || undefined,
          link: link || undefined,
          image: image || undefined,
          path: mediaPath || undefined,
          description: description || undefined,
          liDescription: liDescription || undefined,
          xCaption: xCaption || undefined,
          xReplyTo: xReplyToClean || undefined,
          tags: tags || undefined,
          blogSlug: blogSlug || undefined,
          body: body || undefined,
          excerpt: excerpt || undefined,
          canonicalUrl: canonicalUrl || undefined,
          ghostEmail: ghostEmail === true ? true : undefined,
          mastodonCaption: mastodonCaption || undefined,
          nostrCaption: nostrCaption || undefined,
          gbp: gbpPayload || undefined,
          interactiveStory: interactiveStoryPayload || undefined,
          hashtags: hashtagsPayload || undefined,
        });
      }
      queryClient.invalidateQueries({ queryKey: ['plans'] });
      onSaved?.(campaign, isEdit ? post.id : id);
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
            <legend className={EYEBROW}>{t('composer.field.platforms')}</legend>
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
                <select id="composer-campaign" ref={campaignSelectRef} value={campaign} onChange={(e) => setCampaign(e.target.value)} className={FIELD_CLS}>
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
                <input id="composer-id" ref={idRef} value={id} onChange={(e) => { setIdEdited(true); setId(e.target.value); }} placeholder={t('composer.postIdPlaceholder')} className={FIELD_CLS} />
              </div>
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-type">{t('composer.field.format')}</label>
              <select id="composer-type" value={type} onChange={(e) => onTypeChange(e.target.value)} className={FIELD_CLS}>
                {TYPES.map((ty) => (
                  <option key={ty} value={ty}>{t(`type.${ty}`)}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <label className={EYEBROW}>{t('composer.field.schedule')}</label>
              <DateTimePicker value={scheduledIso} onChange={setScheduledIso} />
            </div>
          </div>

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
              <textarea id="composer-caption" value={caption} onChange={(e) => setCaption(e.target.value)} rows={7} className={`${FIELD_CLS} resize-y leading-relaxed`} />
              <div aria-live="polite">
                <LintPanel lint={lint} />
              </div>
            </div>
          ) : null}

          {rel.xCaption ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-x-caption">{t('composer.field.xCaption')}</label>
              <textarea
                id="composer-x-caption"
                value={xCaption}
                onChange={(e) => setXCaption(e.target.value)}
                rows={3}
                placeholder={t('composer.field.xCaptionPlaceholder')}
                aria-describedby="composer-x-counter"
                className={`${FIELD_CLS} resize-y leading-relaxed`}
              />
              <CharCounter id="composer-x-counter" len={xLen} max={CAPTION_CAPS.x} over={xOver} />
              {/* r2-3: announce ONLY the over/under transition, not every keystroke. */}
              <p role="status" aria-live="polite" className="sr-only">{xOverAnnounce}</p>
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
                className={FIELD_CLS}
              />
              <datalist id="composer-x-reply-to-posts">
                {campaignPosts
                  .filter((p) => p.id !== (isEdit ? post.id : id) && (p.platforms || []).includes('x'))
                  .map((p) => <option key={p.id} value={p.id} />)}
              </datalist>
            </div>
          ) : null}

          {rel.mastodonCaption ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-mastodon-caption">{t('composer.field.mastodonCaption')}</label>
              <textarea
                id="composer-mastodon-caption"
                value={mastodonCaption}
                onChange={(e) => setMastodonCaption(e.target.value)}
                rows={3}
                placeholder={t('composer.field.mastodonCaptionPlaceholder')}
                aria-describedby="composer-mastodon-counter"
                className={`${FIELD_CLS} resize-y leading-relaxed`}
              />
              <CharCounter id="composer-mastodon-counter" len={mastodonLen} max={CAPTION_CAPS.mastodon} over={mastodonOver} />
              <p role="status" aria-live="polite" className="sr-only">{mastodonOverAnnounce}</p>
            </div>
          ) : null}

          {rel.nostrCaption ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-nostr-caption">{t('composer.field.nostrCaption')}</label>
              <textarea
                id="composer-nostr-caption"
                value={nostrCaption}
                onChange={(e) => setNostrCaption(e.target.value)}
                rows={3}
                placeholder={t('composer.field.nostrCaptionPlaceholder')}
                className={`${FIELD_CLS} resize-y leading-relaxed`}
              />
            </div>
          ) : null}

          {showFirstComment ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-comment">{t('composer.field.firstComment')}</label>
              <textarea id="composer-comment" value={firstComment} onChange={(e) => setFirstComment(e.target.value)} rows={2} className={`${FIELD_CLS} resize-y`} />
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
              <input id="composer-title" value={title} onChange={(e) => setTitle(e.target.value)} className={FIELD_CLS} />
              {isArticle ? <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.field.titleArticleHint')}</p> : null}
            </div>
          ) : null}

          {/* Wave-2 article fields (wordpress/ghost): markdown body + excerpt;
              the shared image field below doubles as the article hero. */}
          {rel.body ? (
            <>
              <div className="space-y-1.5">
                <label className={EYEBROW} htmlFor="composer-body">{t('composer.field.body')}</label>
                <textarea id="composer-body" value={body} onChange={(e) => setBody(e.target.value)} rows={10} className={`${FIELD_CLS} resize-y font-mono leading-relaxed`} />
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.field.bodyHint')}</p>
              </div>
              <div className="space-y-1.5">
                <label className={EYEBROW} htmlFor="composer-excerpt">{t('composer.field.excerpt')}</label>
                <textarea id="composer-excerpt" value={excerpt} onChange={(e) => setExcerpt(e.target.value)} rows={2} className={`${FIELD_CLS} resize-y`} />
                <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('composer.field.excerptHint')}</p>
              </div>
            </>
          ) : null}

          {rel.link ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-link">{t('composer.field.link')}</label>
              <input id="composer-link" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://example.com/blog/..." className={FIELD_CLS} />
            </div>
          ) : null}

          {/* ONE image field serves both cards: the LinkedIn link-preview
              thumbnail and the wordpress/ghost article hero (same post.image). */}
          {rel.image ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-image">{isArticle ? t('composer.field.imageArticle') : t('composer.field.image')}</label>
              <input id="composer-image" value={image} onChange={(e) => setImage(e.target.value)} placeholder="https://res.cloudinary.com/<your-cloud>/..." className={FIELD_CLS} />
            </div>
          ) : null}

          {rel.canonicalUrl ? (
            <>
              <div className="space-y-1.5">
                <label className={EYEBROW} htmlFor="composer-canonical-url">{t('composer.field.canonicalUrl')}</label>
                <input id="composer-canonical-url" value={canonicalUrl} onChange={(e) => setCanonicalUrl(e.target.value)} placeholder="https://example.com/original-post" className={FIELD_CLS} />
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
            </>
          ) : null}

          {rel.liDescription ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-li-description">{t('composer.field.liDescription')}</label>
              <textarea id="composer-li-description" value={liDescription} onChange={(e) => setLiDescription(e.target.value)} rows={3} className={`${FIELD_CLS} resize-y leading-relaxed`} />
            </div>
          ) : null}

          {rel.description ? (
            <>
              <div className="space-y-1.5">
                <label className={EYEBROW} htmlFor="composer-description">{t('composer.field.description')}</label>
                <textarea id="composer-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={6} className={`${FIELD_CLS} resize-y leading-relaxed`} />
                <div aria-live="polite">
                  <LintPanel lint={descLint} />
                </div>
              </div>
              <div className="space-y-1.5">
                <label className={EYEBROW} htmlFor="composer-blogslug">{t('composer.field.blogSlug')}</label>
                <input id="composer-blogslug" value={blogSlug} onChange={(e) => setBlogSlug(e.target.value)} placeholder={t('composer.field.blogSlugPlaceholder')} className={FIELD_CLS} />
              </div>
            </>
          ) : null}

          {/* Tags serve YouTube (video tags) and the article lanes (post tags). */}
          {rel.tags ? (
            <div className="space-y-1.5">
              <label className={EYEBROW} htmlFor="composer-tags">{t('composer.field.tags')}</label>
              <input id="composer-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder={t('composer.field.tagsPlaceholder')} className={FIELD_CLS} />
            </div>
          ) : null}

          {showGbp ? <GbpFields gbp={gbp} onChange={setGbp} /> : null}

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
            <button type="button" onClick={save} disabled={busy} className="flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-bold text-white shadow-lg shadow-brand/20 transition hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-60 dark:bg-brand-light dark:text-zinc-900">
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
