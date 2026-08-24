import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ListPlus, PlusCircle, ShieldAlert, AlertCircle, CheckCircle2 } from 'lucide-react';
import { useYoutubePlaylists, createYoutubePlaylist, addToYoutubePlaylist } from '../lib/api.js';
import { INNER_SURFACE, FIELD, EYEBROW, DISABLED_PRIMARY } from './ui.jsx';
import { useT } from '../lib/i18n.js';

// YouTube "Add to playlist" picker (spec 15, Pattern P3+P4+P9). Rendered as a
// <Section> inside PostDetail's bodyLeft when the operator opens it from the ⋯
// menu on a published YouTube post (ytVideoId set). Reads the channel's playlists
// (pull-on-demand, never persisted) and lets the operator add the video to an
// existing one or create+add in one flow - both mutations reuse the SAME
// mutation -> invalidateQueries(['plans']) path as every other write, plus a
// panel refetch so a fresh playlist's itemCount updates. Every state is icon+text
// (never color-only).
const PRIVACY_OPTIONS = ['public', 'unlisted', 'private'];

export default function PlaylistPanel({ campaign, postId, enabled = true }) {
  const t = useT();
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useYoutubePlaylists(enabled);
  const [selected, setSelected] = useState('');
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [privacy, setPrivacy] = useState('private');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null); // { title, duplicate } once an add lands
  const [error, setError] = useState(null);
  // A playlist that was CREATED but whose add then failed: kept selectable so the
  // retry ADDS to it instead of minting a duplicate (a create is not idempotent).
  const [justCreated, setJustCreated] = useState(null); // { id, title } | null

  const playlists = data?.playlists || [];
  // The just-created-but-not-yet-added playlist may not be in the refetched list
  // yet - merge it in so it is immediately selectable for the retry.
  const options = justCreated && !playlists.some((p) => p.id === justCreated.id)
    ? [...playlists, justCreated]
    : playlists;

  const afterAdd = (playlistTitle, duplicate) => {
    setResult({ title: playlistTitle, duplicate });
    setJustCreated(null);
    queryClient.invalidateQueries({ queryKey: ['plans'] });
    refetch();
  };

  const onAddExisting = async () => {
    const playlist = options.find((p) => p.id === selected);
    if (!playlist) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await addToYoutubePlaylist(playlist.id, { campaign, postId });
      afterAdd(playlist.title, res.duplicate === true);
    } catch (err) {
      setError(err?.message || t('postDetail.error.generic'));
    } finally {
      setBusy(false);
    }
  };

  const onCreateAndAdd = async () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    setResult(null);
    // Two independent writes: the create is NOT idempotent, so once it succeeds the
    // playlist EXISTS even if the add then fails. On such a partial failure, do NOT
    // let a retry re-create it - refetch, keep the created playlist selected, and
    // switch to the existing-playlist add path so the retry adds to it.
    let made;
    try {
      made = await createYoutubePlaylist(trimmed, undefined, privacy);
    } catch (err) {
      setError(err?.message || t('postDetail.error.generic'));
      setBusy(false);
      return;
    }
    try {
      const res = await addToYoutubePlaylist(made.id, { campaign, postId });
      afterAdd(made.title || trimmed, res.duplicate === true);
      setTitle('');
      setCreating(false);
    } catch (err) {
      setError(err?.message || t('postDetail.error.generic'));
      setJustCreated({ id: made.id, title: made.title || trimmed });
      setSelected(made.id);
      setTitle('');
      setCreating(false);
      refetch();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-1.5" aria-label={t('postDetail.section.playlist')}>
      <h3 className={EYEBROW}>{t('postDetail.section.playlist')}</h3>

      {isLoading ? (
        <div className={`h-10 animate-pulse rounded-xl ${INNER_SURFACE}`} aria-hidden="true" />
      ) : isError || data?.ok === false || data?.error ? (
        <p role="alert" className={`flex flex-wrap items-center gap-1.5 rounded-xl px-3 py-2.5 text-xs text-red-600 dark:text-red-300 ${INNER_SURFACE}`}>
          <AlertCircle size={13} aria-hidden="true" /> {t('postDetail.playlist.error')}
          {(data?.message || data?.error) ? <span className="text-zinc-500 dark:text-zinc-400">{data.message || data.error}</span> : null}
        </p>
      ) : data?.needsScope ? (
        <div className={`space-y-1 rounded-xl px-3 py-2.5 text-xs ${INNER_SURFACE}`}>
          <p className="flex items-center gap-1.5 font-bold text-amber-700 dark:text-amber-300">
            <ShieldAlert size={13} aria-hidden="true" /> {t('postDetail.playlist.needsScope')}
          </p>
          {data.scope ? <p className="font-mono text-[11px] text-zinc-500 dark:text-zinc-400">{data.scope}</p> : null}
        </div>
      ) : (
        <div className="space-y-2">
          {options.length ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <select value={selected} onChange={(e) => setSelected(e.target.value)} aria-label={t('postDetail.playlist.pick')} className={`${FIELD} w-full flex-1`}>
                <option value="">{t('postDetail.playlist.pick')}</option>
                {options.map((p) => (
                  <option key={p.id} value={p.id}>{p.title}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={onAddExisting}
                disabled={!selected || busy}
                className={`inline-flex items-center gap-1.5 rounded-xl bg-brand px-2.5 py-1.5 text-xs font-bold text-white transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${DISABLED_PRIMARY}`}
              >
                <ListPlus size={13} aria-hidden="true" /> {t('postDetail.playlist.add')}
              </button>
            </div>
          ) : (
            <p className={`flex items-center gap-1.5 rounded-xl px-3 py-2.5 text-xs text-zinc-500 dark:text-zinc-400 ${INNER_SURFACE}`}>
              <ListPlus size={13} aria-hidden="true" /> {t('postDetail.playlist.empty')}
            </p>
          )}

          {creating ? (
            <div className={`space-y-1.5 rounded-xl p-2.5 ${INNER_SURFACE}`}>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                aria-label={t('postDetail.playlist.title')}
                placeholder={t('postDetail.playlist.title')}
                className={`${FIELD} w-full`}
              />
              <select value={privacy} onChange={(e) => setPrivacy(e.target.value)} aria-label={t('postDetail.playlist.privacy')} className={`${FIELD} w-full`}>
                {PRIVACY_OPTIONS.map((p) => (
                  <option key={p} value={p}>{t(`postDetail.playlist.privacy.${p}`)}</option>
                ))}
              </select>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={onCreateAndAdd}
                  disabled={busy || !title.trim()}
                  className={`inline-flex items-center gap-1.5 rounded-xl bg-brand px-2.5 py-1.5 text-xs font-bold text-white transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${DISABLED_PRIMARY}`}
                >
                  <ListPlus size={13} aria-hidden="true" /> {t('postDetail.playlist.create')}
                </button>
                <button
                  type="button"
                  onClick={() => { setCreating(false); setTitle(''); }}
                  className="rounded-xl px-2.5 py-1.5 text-xs font-bold text-zinc-500 transition hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-100"
                >
                  {t('postDetail.comments.cancel')}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1.5 text-xs font-bold text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-brand-light"
            >
              <PlusCircle size={12} aria-hidden="true" /> {t('postDetail.playlist.new')}
            </button>
          )}

          {result ? (
            <p className={`flex items-center gap-1.5 text-[11px] ${result.duplicate ? 'text-amber-700 dark:text-amber-300' : 'text-emerald-600 dark:text-emerald-300'}`}>
              <CheckCircle2 size={12} aria-hidden="true" />
              {result.duplicate ? t('postDetail.playlist.duplicate', { title: result.title }) : t('postDetail.playlist.added', { title: result.title })}
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="flex items-center gap-1.5 text-[11px] text-red-600 dark:text-red-300">
              <AlertCircle size={11} aria-hidden="true" /> {error}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
