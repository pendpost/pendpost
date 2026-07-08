import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Loader2, Plus, Trash2, ChevronUp, ChevronDown, CornerUpLeft, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useAssets, useActiveClient, createPost } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { prettyCampaign, fmtFull } from '../lib/format.js';
import { INNER_SURFACE, EYEBROW, PLATFORM_META } from './ui.jsx';
import { CharCounter, useLint, LintPanel, VideoPicker } from './Composer.jsx';
import ClientBand from './ClientBand.jsx';
import { DateTimePicker } from './ui/DateTimePicker.jsx';
import { Tip } from './ui/Tooltip.jsx';
import { useConfirm } from './ui/confirm.jsx';

const FIELD_CLS = `w-full rounded-xl border-0 px-3 py-2 text-sm ${INNER_SURFACE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`;
const X_LIMIT = 280;
const DEFAULT_GAP_MIN = 2; // "2 scheduler ticks of headroom" so the fail-closed reply chain can thread.

let keySeq = 0;
const newTweet = (text = '') => ({ key: `tw-${(keySeq += 1)}`, text, mediaPath: '', gapMin: DEFAULT_GAP_MIN });

// Allocate deterministic, collision-free ids for a whole thread: a `txt<N>` base
// (matching suggestPostId's text prefix) plus `-2`, `-3`, ... for the replies,
// chosen so that EVERY id in the thread is free within the campaign. Computed once
// per save run and reused on retry, so a partial failure never double-creates.
export function allocateThreadIds(campaignPosts, count) {
  const used = new Set((campaignPosts || []).map((p) => p.id));
  for (let n = 1; n < 100000; n += 1) {
    const base = `txt${n}`;
    const ids = Array.from({ length: count }, (_, i) => (i === 0 ? base : `${base}-${i + 1}`));
    if (ids.every((id) => !used.has(id))) return ids;
  }
  // Unreachable in practice; keep it total.
  const base = `txt${used.size + 1}`;
  return Array.from({ length: count }, (_, i) => (i === 0 ? base : `${base}-${i + 1}`));
}

// Absolute publish time per tweet: the opener at openerAt, each reply cumulatively
// offset by its (>=1 min) gap. Monotonic by construction, so a reply can never be
// scheduled before its parent (the engine is fail-closed on the parent's xPostId).
export function tweetTimes(openerAt, tweets) {
  if (!openerAt) return tweets.map(() => null);
  const base = new Date(openerAt).getTime();
  if (Number.isNaN(base)) return tweets.map(() => null);
  let acc = 0;
  return tweets.map((tw, i) => {
    if (i > 0) acc += Math.max(1, Math.round(Number(tw.gapMin) || 0));
    return new Date(base + acc * 60000).toISOString();
  });
}

