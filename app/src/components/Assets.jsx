import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Upload, Search, Play, FileVideo, Zap, Loader2, CheckCircle2, AlertTriangle, Clapperboard, Captions, X, Plus, Trash2, Pencil, LayoutGrid, List, Image as ImageIcon, Film, ArrowDownUp } from 'lucide-react';
import { useAssets, uploadAssetFile, deleteAsset, renameAsset } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { fmtBytes, prettyCampaign, fmtFull, RES_ASPECT } from '../lib/format.js';
import { Skeleton, INNER_SURFACE, CoverThumb, FilterChip } from './ui.jsx';
import { IconBadge } from './ui/IconBadge.jsx';
import { Tip } from './ui/Tooltip.jsx';
import { useConfirm, usePrompt } from './ui/confirm.jsx';

const RES_LABEL = { 'story-9x16': '9:16', 'feed-4x5': '4:5', 'square-1x1': '1:1' };

// RES_ASPECT (resolution -> cover box aspect) is the shared map in format.js, reused
// here and by the Planner's mediaAspect so the asset grid and the calendar can never
// drift. 'other'/unknown is absent on purpose - the caller falls back to portrait.

// B9: pick a sensible default composer post type for an asset's resolution so the
// pre-seeded draft starts on the format the media actually fits. A 9:16 portrait
// defaults to a reel; everything else to a plain feed video. The operator can
// still change it in the composer - this only sets the starting selection.
function seedTypeForAsset(asset) {
  return asset.checks?.resolution === 'story-9x16' ? 'reel' : 'video';
}

// A4: an asset is an image when the backend says so (kind) or, defensively, when
// its filename carries a still extension - so the UI degrades correctly even if a
// legacy cached probe predates the kind field. Single source of truth for every
// image branch (the type badge, the card's no-<video> path, the type filter).
function isImageAsset(asset) {
  return asset?.kind === 'image' || /\.(jpe?g|png)$/i.test(asset?.file || '');
}
const RES_TIP_KEY = {
  'story-9x16': 'assets.spec.res.story',
  'feed-4x5': 'assets.spec.res.feed',
  'square-1x1': 'assets.spec.res.square',
};

// Upload errors arrive as raw server strings (lib/api.js wraps the server
// message). Map the known fragments to a stable i18n key; everything else falls
// back to a generic key so the owner never sees a raw server string. This is a
// plain function (not a component), so it returns the key and the caller, which
// has the t() hook in scope, renders the localized copy.
function uploadErrorKey(raw) {
  const msg = String(raw || '').toLowerCase();
  if (msg.includes('too large') || msg.includes('413') || msg.includes('exceed')) return 'assets.upload.errorTooLarge';
  if (msg.includes('unsupported') || msg.includes('content-type') || msg.includes('type')) return 'assets.upload.errorFormat';
  if (msg.includes('filename') || msg.includes('invalid_input') || msg.includes('invalid')) return 'assets.upload.errorFilename';
  if (msg.includes('exists') || msg.includes('already')) return 'assets.upload.errorExists';
  if (msg.includes('failed to fetch') || msg.includes('network') || msg.includes('econnrefused')) return 'assets.upload.errorUnreachable';
  return 'assets.upload.errorGeneric';
}

// Technical specs follow the secondary-label rule: short + meaningful resolution
// stays as text; the jargon flags (codec, faststart) become icon + color + tooltip.
// The image/video type indicator: an icon-only badge (Image/Film, aria-hidden) with
// a tooltip + accessible name, so a screen reader hears the kind and a sighted user
// reads it on hover. Shared by the card SpecRow and the list row meta cluster.
function TypeBadge({ isImage }) {
  const t = useT();
  return (
    <IconBadge
      icon={isImage ? ImageIcon : Film}
      tone="neutral"
      label={isImage ? t('assets.spec.type.image') : t('assets.spec.type.video')}
    />
  );
}

