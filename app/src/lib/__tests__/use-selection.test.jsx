// use-selection.test.jsx - the ONE multi-select + bulk-run pattern (planner bulk, package P).
//
// Approvals and the planner List share lib/useSelection.js. These pin its rules: a shift-click
// range in the visible order, a count that only ever reads the VISIBLE selection
// (intersect-visible), an X thread selected as one chain where `chain` is on, a day heading
// that selects (or clears) its day, and runBulk's partial-failure contract (S6): the failed
// posts stay selected and ONE line names them.
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect } from 'vitest';
import { I18nProvider } from '../i18n.js';
import { useSelection, rangeKeys, intersectVisible, threadKeys, selectionKey, SKIP } from '../useSelection.js';

const post = (id, extra = {}) => ({ id, campaign: 'c', platforms: ['x'], ...extra });
const a = post('a');
const b = post('b');
const c = post('c');
const d = post('d');

function wrapper({ children }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">{children}</I18nProvider>
    </QueryClientProvider>
  );
}
function useHarness(props) { return useSelection(props); }
const useIt = (opts) => renderHook(useHarness, { wrapper, initialProps: opts });

describe('pure helpers', () => {
  it('rangeKeys selects from the anchor to the target in either direction', () => {
    const keys = ['a', 'b', 'c', 'd'];
    expect(rangeKeys(keys, 'b', 'd')).toEqual(['b', 'c', 'd']);
    expect(rangeKeys(keys, 'd', 'b')).toEqual(['b', 'c', 'd']);
    expect(rangeKeys(keys, 'gone', 'c')).toEqual(['c']);
    expect(rangeKeys(keys, 'a', 'gone')).toEqual([]);
  });

  it('intersectVisible keeps only the visible selected posts, in visible order', () => {
    const sel = new Set([selectionKey(d), selectionKey(a), 'c-hidden']);
    expect(intersectVisible([a, b, d], sel).map((p) => p.id)).toEqual(['a', 'd']);
  });

  it('selectionKey carries the project in All-projects mode', () => {
    expect(selectionKey(post('a', { clientId: 'acme' }))).toBe('acme/c-a');
    expect(selectionKey(a)).toBe('c-a');
  });

  it('threadKeys walks the whole X chain from any tweet', () => {
    const t1 = post('t1');
    const t2 = post('t2', { xReplyTo: 't1' });
    const t3 = post('t3', { xReplyTo: 't2' });
    expect(threadKeys(t3, [t1, t2, t3, a]).sort()).toEqual(['c-t1', 'c-t2', 'c-t3']);
    expect(threadKeys(a, [t1, t2, t3, a])).toEqual(['c-a']);
  });
});

describe('useSelection', () => {
  it('shift-click selects the range from the last toggled post', () => {
    const { result } = useIt({ items: [a, b, c, d] });
    act(() => result.current.toggle(a));
    act(() => result.current.toggle(c, { range: true }));
    expect(result.current.effectiveSelection.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(result.current.count).toBe(3);
  });

  it('counts only the visible selection: a filtered-out post leaves the count and the bulk list', () => {
    const { result, rerender } = useIt({ items: [a, b, c] });
    act(() => result.current.toggle(a));
    act(() => result.current.toggle(c));
    expect(result.current.count).toBe(2);
    rerender({ items: [a, b] }); // c is filtered away
    expect(result.current.count).toBe(1);
    expect(result.current.effectiveSelection.map((p) => p.id)).toEqual(['a']);
    rerender({ items: [a, b, c] }); // and comes back still selected
    expect(result.current.count).toBe(2);
  });

  it('only selectable posts count (Approvals: actionable only)', () => {
    const { result } = useIt({ items: [a, b, c], isSelectable: (p) => p.id !== 'b' });
    act(() => result.current.selectAll());
    expect(result.current.effectiveSelection.map((p) => p.id)).toEqual(['a', 'c']);
    expect(result.current.allSelected).toBe(true);
  });

  it('with chain on, selecting one tweet selects the whole thread, and deselecting clears it (S7)', () => {
    const t1 = post('t1');
    const t2 = post('t2', { xReplyTo: 't1' });
    const t3 = post('t3', { xReplyTo: 't2' });
    const items = [t1, t2, t3, a];
    const { result } = useIt({ items, chain: true });
    act(() => result.current.toggle(t2));
    expect(result.current.effectiveSelection.map((p) => p.id)).toEqual(['t1', 't2', 't3']);
    act(() => result.current.toggle(t3));
    expect(result.current.count).toBe(0);
  });

  it('without chain a toggle moves one post; selectThread seeds the chain (Approvals)', () => {
    const t1 = post('t1');
    const t2 = post('t2', { xReplyTo: 't1' });
    const { result } = useIt({ items: [t1, t2] });
    act(() => result.current.toggle(t2));
    expect(result.current.effectiveSelection.map((p) => p.id)).toEqual(['t2']);
    act(() => result.current.selectThread(t2));
    expect(result.current.effectiveSelection.map((p) => p.id)).toEqual(['t1', 't2']);
  });

  it('a day group selects every post of the day, and clears them when all are selected', () => {
    const { result } = useIt({ items: [a, b, c, d] });
    act(() => result.current.toggle(b));
    act(() => result.current.toggleGroup([b, c]));
    expect(result.current.effectiveSelection.map((p) => p.id)).toEqual(['b', 'c']);
    act(() => result.current.toggleGroup([b, c]));
    expect(result.current.count).toBe(0);
  });

  it('clear empties the selection and the error line', () => {
    const { result } = useIt({ items: [a, b] });
    act(() => result.current.selectAll());
    act(() => result.current.setBulkError({ text: 'x' }));
    act(() => result.current.clear());
    expect(result.current.count).toBe(0);
    expect(result.current.bulkError).toBe(null);
  });
});

describe('runBulk (S6 partial failure)', () => {
  it('deselects what went through, keeps failures and skips selected, and throws ONE summary without post ids', async () => {
    const { result } = useIt({ items: [a, b, c], nameOf: (p) => `Post ${p.id}` });
    act(() => result.current.selectAll());
    let thrown = null;
    let settled = null;
    await act(async () => {
      try {
        await result.current.runBulk(async (p) => {
          if (p.id === 'b') throw new Error('engine said no');
          if (p.id === 'c') return SKIP;
          return { ok: true };
        }, 'deleted', undefined, { onSettled: (r) => { settled = r; } });
      } catch (e) { thrown = e; }
    });
    // The count only: no post id or name in the sentence (the failed row stays selected).
    expect(thrown?.message).toBe('1 deleted, 1 failed');
    expect(thrown?.message).not.toMatch(/Post b|\bb\b/);
    // The raw engine line rides the "?" detail only, never the sentence.
    expect(thrown?.detail).toBe('engine said no');
    expect(settled.done.map((p) => p.id)).toEqual(['a']);
    expect(settled.skipped.map((p) => p.id)).toEqual(['c']);
    expect(result.current.effectiveSelection.map((p) => p.id)).toEqual(['b', 'c']);
    expect(result.current.bulkProgress).toBe(null);
  });

  it('resolves with the tally when nothing failed', async () => {
    const { result } = useIt({ items: [a, b] });
    act(() => result.current.selectAll());
    let res;
    await act(async () => { res = await result.current.runBulk(async () => ({ ok: true }), 'approved'); });
    expect(res.done).toHaveLength(2);
    expect(result.current.count).toBe(0);
  });
});