// One editable tweet card. Owns its own live brand-lint (one useLint per row, since
// hooks cannot run in a loop in the parent) and reports the error severity up so the
// parent can warn before a linted tweet stalls the whole chain at publish.
function TweetRow({
  index, tweet, isOpener, time, assets, assetsDir, disabled,
  canMoveUp, canMoveDown, onText, onMedia, onGap, onMoveUp, onMoveDown, onRemove, onLint,
}) {
  const t = useT();
  const lint = useLint(tweet.text, 'x');
  const hasError = Boolean(lint?.findings?.some((f) => f.severity === 'error'));
  // Report the row's error state up whenever the lint result settles, so the parent
  // can warn before a linted tweet stalls the whole chain at publish.
  useEffect(() => { onLint(tweet.key, hasError); }, [onLint, tweet.key, hasError]);
  const len = tweet.text.length;
  const over = len > X_LIMIT;
  return (
    <div className={`space-y-2 rounded-2xl p-3 ${INNER_SURFACE}`}>
      <div className="flex items-center justify-between gap-2">
        <p className={`flex items-center gap-1.5 ${EYEBROW}`}>
          {isOpener ? null : <CornerUpLeft size={12} aria-hidden="true" />}
          {isOpener ? t('threadComposer.opener', { n: index + 1 }) : t('threadComposer.reply', { n: index + 1 })}
        </p>
        <div className="flex items-center gap-1">
          <Tip label={t('threadComposer.moveUp')}>
            <button type="button" onClick={onMoveUp} disabled={disabled || !canMoveUp} aria-label={t('threadComposer.moveUp')} className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-30 dark:text-zinc-400 dark:hover:bg-zinc-700/60">
              <ChevronUp size={15} aria-hidden="true" />
            </button>
          </Tip>
          <Tip label={t('threadComposer.moveDown')}>
            <button type="button" onClick={onMoveDown} disabled={disabled || !canMoveDown} aria-label={t('threadComposer.moveDown')} className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-30 dark:text-zinc-400 dark:hover:bg-zinc-700/60">
              <ChevronDown size={15} aria-hidden="true" />
            </button>
          </Tip>
          <Tip label={t('threadComposer.removeTweet')}>
            <button type="button" onClick={onRemove} disabled={disabled || isOpener} aria-label={t('threadComposer.removeTweet')} className="rounded-lg p-1.5 text-zinc-500 transition hover:bg-red-500/10 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-30 dark:text-zinc-400">
              <Trash2 size={15} aria-hidden="true" />
            </button>
          </Tip>
        </div>
      </div>

      <textarea
        value={tweet.text}
        onChange={(e) => onText(e.target.value)}
        disabled={disabled}
        rows={isOpener ? 4 : 3}
        placeholder={t('threadComposer.tweetPlaceholder')}
        className={`${FIELD_CLS} resize-y leading-relaxed`}
        aria-label={isOpener ? t('threadComposer.opener', { n: index + 1 }) : t('threadComposer.reply', { n: index + 1 })}
      />
      <div className="flex items-center justify-between gap-3">
        <VideoPicker assets={assets} assetsDir={assetsDir} value={tweet.mediaPath} onChange={onMedia} />
        <CharCounter id={`thread-count-${tweet.key}`} len={len} max={X_LIMIT} over={over} />
      </div>
      <div aria-live="polite"><LintPanel lint={lint} /></div>

      {!isOpener ? (
        <div className="flex items-center gap-2">
          <label className={EYEBROW} htmlFor={`thread-gap-${tweet.key}`}>{t('threadComposer.gapLabel')}</label>
          <input
            id={`thread-gap-${tweet.key}`}
            type="number"
            min={1}
            value={tweet.gapMin}
            onChange={(e) => onGap(e.target.value)}
            disabled={disabled}
            className={`w-16 rounded-lg border-0 px-2 py-1 text-sm tabular-nums ${INNER_SURFACE} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand`}
          />
          {time ? <span className="text-[11px] text-zinc-400 dark:text-zinc-500">{fmtFull(time)}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

// Compose a whole X thread (opener + ordered replies) as one artifact, then save it
// as N draft posts chained by xReplyTo. Single-column, X-only; a thread is NOT a new
// entity - just existing posts linked by the existing xReplyTo field.
export default function ThreadComposer({ campaigns = [], seed, onClose, onSaved }) {
  const t = useT();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const { activeClient } = useActiveClient();
  const { data: assetsData } = useAssets(true);
  const assets = useMemo(() => assetsData?.assets || [], [assetsData]);
  const assetsDir = assetsData?.dir || '';

  const [campaign, setCampaign] = useState(campaigns.find((c) => c.active)?.id || campaigns[0]?.id || '');
  const [openerAt, setOpenerAt] = useState(null);
  const [tweets, setTweets] = useState(() => [newTweet(seed?.text || '')]);
  const [error, setError] = useState(null);
  const [lintErrors, setLintErrors] = useState({});
  // A frozen save run so a partial failure retries the SAME ids/text and never
  // double-creates: { ids, items:[{id, payload}], saved:Set }.
  const runRef = useRef(null);
  const [runState, setRunState] = useState(null); // { total, saved:[ids], failed:{id,msg}|null }
  const [busy, setBusy] = useState(false);

  const campaignPosts = useMemo(() => campaigns.find((c) => c.id === campaign)?.posts || [], [campaigns, campaign]);
  const times = useMemo(() => tweetTimes(openerAt, tweets), [openerAt, tweets]);
  const anyLintError = Object.values(lintErrors).some(Boolean);
  const xMeta = PLATFORM_META.x;

  const reportLint = useCallback((key, hasError) => {
    setLintErrors((prev) => (prev[key] === hasError ? prev : { ...prev, [key]: hasError }));
  }, []);

  const patchTweet = (i, patch) => setTweets((prev) => prev.map((tw, idx) => (idx === i ? { ...tw, ...patch } : tw)));
  const move = (i, dir) => setTweets((prev) => {
    const j = i + dir;
    if (j < 0 || j >= prev.length) return prev;
    const next = prev.slice();
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });
  const removeAt = (i) => setTweets((prev) => (prev.length <= 1 ? prev : prev.filter((_, idx) => idx !== i)));
  const addTweet = () => setTweets((prev) => [...prev, newTweet('')]);

  const isDirty = tweets.length > 1 || tweets.some((tw) => tw.text.trim() || tw.mediaPath) || Boolean(openerAt);

  const requestClose = async () => {
    if (busy) return;
    if (isDirty && !runState) {
      const ok = await confirm({
        title: t('threadComposer.leaveTitle'),
        body: t('threadComposer.leaveConfirm'),
        confirmLabel: t('threadComposer.leaveDiscard'),
        danger: true,
      });
      if (!ok) return;
    }
    onClose();
  };

  // Validate the LIVE tweets before freezing a run. Returns an error string or null.
  const validate = () => {
    if (!campaign) return t('threadComposer.errorNoCampaign');
    if (!tweets.length) return t('threadComposer.emptyError');
    for (let i = 0; i < tweets.length; i += 1) {
      const tw = tweets[i];
      if (!tw.text.trim() && !tw.mediaPath) return t('threadComposer.errorEmptyTweet', { n: i + 1 });
      if (tw.text.length > X_LIMIT) return t('threadComposer.over280Error', { n: i + 1 });
      if (i > 0) {
        const gap = Math.round(Number(tw.gapMin));
        if (!Number.isFinite(gap) || gap < 1) return t('threadComposer.gapWarning', { n: i + 1 });
      }
    }
    return null;
  };

  const save = async () => {
    setError(null);
    // Build (freeze) the run once; retries reuse it and skip already-saved ids.
    if (!runRef.current) {
      const invalid = validate();
      if (invalid) { setError(invalid); return; }
      const ids = allocateThreadIds(campaignPosts, tweets.length);
      const schedule = tweetTimes(openerAt, tweets);
      const items = tweets.map((tw, i) => {
        const hasMedia = Boolean(tw.mediaPath);
        return {
          id: ids[i],
          post: {
            id: ids[i],
            type: hasMedia ? 'video' : 'text',
            platforms: ['x'],
            scheduledAt: schedule[i],
            caption: tw.text,
            path: hasMedia ? tw.mediaPath : undefined,
            xReplyTo: i > 0 ? ids[i - 1] : undefined,
          },
        };
      });
      runRef.current = { items, saved: new Set() };
    }

    const run = runRef.current;
    setBusy(true);
    setRunState({ total: run.items.length, saved: [...run.saved], failed: null });
    try {
      for (const item of run.items) {
        if (run.saved.has(item.id)) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          await createPost(campaign, item.post);
          run.saved.add(item.id);
          setRunState({ total: run.items.length, saved: [...run.saved], failed: null });
        } catch (err) {
          // Stop on first failure: never create a child of a failed parent (an
          // orphan reply that would wait for a tweet that does not exist).
          setRunState({ total: run.items.length, saved: [...run.saved], failed: { id: item.id, msg: err.message } });
          setError(t('threadComposer.partialSaved', { saved: run.saved.size, total: run.items.length }));
          return;
        }
      }
      // Full success.
      const openerId = run.items[0].id;
      runRef.current = null;
      onSaved?.(campaign, openerId);
      onClose();
    } finally {
      // One invalidate covers every exit (full success or partial): any drafts that
      // WERE created must show up in the planner immediately.
      queryClient.invalidateQueries({ queryKey: ['plans'] });
      setBusy(false);
    }
  };

  const abandonRun = () => { runRef.current = null; setRunState(null); setError(null); };

  const failed = runState?.failed;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <header className="mb-4 flex items-center gap-3">
        <Tip label={t('threadComposer.back')}>
          <button type="button" onClick={requestClose} aria-label={t('threadComposer.back')} className="rounded-xl bg-zinc-200/60 p-2 transition hover:bg-zinc-300/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:bg-zinc-800/60 dark:hover:bg-zinc-700/60">
            <ArrowLeft size={16} aria-hidden="true" />
          </button>
        </Tip>
        <div>
          <p className={EYEBROW}>{t('threadComposer.eyebrow')}</p>
          <h2 className="font-display text-lg font-bold">{t('threadComposer.title')}</h2>
        </div>
        <div className="ml-auto"><ClientBand client={activeClient} /></div>
      </header>

      <div className="space-y-4">
        {/* Thread-level controls: campaign, opener schedule, and the locked X lane. */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <label className={EYEBROW} htmlFor="thread-campaign">{t('composer.field.campaign')}</label>
            <select id="thread-campaign" value={campaign} onChange={(e) => setCampaign(e.target.value)} disabled={Boolean(runState)} className={FIELD_CLS}>
              <option value="" disabled>{t('composer.campaignPlaceholder')}</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>{prettyCampaign(c.id)}{c.active ? '' : t('composer.campaignArchivedSuffix')}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <label className={EYEBROW}>{t('threadComposer.openerSchedule')}</label>
            <DateTimePicker value={openerAt} onChange={setOpenerAt} disablePast placeholder={t('threadComposer.schedulePlaceholder')} triggerClassName={FIELD_CLS} />
          </div>
          <div className="space-y-1.5">
            <span className={EYEBROW}>{t('threadComposer.lane')}</span>
            <div className={`flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-bold ${INNER_SURFACE}`}>
              {xMeta ? <xMeta.Icon size={14} className={xMeta.color} aria-hidden="true" /> : null}
              {xMeta?.label || 'X'}
            </div>
          </div>
        </div>

        {/* The thread: stacked tweet cards with X-style connectors. */}
        <div className="space-y-0">
          {tweets.map((tw, i) => (
            <div key={tw.key}>
              {i > 0 ? <div className="mx-auto h-4 w-px bg-zinc-300 dark:bg-zinc-600" aria-hidden="true" /> : null}
              <TweetRow
                index={i}
                tweet={tw}
                isOpener={i === 0}
                time={times[i]}
                assets={assets}
                assetsDir={assetsDir}
                disabled={Boolean(runState)}
                canMoveUp={i > 0}
                canMoveDown={i < tweets.length - 1}
                onText={(v) => patchTweet(i, { text: v })}
                onMedia={(v) => patchTweet(i, { mediaPath: v })}
                onGap={(v) => patchTweet(i, { gapMin: v })}
                onMoveUp={() => move(i, -1)}
                onMoveDown={() => move(i, 1)}
                onRemove={() => removeAt(i)}
                onLint={reportLint}
              />
            </div>
          ))}
        </div>

        {!runState ? (
          <button type="button" onClick={addTweet} className="flex w-full items-center justify-center gap-1.5 rounded-2xl border border-dashed border-zinc-300 py-2.5 text-sm font-bold text-zinc-500 transition hover:border-brand hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:border-zinc-700 dark:text-zinc-400">
            <Plus size={16} aria-hidden="true" /> {t('threadComposer.addTweet')}
          </button>
        ) : null}

        {/* A brand-lint error would block that lane at publish and stall the whole
            fail-closed chain - warn (non-blocking, matching the composer's advisory lint). */}
        {anyLintError && !runState ? (
          <p className="flex items-start gap-1.5 rounded-xl bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" /> {t('threadComposer.lintErrorWarning')}
          </p>
        ) : null}

        {/* Save-run status: per-tweet saved/failed after a partial failure. */}
        {runState ? (
          <ul className="space-y-1 rounded-xl bg-zinc-500/5 p-3 text-xs">
            {runState.saved.map((id) => (
              <li key={id} className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-300">
                <CheckCircle2 size={13} aria-hidden="true" /> {t('threadComposer.tweetSaved', { id })}
              </li>
            ))}
            {failed ? (
              <li className="flex items-start gap-1.5 text-red-600 dark:text-red-300">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" /> {t('threadComposer.tweetFailed', { id: failed.id, msg: failed.msg })}
              </li>
            ) : null}
          </ul>
        ) : null}

        {error ? <p role="alert" className="rounded-xl bg-red-500/10 p-3 text-xs text-red-600 dark:text-red-300">{error}</p> : null}

        <div className="flex items-center justify-end gap-2 pt-1">
          {runState && failed ? (
            <button type="button" onClick={abandonRun} className="rounded-xl px-3.5 py-2 text-sm font-bold text-zinc-500 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:bg-zinc-700/60">
              {t('threadComposer.editAgain')}
            </button>
          ) : (
            <button type="button" onClick={requestClose} className="rounded-xl px-3.5 py-2 text-sm font-bold text-zinc-500 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:bg-zinc-700/60">
              {t('composer.cancel')}
            </button>
          )}
          <button type="button" onClick={save} disabled={busy} className="flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-bold text-white shadow-lg shadow-brand/20 transition hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-60 dark:bg-brand-light dark:text-zinc-900">
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : null}
            {busy && runState
              ? t('threadComposer.creatingProgress', { done: runState.saved.length, total: runState.total })
              : failed
                ? t('threadComposer.retry')
                : t('threadComposer.save', { count: tweets.length })}
          </button>
        </div>
      </div>
    </div>
  );
}