function SpecRow({ asset }) {
  const t = useT();
  const c = asset.checks;
  if (!c) return null;
  const isImage = isImageAsset(asset);
  const resKnown = c.resolution !== 'other';
  // Pills are uniform NEUTRAL for descriptive facts (type, known resolution, codec/
  // faststart OK) so a healthy asset reads as one calm row; only a real problem (unknown
  // resolution, bad codec/faststart) turns amber, so colour means "needs attention", never
  // "active vs inactive". (item 12)
  return (
    <div className="flex flex-wrap items-center gap-1">
      <TypeBadge isImage={isImage} />
      <IconBadge
        tone={resKnown ? 'neutral' : 'warn'}
        text={RES_LABEL[c.resolution] || `${asset.probe?.width}x${asset.probe?.height}`}
        label={RES_TIP_KEY[c.resolution] ? t(RES_TIP_KEY[c.resolution]) : t('assets.spec.res.other')}
      />
      {/* A4: codec + faststart are H.264/MP4-atom verdicts - meaningless for a still
          image (the backend nulls them), so an image shows resolution + type only. */}
      {isImage ? null : (
        <>
          <IconBadge
            icon={FileVideo}
            tone={c.codecOk ? 'neutral' : 'warn'}
            label={c.codecOk ? t('assets.spec.codecOk') : t('assets.spec.codecBad')}
          />
          <IconBadge
            icon={Zap}
            tone={c.faststart ? 'neutral' : 'warn'}
            label={c.faststart ? t('assets.spec.faststartOk') : t('assets.spec.faststartBad')}
          />
        </>
      )}
    </div>
  );
}

