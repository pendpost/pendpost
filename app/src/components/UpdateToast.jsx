import { useEffect, useRef, useState } from 'react';
import { Loader2, RefreshCw, Download, AlertTriangle, X, Check, Info } from 'lucide-react';
import { useUpdateStatus } from '../lib/api.js';
import { useT } from '../lib/i18n.js';
import { TAP_TARGET } from './ui/recipes.js';
import { Tip } from './ui/Tooltip.jsx';
import { studioFetch } from '../lib/studioToken.js';
import { useWhatsNew, useMarkWhatsNewSeen } from '../lib/whatsNew.js';
import WhatsNewDialog from './WhatsNew.jsx';

// Kick off the server-side update (lib/self-update.mjs): pull if upstream is
// ahead, rebuild, then restart once publishing and agents are idle. Resolves to
// the response body, or null when the request never got an answer.
export async function postDashboardUpdate() {
  try {
    const res = await studioFetch('/api/dashboard-update', { method: 'POST' });
    const body = await res.json().catch(() => null);
    // A refusal (403 origin, 409 read-only, 400 diverged) is a failure even when its
    // body has no `ok` field; read as success it left the toast on "Starting" for good.
    return res.ok ? body : { ...(body || {}), ok: false };
  } catch { return null; }
}

// Remembered in this browser, so a reload or the next app open keeps them:
//   dismissed -> the commit whose offer the owner hid (a newer commit shows again)
//   pending   -> an update this browser started: the server pid then and the target
//   done      -> the version just installed, shown once after the automatic reload
const DISMISSED_KEY = 'pendpost.update.dismissed';
const PENDING_KEY = 'pendpost.update.pending';
const DONE_KEY = 'pendpost.update.done';
const DONE_MS = 4000;
// The apply may run 10 min plus the idle wait; an older pending marker is a leftover.
const PENDING_MAX_MS = 30 * 60_000;
// launchd relaunches within its 30 s throttle; gone for longer means it did not come back.
const RESTART_GIVE_UP_MS = 3 * 60_000;
const IN_PROGRESS = new Set(['downloading', 'installing', 'waiting', 'restarting', 'applying']);
const STEPS = ['downloading', 'installing', 'restarting'];
// A retry shows its spinner at least this long, so the click is seen even when the
// answer is instant.
const RETRY_MIN_MS = 600;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const clockTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function readStored(key) {
  try { const raw = window.localStorage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
function writeStored(key, value) {
  try {
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch { /* storage blocked: the toast still works for this page load */ }
}
const fresh = (v, maxMs) => (v && Number.isFinite(v.at) && Date.now() - v.at < maxMs ? v : null);
// The owner is typing: never reload the page under them.
function isEditing() {
  const el = typeof document === 'undefined' ? null : document.activeElement;
  return Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)));
}

// "2.9.0": the package version alone. The commit means nothing to an operator; it stays
// reachable as the title of the version line in Help and feedback.
export function formatVersion(v) {
  return v?.version || null;
}

