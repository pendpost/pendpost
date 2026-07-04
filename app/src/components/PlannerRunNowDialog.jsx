// The planner run-now review gate. The header "Fällige jetzt ausführen" button
// opens THIS dialog instead of publishing every due post on one click: it lists
// exactly the posts the scheduler would fire right now (isDueNow), pre-selects
// them all, and lets the owner deselect the ones to hold back before running.
//
// The dialog IS the confirmation (the owner reviewed and picked the exact posts,
// then clicked a clearly-labelled red run button) - no second generic confirm.
// It runs the selection by looping the EXISTING per-post publish scope
// (runPublishDue({campaign, postId})) sequentially, mirroring Freigaben's
// runBulk: tally ok/fail, deselect only the succeeded, surface a summary on
// partial failure. The server re-reads state per call, so the anti-ban guards
// (cadence cap, min-gap, Meta-368 breaker, brand-lint) still apply - a deferred
// post simply stays due and reappears in the list. needs_confirm escalates to a
// second in-app confirm (server fallback); in_flight (423) stops with NO retry.
//
// Anti-slop: single accent tone, font-bold max, no all-caps prose; the run
// button leads with an icon + text. Built on the shared Modal chrome — a
// centered popup portaled to <body> (role=dialog, focus trap, Escape, backdrop)
// so it inherits the a11y contract and can't be clipped by the glass header.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Rocket, Inbox } from 'lucide-react';
import { runPublishDue } from '../lib/api.js';
import { fmtFull, campaignBaseLabel, isDueNow, isYouTubeReleaseDue } from '../lib/format.js';
import { useT } from '../lib/i18n.js';
import { useConfirm } from './ui/confirm.jsx';
import { Modal, CloseButton, CoverThumb, StatusPill, PlatformIcons, INNER_SURFACE } from './ui.jsx';
import ActionButton from './ui/ActionButton.jsx';

const firstLine = (s) => (s || '').split('\n').find((l) => l.trim()) || '';
const keyOf = (post) => `${post.campaign}-${post.id}`;

// Header "Alle auswählen" / "Auswahl aufheben" toggle, with a cosmetic
// indeterminate state when only some rows are checked (mirrors Freigaben's
// SelectAllControl - that one is not exported, so this is the local twin).
function SelectAllControl({ total, selectedCount, onToggle }) {
  const t = useT();
  const ref = useRef(null);
  const allSelected = total > 0 && selectedCount === total;
  const someSelected = selectedCount > 0 && selectedCount < total;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = someSelected;
  }, [someSelected]);
  if (total === 0) return null;
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-[11px] font-bold text-zinc-500 dark:text-zinc-400">
      <input
        ref={ref}
        type="checkbox"
        checked={allSelected}
        onChange={onToggle}
        aria-label={allSelected ? t('planner.runDialog.clearAll') : t('planner.runDialog.selectAll')}
        className="h-4 w-4 cursor-pointer rounded border-zinc-300 text-brand accent-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:border-zinc-600"
      />
      {allSelected ? t('planner.runDialog.clearAll') : t('planner.runDialog.selectAll')}
    </label>
  );
}

// One due-post row: a selection checkbox SIBLING to the cover + headline + meta
// block (no interactive nesting). Status reads as a quiet overdue pill.
function DueRow({ post, selected, onToggle }) {
  const t = useT();
  const headline = (post.title && post.title.trim()) || firstLine(post.caption) || t('approvals.card.untitled');
  // A release row is a YouTube video already on YouTube but left private past its
  // publishAt: run-now will make it public, not publish. Its derivedState pill reads
  // "Ungeprüft", so a quiet brand hint makes the actual action legible.
  const release = isYouTubeReleaseDue(post);
  return (
    <li className={`flex gap-3 rounded-xl p-3 ${INNER_SURFACE}`}>
      <span className="flex shrink-0 items-start pt-1">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggle(post)}
          aria-label={t('planner.runDialog.selectPost', { headline })}
          className="h-4 w-4 cursor-pointer rounded border-zinc-300 text-brand accent-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:border-zinc-600"
        />
      </span>
      <CoverThumb media={post.media} image={post.image} className="h-16 w-12 shrink-0 rounded-lg" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-start justify-between gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-bold">{headline}</span>
          <span className="flex shrink-0 items-center gap-1.5">
            {release ? (
              <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-bold text-brand">
                {t('planner.runDialog.releaseHint')}
              </span>
            ) : null}
            <StatusPill state={post.derivedState} short />
          </span>
        </div>
        <span className="block text-xs font-bold text-zinc-600 dark:text-zinc-300">
          {t('planner.runDialog.scheduledFor', { when: fmtFull(post.scheduledAt) })}
        </span>
        <div className="flex items-center gap-1.5">
          <PlatformIcons platforms={post.platforms} />
          <span className="truncate text-[11px] text-zinc-400 dark:text-zinc-500">{campaignBaseLabel(post.campaign)}</span>
        </div>
      </div>
    </li>
  );
}