export function AssetCard({ asset, dir, onAttach, onDelete, onRename }) {
  const t = useT();
  const [playing, setPlaying] = useState(false);
  const used = asset.usedBy && asset.usedBy.length;
  const isImage = isImageAsset(asset);
  const aspectClass = RES_ASPECT[asset.checks?.resolution] || 'aspect-[9/16]';
  return (
    <div className={`flex flex-col overflow-hidden rounded-xl ${INNER_SURFACE}`}>
      <div className="relative bg-black/5 dark:bg-black/20">
        {isImage ? (
          // A4: a still image has no playback - show the picture itself (CoverThumb's
          // image branch), never a play button or a <video>.
          <CoverThumb media={asset} className={`${aspectClass} w-full`} />
        ) : playing && asset.url ? (
          <>
            <video
              src={asset.url}
              poster={asset.cover || undefined}
              controls
              autoPlay
              onEnded={() => setPlaying(false)}
              className={`${aspectClass} w-full bg-black object-contain`}
            />
            <Tip label={t('assets.card.closePlayback')}>
              <button
                type="button"
                onClick={() => setPlaying(false)}
                aria-label={t('assets.card.closePlayback')}
                className="absolute right-1.5 top-1.5 z-10 grid h-6 w-6 place-items-center rounded-full bg-black/55 text-white backdrop-blur transition hover:bg-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
              >
                <X size={13} aria-hidden="true" />
              </button>
            </Tip>
          </>
        ) : (
          <button type="button" onClick={() => setPlaying(true)} className="group relative block w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand" aria-label={t('assets.card.play', { file: asset.file })}>
            {/* US-ASSET-13: cover JPEG when present, else the video's own first
                frame - never a bare icon (CoverThumb owns that fallback). */}
            <CoverThumb media={asset} className={`${aspectClass} w-full`} />
            <span className="absolute inset-0 grid place-items-center opacity-0 transition group-hover:opacity-100">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-black/55 text-white backdrop-blur">
                <Play size={18} aria-hidden="true" />
              </span>
            </span>
          </button>
        )}
      </div>
      <div className="space-y-1.5 p-2.5">
        <Tip label={asset.file} align="start">
          <button type="button" className="block w-full truncate text-left text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">{asset.file}</button>
        </Tip>
        <div className="flex flex-wrap items-center gap-1">
          <SpecRow asset={asset} />
          {asset.captions?.length ? (
            <IconBadge
              icon={Captions}
              tone="info"
              text={String(asset.captions.length)}
              label={t('assets.card.captions', { count: asset.captions.length })}
            />
          ) : null}
        </div>
        <p className="text-[10px] text-zinc-500 dark:text-zinc-400">
          {asset.probe?.durationSec ? `${asset.probe.durationSec}s · ` : ''}
          {fmtBytes(asset.bytes)}
        </p>
        {used ? (
          <Tip label={asset.usedBy.map((u) => `${u.postId} · ${prettyCampaign(u.campaign)}${u.scheduledAt ? ` · ${fmtFull(u.scheduledAt)}` : ''}`).join(' / ')}>
            <button type="button" className="text-[10px] font-bold text-emerald-600 dark:text-emerald-300">
              {t('assets.card.usedIn', { count: asset.usedBy.length })}
            </button>
          </Tip>
        ) : (
          <p className="text-[10px] text-zinc-400 dark:text-zinc-500">{t('assets.card.unused')}</p>
        )}
        {/* "Posten" is the dominant action (item 12): a brand-filled, full-width primary.
            Rename + delete drop to quiet icon-only buttons beside it (mirroring the list row). */}
        <div className="flex items-center gap-1.5 pt-0.5">
          {onAttach ? (
            <button
              type="button"
              onClick={() => onAttach({ mediaPath: `${dir}/${asset.file}`, type: seedTypeForAsset(asset) })}
              aria-label={t('assets.card.attachAria', { file: asset.file })}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand px-2.5 py-2 text-xs font-bold text-white shadow-sm transition hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-brand-light dark:text-zinc-900 dark:hover:bg-brand-light/90"
            >
              <Plus size={14} aria-hidden="true" />
              {t('assets.card.attach')}
            </button>
          ) : null}
          <Tip label={t('assets.card.renameAria', { file: asset.file })}>
            <button
              type="button"
              onClick={() => onRename(asset)}
              aria-label={t('assets.card.renameAria', { file: asset.file })}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-zinc-200/60 text-zinc-600 transition hover:bg-zinc-300/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-zinc-800/60 dark:text-zinc-300 dark:hover:bg-zinc-700/60"
            >
              <Pencil size={14} aria-hidden="true" />
            </button>
          </Tip>
          <Tip label={t('assets.card.deleteAria', { file: asset.file })}>
            <button
              type="button"
              onClick={() => onDelete(asset)}
              aria-label={t('assets.card.deleteAria', { file: asset.file })}
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-red-500/10 text-red-600 transition hover:bg-red-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-red-300"
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </Tip>
        </div>
      </div>
    </div>
  );
}