// The update flow shares one small toast, bottom-right, like a desktop app's
// updater. It polls GET /api/dashboard-update and shows exactly one of:
//   available -> "pendpost 2.11.0 is ready" (or "Small improvements ready" when only the
//                commit moved), Update + dismiss
//   progress  -> the real step the server reports: downloading, installing, waiting
//                for publishing or an agent, restarting (polled every 1.5 s)
//   done      -> "Updated to 2.10.0" for a few seconds once the server is
//                back on the new code (after an automatic reload when the bundle changed)
//   failed    -> what went wrong in one sentence, the log tail behind an info icon,
//                Try again (+ dismiss); a retry that fails again says so with the time
//   (open edits in the checkout are not a failure: the server waits for them and the
//    progress line says so, with the files behind an info icon)
//   manual    -> the server cannot restart itself (not under launchd): say so
//   ready     -> a new bundle landed outside an update (a boot rebuild) + Reload
//   news      -> pendpost runs a version whose release notes this install has not
//                seen (GET /api/whats-new): "Updated to 2.10.0" + What's new, which
//                opens the notes; closing them or the toast remembers the version.
//                It takes the place of "done" when there are notes, and waits behind
//                every other state.
// A quiet offer (`update.quiet`: only local commits moved, same version) applies on
// the server by itself, so none of the above shows for it. Once the server is back
// on newer code, a new bundle reloads the page by itself and the reloaded page says
// "Updated to"; while the owner types it falls back to the Reload offer.
export default function UpdateToast({ onReload = () => window.location.reload(), onUpdate = postDashboardUpdate }) {
  const t = useT();
  const [pending, setPendingState] = useState(() => fresh(readStored(PENDING_KEY), PENDING_MAX_MS));
  const [dismissed, setDismissedState] = useState(() => readStored(DISMISSED_KEY));
  const [done, setDone] = useState(() => fresh(readStored(DONE_KEY), 2 * 60_000));
  const [posting, setPosting] = useState(false);
  const [localError, setLocalError] = useState(null); // 'request'
  const [localDetail, setLocalDetail] = useState(null); // the server's own words for a refused request
  const [retriedAt, setRetriedAt] = useState(null); // when the owner last clicked Try again
  const [lostTooLong, setLostTooLong] = useState(false);
  const serverBusy = useRef(false);
  const news = useWhatsNew()?.data || null;
  const markSeen = useMarkWhatsNewSeen();
  const [newsOpen, setNewsOpen] = useState(null); // the entries the open dialog shows
  // The version whose notes this page already closed: stays hidden even if a poll
  // lands before the server has written the marker.
  const [newsDone, setNewsDone] = useState(null);

  const query = useUpdateStatus(Boolean(pending) || serverBusy.current) || {};
  const data = query.data || null;
  const unreachable = Boolean(query.isError);
  const update = data?.update || null;
  const state = update?.state === 'applying' ? 'installing' : (update?.state || null);
  serverBusy.current = IN_PROGRESS.has(state);
  const running = update?.running || null;
  const target = update?.target || null;

  const setPending = (p) => { writeStored(PENDING_KEY, p); setPendingState(p); };
  const setDismissed = (id) => { writeStored(DISMISSED_KEY, id); setDismissedState(id); };

  // Baseline = the FIRST buildId this tab saw (the bundle it is running).
  const loaded = useRef(null);
  if (loaded.current == null && data?.buildId) loaded.current = data.buildId;
  const bundleChanged = Boolean(loaded.current && data?.buildId && data.buildId !== loaded.current);

  // The quiet local update: hidden while it is on offer and while it runs.
  const quiet = Boolean(update?.quiet) && !pending;
  // The commit the server ran while a quiet update was on offer. The server running
  // anything else later means the quiet update finished (even if this tab slept
  // through its progress).
  const quietFrom = useRef(null);
  const quietDone = Boolean(!pending && quietFrom.current && running?.commit
    && running.commit !== quietFrom.current && !IN_PROGRESS.has(state));
  if (!quietDone && update?.quiet && running?.commit) quietFrom.current = running.commit;
  const quietReload = quietDone && bundleChanged && !isEditing();
  useEffect(() => {
    if (!quietDone) return;
    quietFrom.current = update?.quiet ? running.commit : null;
    if (quietReload) {
      writeStored(DONE_KEY, { ...(running || {}), at: Date.now() });
      onReload();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quietDone]);

  // The "Updated to" note shows once, briefly.
  useEffect(() => {
    if (!done) return undefined;
    writeStored(DONE_KEY, null);
    const id = setTimeout(() => setDone(null), DONE_MS);
    return () => clearTimeout(id);
  }, [done]);

  // The server this browser asked to update is back as a new process: the update
  // is finished. A new bundle needs a reload (the note then shows after it).
  const restarted = Boolean(pending && data?.pid && pending.fromPid && data.pid !== pending.fromPid);
  useEffect(() => {
    if (!restarted || IN_PROGRESS.has(state)) return;
    const now = { ...(running || {}), at: Date.now() };
    setPending(null);
    setLostTooLong(false);
    if (bundleChanged) {
      writeStored(DONE_KEY, now);
      onReload();
      return;
    }
    setDone(now);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restarted, state]);

  // A restart that never comes back is a failure, not an endless spinner.
  useEffect(() => {
    if (!pending || !unreachable) { setLostTooLong(false); return undefined; }
    const id = setTimeout(() => setLostTooLong(true), RESTART_GIVE_UP_MS);
    return () => clearTimeout(id);
  }, [pending, unreachable]);

  // A failure the server reports for what is on offer now (survives a reload), but
  // never one older than a click this browser just made.
  const lastRun = update?.lastRun;
  // A quiet run the owner never started never shows as a failure.
  const runFailed = lastRun?.ok === false && !lastRun.quiet && !state
    && !(pending && Date.parse(lastRun.at) < pending.at)
    && ((lastRun.target && lastRun.target === target?.commit) || (pending && Date.parse(lastRun.at) >= pending.at))
    ? lastRun : null;
  // A failed run ends the update this browser started.
  useEffect(() => {
    if (runFailed && pending) setPending(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runFailed, pending]);

  const triggerUpdate = async (retry = false) => {
    setLocalError(null);
    setLostTooLong(false);
    setRetriedAt(retry ? Date.now() : null);
    setPending({ fromPid: data?.pid ?? null, target: target?.commit || null, at: Date.now() });
    setPosting(true);
    let body = null;
    try { [body] = await Promise.all([onUpdate(), retry ? sleep(RETRY_MIN_MS) : null]); } catch { body = null; }
    setPosting(false);
    if (!body || body.ok === false) {
      setPending(null);
      setLocalError('request');
      setLocalDetail(body?.message || null);
      return;
    }
    // The server had nothing to do (already up to date): the fresh status says so.
    if (body.started === false && !body.state) setPending(null);
    query.refetch?.();
  };

  const offerId = update?.id || null;
  const dismiss = () => {
    const id = target?.commit || offerId;
    if (id) setDismissed(id);
    setPending(null);
    setLocalError(null);
    setLostTooLong(false);
    setRetriedAt(null);
  };

  const failureKey = localError === 'request' ? 'update.failed.request'
    : lostTooLong ? 'update.failed.restart'
      : runFailed ? (runFailed.step === 'pull' ? 'update.failed.pull' : 'update.failed.build')
        : null;
  const failureHidden = Boolean(runFailed && !localError && !lostTooLong && dismissed && dismissed === (target?.commit || offerId));
  const failed = Boolean(failureKey) && !failureHidden;
  // Why it failed, from the server's log tail (pull and build failures).
  const failureDetail = localError ? localDetail : !lostTooLong ? (runFailed?.detail || null) : null;
  // The owner pressed Try again and it failed again: say so, with the time.
  const failedAgainAt = retriedAt && failed && !posting
    ? (runFailed && !localError ? Math.max(Date.parse(runFailed.at) || 0, retriedAt) : retriedAt)
    : null;
  const manual = state === 'manual';
  const step = posting && !IN_PROGRESS.has(state) ? 'starting'
    : IN_PROGRESS.has(state) ? state
      : pending && unreachable ? 'restarting'
        : pending ? 'starting'
          : null;
  const updateReady = !pending && !step && bundleChanged && !quietReload;
  const runsTarget = Boolean(target?.commit && running?.commit && target.commit === running.commit);
  const offer = Boolean(update?.available && update?.canApply && !runsTarget && offerId && offerId !== dismissed);

  const hasNews = Boolean(news?.unseen?.length) && newsDone !== news.version;
  const seeNews = () => { setNewsDone(news?.version); markSeen(news?.version); };
  const closeNews = () => { setNewsOpen(null); seeNews(); };
  const newsDialog = newsOpen ? <WhatsNewDialog entries={newsOpen} releasesUrl={news?.releasesUrl} onClose={closeNews} /> : null;

  let phase = null;
  if (done && !hasNews) phase = 'done';
  else if (failed) phase = 'failed';
  else if (manual) phase = 'manual';
  else if (step && !quiet) phase = 'progress';
  else if (data?.building && !quiet) phase = 'preparing';
  else if (updateReady) phase = 'ready';
  else if (offer && !quiet) phase = 'offer';
  else if (hasNews && !newsOpen) phase = 'news';
  if (!phase) return newsDialog;

  const stepText = step === 'starting' ? t('update.step.starting')
    : step === 'downloading' ? t('update.step.downloading')
      : step === 'installing' ? t('update.step.installing')
        : step === 'waiting' ? t(update?.waitingFor === 'edits' ? 'update.waitingEdits' : update?.waitingFor === 'publishing' ? 'update.waitingPublish' : update?.waitingFor === 'agent' ? 'update.waitingAgent' : 'update.restarting')
          : t('update.restarting');
  const editsFiles = step === 'waiting' && update?.waitingFor === 'edits' && update?.dirtyFiles?.length
    ? t('update.waitingEditsFiles', { files: update.dirtyFiles.join(', ') }) : null;
  const stepIndex = (step === 'waiting' && update?.waitingFor === 'edits') ? 0 : step === 'installing' ? 1 : (step === 'waiting' || step === 'restarting') ? 2 : 0;
  const targetText = formatVersion(target);
  const doneText = formatVersion(done);
  // The offer in one line: the new version, or "small improvements" when the version is the
  // same and only the commit moved (the develop channel).
  const offerText = !targetText ? t('update.available')
    : targetText === formatVersion(running) ? t('update.patch')
      : t('update.offer', { version: targetText });

  // One text style for every state, so the toast reads as one control.
  const TEXT = 'min-w-0 flex-1 text-xs font-semibold';
  const primary = `shrink-0 rounded-lg bg-brand px-2.5 py-1 text-xs font-bold text-white transition hover:bg-brand/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1 dark:bg-brand-light dark:text-zinc-900 ${TAP_TARGET}`;
  const closeWith = (onClick) => (
    <button
      type="button"
      onClick={onClick}
      aria-label={t('update.dismiss')}
      className={`shrink-0 rounded-lg p-0.5 text-zinc-500 transition hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-100 ${TAP_TARGET}`}
    >
      <X size={14} aria-hidden="true" />
    </button>
  );
  const close = closeWith(dismiss);
  // The why, one hover or focus away: an info glyph with a real tooltip.
  const infoTip = (label) => (
    <Tip label={label}>
      <button
        type="button"
        aria-label={t('update.details')}
        className={`shrink-0 rounded-lg p-0.5 text-zinc-500 transition hover:text-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-400 dark:hover:text-zinc-100 ${TAP_TARGET}`}
      >
        <Info size={14} aria-hidden="true" />
      </button>
    </Tip>
  );

  return (
    <>
      <div
        role="status"
        aria-live={phase === 'failed' ? 'assertive' : 'polite'}
        className="glass-panel fixed bottom-4 right-4 z-50 flex max-w-sm items-center gap-2.5 rounded-2xl px-3.5 py-2.5 shadow-lg"
      >
        {phase === 'news' ? (
          <>
            <Check size={15} className="shrink-0 text-brand dark:text-brand-light" aria-hidden="true" />
            <span className={TEXT}>{t('update.done', { version: news.version })}</span>
            <button type="button" onClick={() => setNewsOpen(news.unseen)} className={primary}>{t('whatsNew.open')}</button>
            {closeWith(seeNews)}
          </>
        ) : phase === 'done' ? (
          <>
            <Check size={15} className="shrink-0 text-brand dark:text-brand-light" aria-hidden="true" />
            <span className={TEXT}>{doneText ? t('update.done', { version: doneText }) : t('update.doneNoVersion')}</span>
          </>
        ) : phase === 'failed' ? (
          <>
            {/* Text first, its one recovery action under it: a long (German) sentence
                never squeezes into a column beside the button. */}
            <AlertTriangle size={15} className="mt-0.5 shrink-0 self-start text-red-600 dark:text-red-300" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold">
                {t(failureKey)}
                {failedAgainAt ? <span className="block font-normal">{t('update.failedAgain', { time: clockTime(failedAgainAt) })}</span> : null}
              </p>
              <button type="button" onClick={() => triggerUpdate(true)} className={`mt-2 ${primary}`}>{t('update.retry')}</button>
            </div>
            {failureDetail ? <span className="self-start">{infoTip(<span className="block max-w-xs whitespace-pre-wrap font-mono text-[11px]">{failureDetail}</span>)}</span> : null}
            <span className="self-start">{close}</span>
          </>
        ) : phase === 'manual' ? (
          <>
            <RefreshCw size={15} className="shrink-0 text-brand dark:text-brand-light" aria-hidden="true" />
            <span className={TEXT}>{t('update.manual')}</span>
          </>
        ) : phase === 'progress' ? (
          <>
            <Loader2 size={15} className="shrink-0 animate-spin text-brand motion-reduce:animate-none dark:text-brand-light" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold">{stepText}</p>
              {/* Where the update stands: download, install, restart. Decorative; the
                  sentence above is what screen readers hear. */}
              {/* Waiting for open edits is not a step of the update, so no bar. */}
              {update?.waitingFor === 'edits' && step === 'waiting' ? null : (
              <div className="mt-1.5 flex gap-1" aria-hidden="true" data-testid="update-steps">
                {STEPS.map((s, i) => (
                  <span
                    key={s}
                    data-state={i < stepIndex ? 'done' : i === stepIndex ? 'current' : 'todo'}
                    className={`h-1 flex-1 rounded-full ${i < stepIndex ? 'bg-brand dark:bg-brand-light' : i === stepIndex ? 'bg-brand/50 motion-safe:animate-pulse dark:bg-brand-light/60' : 'bg-zinc-200 dark:bg-zinc-700'}`}
                  />
                ))}
              </div>
              )}
            </div>
            {editsFiles ? <span className="self-start">{infoTip(editsFiles)}</span> : null}
          </>
        ) : phase === 'preparing' ? (
          <>
            <Loader2 size={15} className="shrink-0 animate-spin text-brand motion-reduce:animate-none dark:text-brand-light" aria-hidden="true" />
            <span className={TEXT}>{t('update.preparing')}</span>
          </>
        ) : phase === 'ready' ? (
          <>
            <RefreshCw size={15} className="shrink-0 text-brand dark:text-brand-light" aria-hidden="true" />
            <span className={TEXT}>{t('update.ready')}</span>
            <button type="button" onClick={onReload} className={primary}>{t('update.reload')}</button>
          </>
        ) : (
          <>
            <Download size={15} className="shrink-0 text-brand dark:text-brand-light" aria-hidden="true" />
            <span className={TEXT}>{offerText}</span>
            <button type="button" onClick={() => triggerUpdate(false)} className={primary}>{t('update.get')}</button>
            {close}
          </>
        )}
      </div>
      {newsDialog}
    </>
  );
}