export default function PlannerRunNowDialog({ campaigns, clientName = '', onClose, onDone }) {
  const t = useT();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const [bulkError, setBulkError] = useState(null);

  // The due posts, soonest-first. Sourced from the full client plan (campaigns),
  // not pendpost_health.nextDue (clamped to <=20, missing derivedState/approval).
  const dueItems = useMemo(
    () =>
      campaigns
        .flatMap((c) => c.posts || [])
        .filter(isDueNow)
        .sort((a, b) => Date.parse(a.scheduledAt || '9999') - Date.parse(b.scheduledAt || '9999')),
    [campaigns],
  );

  // Seed selection to ALL due posts on open (owner deselects to hold back).
  // Seeded once; later campaign refreshes are intersected via effectiveSelection
  // so a stale key never runs and a deselected post never re-checks itself.
  const [selected, setSelected] = useState(() => new Set(dueItems.map(keyOf)));
  const effectiveSelection = useMemo(() => dueItems.filter((p) => selected.has(keyOf(p))), [dueItems, selected]);
  const selCount = effectiveSelection.length;

  const toggleSelect = (post) => {
    const k = keyOf(post);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };
  const allSelected = dueItems.length > 0 && selCount === dueItems.length;
  const onToggleSelectAll = () => setSelected(allSelected ? new Set() : new Set(dueItems.map(keyOf)));

  // Publish one post, with the server's needs_confirm fallback: confirm:true is
  // already posted (api.js), but if the server still escalates, re-prompt once
  // and retry. Declining throws the user-cancel sentinel.
  const runOne = async (p) => {
    const scope = { campaign: p.campaign, postId: p.id };
    try {
      await runPublishDue(scope);
    } catch (err) {
      if (err?.code === 'needs_confirm') {
        const ok = await confirm({
          title: t('planner.runNow.needsConfirm.title'),
          body: err.message || t('planner.runNow.needsConfirm.body'),
          confirmLabel: t('planner.runNow.needsConfirm.label'),
          danger: true,
        });
        if (!ok) throw { canceled: true };
        await runPublishDue(scope);
      } else {
        throw err;
      }
    }
  };

  // Refresh the live plan/activity and drop the succeeded keys from the selection.
  const refresh = (doneKeys) => {
    queryClient.invalidateQueries({ queryKey: ['activity'] });
    queryClient.invalidateQueries({ queryKey: ['plans'] });
    if (doneKeys.length) {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const k of doneKeys) next.delete(k);
        return next;
      });
    }
  };

  // Bulk runner (Freigaben.runBulk shape): loop the effective selection over the
  // single-post publish, tally ok/fail, refresh, then either close on full
  // success or THROW a summary so the ActionButton flashes error and bulkError
  // shows which posts failed. Only succeeded posts are deselected; failures stay
  // selected and retryable. in_flight (423) stops the loop with no auto-retry.
  const onRun = async () => {
    setBulkError(null);
    const sel = effectiveSelection;
    let ok = 0;
    const fails = [];
    const done = [];
    let inFlightHit = false;
    for (const p of sel) {
      try {
        await runOne(p);
        ok += 1;
        done.push(keyOf(p));
      } catch (e) {
        if (e?.canceled === true) {
          refresh(done);
          throw e; // user declined the server re-confirm: abort silently
        }
        if (e?.code === 'in_flight') {
          inFlightHit = true;
          break;
        }
        fails.push({ id: p.id, msg: e?.message || 'Error' });
      }
    }
    refresh(done);
    if (inFlightHit) throw new Error(t('planner.runNow.inFlight'));
    if (fails.length) {
      throw new Error(t('planner.runDialog.summary', { ok, failed: fails.length, ids: fails.map((f) => f.id).join(', ') }));
    }
    onDone?.();
  };

  return (
    <Modal onClose={onClose} label={t('planner.runDialog.title')} width="max-w-lg">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-bold leading-tight">{t('planner.runDialog.title')}</h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">
            {clientName
              ? t('planner.runDialog.subtitle', { client: clientName, count: dueItems.length })
              : t('planner.runDialog.subtitleNoClient', { count: dueItems.length })}
          </p>
        </div>
        <CloseButton onClose={onClose} label={t('ui.action.close')} />
      </div>

      {dueItems.length ? (
        <>
          <div className="flex items-center justify-between gap-3">
            <SelectAllControl total={dueItems.length} selectedCount={selCount} onToggle={onToggleSelectAll} />
            <span role="status" aria-live="polite" className="text-[11px] font-bold text-zinc-500 dark:text-zinc-400">
              {t('planner.runDialog.selectedCount', { n: selCount })}
            </span>
          </div>
          <ul role="list" className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-0.5">
            {dueItems.map((post) => (
              <DueRow key={keyOf(post)} post={post} selected={selected.has(keyOf(post))} onToggle={toggleSelect} />
            ))}
          </ul>
        </>
      ) : (
        <div className="grid flex-1 place-items-center py-16">
          <div className="max-w-xs space-y-2 text-center">
            <Inbox size={26} className="mx-auto text-zinc-400" aria-hidden="true" />
            <p className="text-sm font-bold">{t('planner.runDialog.empty.title')}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">{t('planner.runDialog.empty.body')}</p>
          </div>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-zinc-900/5 pt-4 dark:border-white/10">
        {bulkError ? (
          <p role="alert" className="mr-auto basis-full text-[11px] text-red-600 dark:text-red-300 sm:basis-auto">{bulkError}</p>
        ) : null}
        <button
          type="button"
          onClick={onClose}
          className="rounded-xl px-3 py-1.5 text-sm font-bold text-zinc-600 transition hover:bg-zinc-200/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand dark:text-zinc-300 dark:hover:bg-zinc-700/60"
        >
          {t('planner.runDialog.cancel')}
        </button>
        <ActionButton
          variant="danger"
          size="md"
          icon={Rocket}
          disabled={selCount === 0}
          ariaLabel={t('planner.runDialog.run', { n: selCount })}
          labels={{
            idle: t('planner.runDialog.run', { n: selCount }),
            loading: t('planner.runNow.loading'),
            success: t('planner.runNow.success'),
            error: t('planner.runNow.error'),
          }}
          onError={setBulkError}
          onAction={onRun}
        />
      </div>
    </Modal>
  );
}