// A4 list-row layout: the same asset rendered as a compact <li> for the list view -
// a small static thumbnail (CoverThumb; an image shows its picture, a video its
// cover/first-frame, never a play affordance here), the truncated name, a meta
// cluster (type badge + resolution via SpecRow, used/unused, size, modified date),
// and the SAME attach/rename/delete handlers + aria-label keys as the card. Wrapped
// by a <ul role="list"> in the parent.
export function AssetRow({ asset, dir, onAttach, onDelete, onRename }) {
  const t = useT();
  const used = asset.usedBy && asset.usedBy.length;
  return (
    <li className={`flex items-center gap-3 rounded-xl p-2 ${INNER_SURFACE}`}>
      <CoverThumb media={asset} className="h-12 w-12 shrink-0 rounded-lg" />
      <div className="min-w-0 flex-1 space-y-1">
        <Tip label={asset.file} align="start">
          <button type="button" className="block max-w-full truncate text-left text-xs font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">{asset.file}</button>
        </Tip>
        <div className="flex flex-wrap items-center gap-1">
          <SpecRow asset={asset} />
          {asset.captions?.length ? (
            <IconBadge icon={Captions} tone="info" text={String(asset.captions.length)} label={t('assets.card.captions', { count: asset.captions.length })} />
          ) : null}
          {used ? (
            <Tip label={asset.usedBy.map((u) => `${u.postId} · ${prettyCampaign(u.campaign)}${u.scheduledAt ? ` · ${fmtFull(u.scheduledAt)}` : ''}`).join(' / ')}>
              <button type="button" className="text-[10px] font-bold text-emerald-600 dark:text-emerald-300">
                {t('assets.card.usedIn', { count: asset.usedBy.length })}
              </button>
            </Tip>
          ) : (
            <span className="text-[10px] text-zinc-400 dark:text-zinc-500">{t('assets.card.unused')}</span>
          )}
        </div>
        <p className="text-[10px] text-zinc-500 dark:text-zinc-400">
          {asset.probe?.durationSec ? `${asset.probe.durationSec}s · ` : ''}
          {fmtBytes(asset.bytes)}
          {asset.modifiedAt ? ` · ${t('assets.row.modified', { when: fmtFull(asset.modifiedAt) })}` : ''}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {onAttach ? (
          <Tip label={t('assets.card.attachAria', { file: asset.file })}>
            <button
              type="button"
              onClick={() => onAttach({ mediaPath: `${dir}/${asset.file}`, type: seedTypeForAsset(asset) })}
              aria-label={t('assets.card.attachAria', { file: asset.file })}
              className="grid h-8 w-8 place-items-center rounded-lg bg-brand/10 text-brand transition hover:bg-brand/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-brand-light/10 dark:text-brand-light dark:hover:bg-brand-light/15"
            >
              <Plus size={14} aria-hidden="true" />
            </button>
          </Tip>
        ) : null}
        <Tip label={t('assets.card.renameAria', { file: asset.file })}>
          <button
            type="button"
            onClick={() => onRename(asset)}
            aria-label={t('assets.card.renameAria', { file: asset.file })}
            className="grid h-8 w-8 place-items-center rounded-lg bg-zinc-200/60 text-zinc-600 transition hover:bg-zinc-300/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-zinc-800/60 dark:text-zinc-300 dark:hover:bg-zinc-700/60"
          >
            <Pencil size={14} aria-hidden="true" />
          </button>
        </Tip>
        <Tip label={t('assets.card.deleteAria', { file: asset.file })}>
          <button
            type="button"
            onClick={() => onDelete(asset)}
            aria-label={t('assets.card.deleteAria', { file: asset.file })}
            className="grid h-8 w-8 place-items-center rounded-lg bg-red-500/10 text-red-600 transition hover:bg-red-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-red-300"
          >
            <Trash2 size={14} aria-hidden="true" />
          </button>
        </Tip>
      </div>
    </li>
  );
}

