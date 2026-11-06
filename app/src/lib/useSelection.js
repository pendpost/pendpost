// useSelection - the ONE multi-select + bulk-run pattern (planner bulk, 2026-11-01, package P).
//
// Lifted out of Approvals (Freigaben.jsx), where it was born, so the planner List selects and
// runs bulk actions the same way: one design language, one set of rules.
//
//   - `selected` is a Set of post keys. It is NEVER trusted on its own: a filter, a tab or a
//     collapsed day can hide a once-selected post, so every count and every bulk loop reads
//     `effectiveSelection` = the selectable VISIBLE posts that are in the Set (intersect-visible).
//   - shift-click selects a range in the visible order, from the last toggled post (the anchor).
//   - an X thread is one unit where `chain` is on (the List): selecting one tweet selects the
//     whole chain, because approving or moving one tweet of a thread is never what was meant.
//     Approvals keeps its explicit "part of a thread" button (selectThread) instead.
//   - runBulk loops the selection one post at a time, shows {done}/{total} progress, refreshes
//     the plans, deselects only the posts that went through (failures stay selected for a retry,
//     and the bar with its summary stays in view), and throws ONE plain summary when any failed
//     (its reasons, never the post ids).
//
// Pure helpers are exported so the rules are tested without React.
import { useCallback, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { collectThread } from './format.js';
import { humanizeAction, plainError } from './failureCopy.js';
import { useT } from './i18n.js';

// A post's identity across projects: in All-projects mode two projects can share a campaign id
// and a post id, so the project rides along when the merge stamped one.
export function selectionKey(post) {
  return `${post?.clientId ? `${post.clientId}/` : ''}${post?.campaign}-${post?.id}`;
}

// The keys from the anchor to the target, inclusive, in the visible order (either direction).
// An anchor that is no longer visible selects just the target.
export function rangeKeys(orderedKeys, anchorKey, targetKey) {
  const a = orderedKeys.indexOf(anchorKey);
  const b = orderedKeys.indexOf(targetKey);
  if (a === -1 || b === -1) return b === -1 ? [] : [targetKey];
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return orderedKeys.slice(lo, hi + 1);
}

// The visible, selectable posts that are selected, in the visible order.
export function intersectVisible(selectable, selected, keyOf = selectionKey) {
  return (selectable || []).filter((p) => selected.has(keyOf(p)));
}

// Every key of the X thread `post` belongs to (just its own key when it stands alone).
export function threadKeys(post, pool, keyOf = selectionKey) {
  return collectThread(post, pool || []).map(keyOf);
}

// Returned by a bulk action for a post it deliberately left alone (a declined confirm, a post
// the action does not apply to). Counted and named apart from a failure; the post stays selected.
export const SKIP = Symbol('bulk-skip');

const always = () => true;

export function useSelection({ items = [], isSelectable = always, keyOf = selectionKey, threadPool = null, chain = false, nameOf = (p) => p.id } = {}) {
  const t = useT();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState(() => new Set());
  // Live per-item progress for a bulk run ({done,total}), or null when idle. Drives the
  // "{done}/{total}" count in the running button's label so a slow batch reads as motion.
  const [bulkProgress, setBulkProgress] = useState(null);
  const [bulkError, setBulkError] = useState(null);
  const anchorRef = useRef(null);

  const selectable = useMemo(() => items.filter(isSelectable), [items, isSelectable]);
  const effectiveSelection = useMemo(() => intersectVisible(selectable, selected, keyOf), [selectable, selected, keyOf]);
  const count = effectiveSelection.length;
  const pool = threadPool || items;
  // The keys one toggle moves: the whole chain where threads are one unit, else the post alone.
  const unitKeys = useCallback(
    (post) => (chain ? threadKeys(post, pool, keyOf) : [keyOf(post)]),
    [chain, pool, keyOf],
  );

  const isSelected = useCallback((post) => selected.has(keyOf(post)), [selected, keyOf]);

  const toggle = useCallback((post, { range = false } = {}) => {
    const k = keyOf(post);
    const anchor = anchorRef.current;
    if (range && anchor && anchor !== k) {
      // Shift-click: everything between the anchor and here joins the selection.
      const orderedKeys = selectable.map(keyOf);
      const inRange = new Set(rangeKeys(orderedKeys, anchor, k));
      const posts = selectable.filter((p) => inRange.has(keyOf(p)));
      setSelected((prev) => new Set([...prev, ...posts.flatMap(unitKeys)]));
    } else {
      const keys = unitKeys(post);
      setSelected((prev) => {
        const next = new Set(prev);
        const on = !prev.has(k);
        for (const x of keys) { if (on) next.add(x); else next.delete(x); }
        return next;
      });
    }
    anchorRef.current = k;
  }, [keyOf, selectable, unitKeys]);

  // Approvals' "part of a thread" button: seed the selection with every tweet in the chain.
  const selectThread = useCallback((post) => {
    const keys = threadKeys(post, pool, keyOf);
    setSelected((prev) => new Set([...prev, ...keys]));
  }, [pool, keyOf]);

  // A group (a day heading): select every selectable post in it, or clear them all when every
  // one already is.
  const toggleGroup = useCallback((posts) => {
    const group = (posts || []).filter(isSelectable);
    if (!group.length) return;
    setSelected((prev) => {
      const next = new Set(prev);
      const all = group.every((p) => prev.has(keyOf(p)));
      for (const p of group) for (const x of unitKeys(p)) { if (all) next.delete(x); else next.add(x); }
      return next;
    });
  }, [isSelectable, keyOf, unitKeys]);

  const selectAll = useCallback(() => setSelected(new Set(selectable.map(keyOf))), [selectable, keyOf]);
  const clear = useCallback(() => { setSelected(new Set()); anchorRef.current = null; setBulkError(null); }, []);
  const allSelected = selectable.length > 0 && count === selectable.length;
  const toggleAll = useCallback(() => (allSelected ? clear() : selectAll()), [allSelected, clear, selectAll]);

  // Loop `list` (the effective selection by default) one post at a time. `action(post)` may
  // return SKIP for a post it left alone. `onSettled({ done, skipped, fails })` runs before the
  // summary is thrown, so a caller (the delete's undo) always sees what went through.
  const runBulk = async (action, label, list = effectiveSelection, { onSettled } = {}) => {
    setBulkError(null);
    const sel = list;
    const done = [];
    const skipped = [];
    const fails = [];
    setBulkProgress({ done: 0, total: sel.length });
    try {
      for (const p of sel) {
        try {
          const r = await action(p); // eslint-disable-line no-await-in-loop
          if (r === SKIP) skipped.push(p);
          else done.push(p);
        } catch (e) {
          // The summary states WHY in plain words when that is known (a client timeout or an
          // unreachable pendpost); a server/engine line rides the "?" only, never the bar.
          if (e?.canceled === true) skipped.push(p);
          else fails.push({ post: p, id: nameOf(p), ...humanizeAction(e, t, { fallbackKey: 'error.action' }) });
        }
        setBulkProgress({ done: done.length + skipped.length + fails.length, total: sel.length });
      }
    } finally {
      // Always clear, even if the loop itself throws: the button's error/idle labels must
      // never keep rendering a stale "{done}/{total}".
      setBulkProgress(null);
    }
    queryClient.invalidateQueries({ queryKey: ['plans'] });
    const doneKeys = new Set(done.map(keyOf));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of doneKeys) next.delete(k);
      return next;
    });
    const result = { done, skipped, fails };
    onSettled?.(result);
    if (fails.length) throw bulkSummaryError({ ok: done.length, label, fails }, t);
    return result;
  };

  return {
    selected, setSelected, selectable, effectiveSelection, count, isSelected,
    toggle, selectThread, toggleGroup, selectAll, clear, allSelected, toggleAll,
    runBulk, bulkProgress, bulkError, setBulkError,
  };
}

// The one failure summary a bulk run throws: "{ok} {label}, {failed} failed: {reasons}". Never
// a post id (Freigaben error UX, 2026-11-06): the rows that failed stay selected and say why
// themselves, so the line names each known reason ONCE; the raw engine lines ride the "?" only.
export function bulkSummaryError({ ok, label, fails }, t) {
  const reasons = [...new Set(fails.filter((f) => f.known && f.text).map((f) => f.text))].join(', ');
  const head = t('approvals.bulk.failedSummary', { ok, label, failed: fails.length });
  const detail = [...new Set(fails.filter((f) => f.raw).map((f) => f.raw))].join('\n') || null;
  return plainError(reasons ? `${head}: ${reasons}` : head, detail);
}