export default function Assets({ onAttach }) {
  const t = useT();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const { data, isLoading, isError } = useAssets(true);
  const loadError = isError || Boolean(data?.error);
  // B9: the canonical media directory the server reports for the active client.
  // The Attach CTA builds `${dir}/${file}` from this so the seeded path matches
  // VideoPicker's `${assetsData.dir}/${file}` exactly (not a hardcoded prefix).
  const dir = data?.dir || '';
  const [q, setQ] = useState('');
  const [folder, setFolder] = useState('all');
  const [mediaType, setMediaType] = useState('all'); // 'all' | 'image' | 'video'
  const [sort, setSort] = useState('newest'); // newest | oldest | largest | smallest
  // A4: persisted grid<->list view, mirroring the studio-theme / pendpost-locale
  // idiom (read once from localStorage, persisted in an effect below). Guarded like
  // i18n.resolveLocale(): localStorage may be unavailable (private mode, or a test
  // env that ships no Storage), so a failed read just falls back to the grid default.
  const [view, setView] = useState(() => {
    try { return localStorage.getItem('pendpost-assets-view') === 'list' ? 'list' : 'grid'; } catch { return 'grid'; }
  });
  const [dragging, setDragging] = useState(false);
  const [uploads, setUploads] = useState([]); // [{name, state:'uploading'|'done'|'error', error?}]
  const inputRef = useRef(null);

  useEffect(() => {
    try { localStorage.setItem('pendpost-assets-view', view); } catch { /* private mode - ignore */ }
  }, [view]);

  const assets = useMemo(() => data?.assets || [], [data]);
  const shown = useMemo(
    () => {
      const filtered = assets.filter((a) => {
        if (q && !a.file.toLowerCase().includes(q.toLowerCase())) return false;
        // Media-type filter (A4): narrow to images or videos by kind.
        if (mediaType === 'image' && !isImageAsset(a)) return false;
        if (mediaType === 'video' && isImageAsset(a)) return false;
        if (folder === 'unused') return !(a.usedBy && a.usedBy.length);
        if (folder === 'used') return Boolean(a.usedBy && a.usedBy.length);
        if (['story-9x16', 'feed-4x5', 'square-1x1'].includes(folder)) return a.checks?.resolution === folder;
        return true;
      });
      // Sort (A4): newest/oldest by modifiedAt, largest/smallest by bytes. A copy so
      // the source assets array (and readdir order) is never mutated in place.
      const sorted = [...filtered];
      sorted.sort((a, b) => {
        switch (sort) {
          case 'oldest': return new Date(a.modifiedAt || 0) - new Date(b.modifiedAt || 0);
          case 'largest': return (b.bytes || 0) - (a.bytes || 0);
          case 'smallest': return (a.bytes || 0) - (b.bytes || 0);
          case 'newest':
          default: return new Date(b.modifiedAt || 0) - new Date(a.modifiedAt || 0);
        }
      });
      return sorted;
    },
    [assets, q, folder, mediaType, sort],
  );

  const handleFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    for (const file of files) {
      setUploads((u) => [...u.filter((x) => x.name !== file.name), { name: file.name, state: 'uploading' }]);
      try {
        // eslint-disable-next-line no-await-in-loop
        await uploadAssetFile(file);
        setUploads((u) => u.map((x) => (x.name === file.name ? { ...x, state: 'done' } : x)));
        queryClient.invalidateQueries({ queryKey: ['assets'] });
      } catch (err) {
        setUploads((u) => u.map((x) => (x.name === file.name ? { ...x, state: 'error', error: t(uploadErrorKey(err.message)) } : x)));
      }
    }
  };

  const dismissUpload = (name) => setUploads((u) => u.filter((x) => x.name !== name));

  // A readable list of the posts that reference an asset, for the destructive
  // confirm body (C2): "r07 · Launch 2026 / r08 · Other". usedBy is the same
  // join scanAssets surfaces (campaign/postId).
  const usedByLabel = (asset) => (asset.usedBy || [])
    .map((u) => `${u.postId} · ${prettyCampaign(u.campaign)}`)
    .join(' / ');

  // Delete one asset. SURFACES the using post(s) in the confirm body before the
  // destructive action; the human click is the confirmation, so an in-use delete
  // passes confirm:true to satisfy the server's needs_confirm gate. Invalidates
  // ['assets'] on success.
  const handleDelete = async (asset) => {
    const inUse = Boolean(asset.usedBy && asset.usedBy.length);
    const okToGo = await confirm({
      title: t('assets.delete.title', { file: asset.file }),
      body: inUse
        ? t('assets.delete.bodyInUse', { file: asset.file, count: asset.usedBy.length, posts: usedByLabel(asset) })
        : t('assets.delete.body'),
      confirmLabel: t('assets.delete.confirm'),
      danger: true,
    });
    if (!okToGo) return;
    try {
      await deleteAsset(asset.file, inUse);
      queryClient.invalidateQueries({ queryKey: ['assets'] });
    } catch (err) {
      await confirm({
        title: t('assets.delete.title', { file: asset.file }),
        body: t('assets.mutate.errorGeneric'),
        confirmLabel: t('assets.delete.confirm'),
      });
    }
  };

  // Rename one asset. Prompts for the new name (defaulting to the current one),
  // surfaces the using post(s) when in-use so the owner sees the breakage before
  // committing, then calls renameAsset (confirm:true when in-use). Invalidates
  // ['assets'] on success.
  const handleRename = async (asset) => {
    const inUse = Boolean(asset.usedBy && asset.usedBy.length);
    const toName = await prompt({
      title: t('assets.rename.title', { file: asset.file }),
      body: inUse
        ? t('assets.rename.bodyInUse', { file: asset.file, count: asset.usedBy.length, posts: usedByLabel(asset) })
        : t('assets.rename.body'),
      placeholder: t('assets.rename.placeholder'),
      defaultValue: asset.file,
      confirmLabel: t('assets.rename.confirm'),
    });
    if (!toName || toName.trim() === '' || toName.trim() === asset.file) return;
    try {
      await renameAsset(asset.file, toName.trim(), inUse);
      queryClient.invalidateQueries({ queryKey: ['assets'] });
    } catch (err) {
      await confirm({
        title: t('assets.rename.title', { file: asset.file }),
        body: err?.code === 'invalid_input' && /exists/i.test(err?.message || '')
          ? t('assets.mutate.errorExists')
          : t('assets.mutate.errorGeneric'),
        confirmLabel: t('assets.rename.confirm'),
      });
    }
  };

  // Auto-clear finished rows after ~2s so the status list does not linger; error
  // rows persist (the owner dismisses them via the per-row X).
  useEffect(() => {
    if (!uploads.some((u) => u.state === 'done')) return undefined;
    const t = setTimeout(() => {
      setUploads((u) => u.filter((x) => x.state !== 'done'));
    }, 2000);
    return () => clearTimeout(t);
  }, [uploads]);

  const folders = [
    ['all', t('assets.filter.all')],
    ['unused', t('assets.filter.unused')],
    ['used', t('assets.filter.used')],
    ['story-9x16', '9:16'],
    ['feed-4x5', '4:5'],
    ['square-1x1', '1:1'],
  ];

  return (
    <div className="flex h-full flex-col gap-3">
      <header className="flex flex-wrap items-center gap-2">
        <div>
          <h2 className="font-display text-lg font-bold">{t('assets.header.title')}</h2>
          <p className="text-[11px] text-zinc-500 dark:text-zinc-400">{t('assets.mediaDir')} {t('assets.header.fileCount', { count: assets.length })}</p>
        </div>
        <span className="flex-1" />
        <div className="relative">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-400" aria-hidden="true" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('assets.search.placeholder')} aria-label={t('assets.search.placeholder')} className={`w-44 rounded-xl border-0 py-2 pl-8 pr-3 text-sm ${INNER_SURFACE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`} />
        </div>
        {/* A4: grid<->list segmented control. aria-pressed marks the active view
            (not color-only) and each button carries an explicit switch-to label. */}
        <div className={`flex items-center gap-0.5 rounded-xl p-0.5 ${INNER_SURFACE}`} role="group" aria-label={t('assets.sort.label')}>
          <Tip label={t('assets.view.toGrid')}>
            <button
              type="button"
              onClick={() => setView('grid')}
              aria-pressed={view === 'grid'}
              aria-label={t('assets.view.toGrid')}
              className={`grid h-7 w-7 place-items-center rounded-lg transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${view === 'grid' ? 'bg-brand text-white dark:bg-brand-light dark:text-zinc-900' : 'text-zinc-500 hover:bg-zinc-200/60 dark:text-zinc-400 dark:hover:bg-zinc-700/60'}`}
            >
              <LayoutGrid size={14} aria-hidden="true" />
            </button>
          </Tip>
          <Tip label={t('assets.view.toList')}>
            <button
              type="button"
              onClick={() => setView('list')}
              aria-pressed={view === 'list'}
              aria-label={t('assets.view.toList')}
              className={`grid h-7 w-7 place-items-center rounded-lg transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${view === 'list' ? 'bg-brand text-white dark:bg-brand-light dark:text-zinc-900' : 'text-zinc-500 hover:bg-zinc-200/60 dark:text-zinc-400 dark:hover:bg-zinc-700/60'}`}
            >
              <List size={14} aria-hidden="true" />
            </button>
          </Tip>
        </div>
        <button type="button" onClick={() => inputRef.current?.click()} className="flex items-center gap-1.5 rounded-xl bg-brand px-3 py-2 text-sm font-bold text-white shadow-lg shadow-brand/20 transition hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-brand-light dark:text-zinc-900">
          <Upload size={14} aria-hidden="true" />
          {t('assets.upload.button')}
        </button>
        <input ref={inputRef} type="file" accept="video/*,image/png,image/jpeg" multiple className="hidden" aria-label={t('assets.upload.button')} onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }} />
      </header>

      {/* Drag-drop ingestion zone. */}
      <div
        role="region"
        aria-label={t('assets.drop.region')}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); handleFiles(e.dataTransfer.files); }}
        className={`flex flex-wrap items-center justify-center gap-x-1.5 gap-y-1 rounded-2xl border-2 border-dashed px-4 py-3 text-center text-xs transition ${dragging ? 'border-brand bg-brand/5 text-brand dark:text-brand-light' : 'border-zinc-300/70 text-zinc-400 dark:border-zinc-700/70 dark:text-zinc-500'}`}
      >
        <span>{t('assets.drop.prompt')}</span>
        <label className="cursor-pointer rounded-full px-2 py-0.5 font-bold text-brand underline decoration-dotted underline-offset-2 transition hover:bg-brand/5 focus-within:outline-none focus-within:ring-2 focus-within:ring-brand dark:text-brand-light">
          {t('assets.drop.choose')}
          <input
            type="file"
            accept="video/*,image/png,image/jpeg"
            multiple
            className="sr-only"
            onChange={(e) => { handleFiles(e.target.files); e.target.value = ''; }}
          />
        </label>
        <span>{t('assets.drop.suffix')}</span>
      </div>

      {uploads.length ? (
        <ul role="status" aria-live="polite" className="space-y-1">
          {uploads.map((u) => (
            <li key={u.name} className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-[11px] ${INNER_SURFACE}`}>
              {u.state === 'uploading' ? <Loader2 size={12} className="animate-spin text-zinc-400" aria-hidden="true" /> : u.state === 'done' ? <CheckCircle2 size={12} className="text-emerald-500" aria-hidden="true" /> : <AlertTriangle size={12} className="text-red-500" aria-hidden="true" />}
              <span className="flex-1 truncate font-bold">{u.name}</span>
              <span className={u.state === 'error' ? 'text-red-600 dark:text-red-300' : 'text-zinc-500 dark:text-zinc-400'}>{u.state === 'uploading' ? t('assets.upload.statusUploading') : u.state === 'done' ? t('assets.upload.statusDone') : u.error}</span>
              {u.state === 'error' ? (
                <Tip label={t('assets.upload.dismissTip')}>
                  <button
                    type="button"
                    onClick={() => dismissUpload(u.name)}
                    aria-label={t('assets.upload.dismissAria', { name: u.name })}
                    className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-zinc-400 transition hover:bg-zinc-300/60 hover:text-zinc-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:hover:bg-zinc-700/60 dark:hover:text-zinc-200"
                  >
                    <X size={11} aria-hidden="true" />
                  </button>
                </Tip>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <div className="flex flex-wrap gap-1" role="group" aria-label={t('assets.filter.usage')}>
          {folders.map(([k, label]) => (
            <FilterChip key={k} active={folder === k} onClick={() => setFolder(k)} label={label} />
          ))}
        </div>
        <span className="mx-0.5 hidden h-4 w-px self-center bg-zinc-300/70 dark:bg-zinc-700/70 sm:block" aria-hidden="true" />
        {/* A4: media-type filter (all / images / videos) via kind. The group carries
            an accessible name so its "All" is distinct from the usage-filter "All". */}
        <div className="flex flex-wrap gap-1" role="group" aria-label={t('assets.filter.type')}>
          <FilterChip active={mediaType === 'all'} onClick={() => setMediaType('all')} label={t('assets.filter.all')} />
          <FilterChip active={mediaType === 'image'} onClick={() => setMediaType('image')} icon={ImageIcon} label={t('assets.filter.image')} />
          <FilterChip active={mediaType === 'video'} onClick={() => setMediaType('video')} icon={Film} label={t('assets.filter.video')} />
        </div>
        <span className="flex-1" />
        {/* A4: sort control. A native <select> for KISS + free keyboard/a11y. */}
        <label className="flex items-center gap-1.5 text-[11px] font-bold text-zinc-500 dark:text-zinc-400">
          <ArrowDownUp size={12} aria-hidden="true" />
          <span className="sr-only">{t('assets.sort.label')}</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            aria-label={t('assets.sort.label')}
            className={`rounded-lg border-0 py-1 pl-2 pr-6 text-[11px] font-bold ${INNER_SURFACE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`}
          >
            <option value="newest">{t('assets.sort.newest')}</option>
            <option value="oldest">{t('assets.sort.oldest')}</option>
            <option value="largest">{t('assets.sort.largest')}</option>
            <option value="smallest">{t('assets.sort.smallest')}</option>
          </select>
        </label>
      </div>

      {loadError ? (
        <div role="alert" className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs font-bold text-amber-700 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300">
          <AlertTriangle size={14} aria-hidden="true" className="shrink-0" />
          <span>{t('assets.error.loadFailed')}</span>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">
        {isLoading ? (
          view === 'list' ? (
            <ul role="list" className="space-y-2">
              {Array.from({ length: 8 }, (_, i) => <li key={i}><Skeleton className="h-16 w-full" /></li>)}
            </ul>
          ) : (
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
              {Array.from({ length: 10 }, (_, i) => <Skeleton key={i} className="aspect-[9/16] w-full" />)}
            </div>
          )
        ) : shown.length ? (
          view === 'list' ? (
            <ul role="list" aria-label={t('assets.row.list')} className="space-y-2">
              {shown.map((a) => <AssetRow key={a.file} asset={a} dir={dir} onAttach={onAttach} onDelete={handleDelete} onRename={handleRename} />)}
            </ul>
          ) : (
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
              {shown.map((a) => <AssetCard key={a.file} asset={a} dir={dir} onAttach={onAttach} onDelete={handleDelete} onRename={handleRename} />)}
            </div>
          )
        ) : assets.length === 0 && !q && folder === 'all' && mediaType === 'all' ? (
          // First-run (US-ONB-03): the library is TRULY empty (no asset at all)
          // and no search/filter is narrowing it. A welcome that points to upload -
          // distinct from the no-match state below which only shows when a filter
          // hides existing assets.
          <div className="grid h-full place-items-center py-16">
            <div className="max-w-sm space-y-2 text-center">
              <Clapperboard size={26} className="mx-auto text-zinc-400" aria-hidden="true" />
              <p className="text-sm font-bold">{t('assets.firstRun.title')}</p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('assets.firstRun.body')}</p>
            </div>
          </div>
        ) : (
          <div className="grid h-full place-items-center py-16">
            <div className="max-w-xs space-y-2 text-center">
              <Clapperboard size={26} className="mx-auto text-zinc-400" aria-hidden="true" />
              <p className="text-sm font-bold">{t('assets.empty.title')}</p>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('assets.empty.hint')}</p>
              <button
                type="button"
                onClick={() => { setQ(''); setFolder('all'); setMediaType('all'); }}
                className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold text-brand transition hover:bg-brand/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light"
              >
                <X size={12} aria-hidden="true" />
                {t('assets.clearFilters')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
