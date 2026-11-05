// Is a `position: sticky` element pinned at its sticky top right now? A stuck strip needs an
// opaque fill (rows scroll under it), but an unstuck one must stay transparent: the glass panel
// behind it is translucent and blurred over moving background blobs, so any hard-coded colour
// reads as a darker band wherever the element sits in the flow.
//
// Robust to ANY scroll, a jump included ("Heute", j/k scrollIntoView, keyboard paging): ONE
// shared, passive, rAF-throttled `scroll` listener per scroll root (the element's scroller,
// <main> in the app shell scroll model) plus one `resize` listener recompute every registered
// element, and each element is computed once when it registers. An observer with a threshold
// missed a jump (no crossing reported), which left the pinned heading clear over the rows.
// `top`: the sticky top in px (the List's day headings sit under the bulk line, so theirs is the
// line's height while it sticks). `bounded` is accepted for the day headings' call but no longer
// changes the verdict: a heading being pushed out by its section's end still covers rows.
// An element with no layout (jsdom, display: none) is never stuck: it simply stays transparent.
import { useEffect, useState } from 'react';

// The verdict for one element: its rect, the sticky line (root top + sticky top) and the root's
// own top. Stuck = at or above the line AND still showing below the root's top. That includes the
// moment a day heading is pushed up and out by the end of its section: it still sits over that
// section's last row, so it keeps its fill until it has left the screen. Exported for the tests.
export function stuckFrom(rect, line, rootTop = -Infinity) {
  if (!rect || (rect.width === 0 && rect.height === 0)) return false;
  return rect.top <= line + 0.5 && rect.bottom > rootTop;
}

function scrollParent(el) {
  for (let node = el?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return null;
}

const raf = (fn) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(fn) : setTimeout(fn, 16));

// One entry per scroll root (an element, or `window` for the document).
const roots = new Map();

function measure(entry, root) {
  const rootTop = root === window ? 0 : root.getBoundingClientRect().top;
  const { el, top } = entry;
  const next = stuckFrom(el.getBoundingClientRect(), rootTop + top, rootTop);
  if (next !== entry.stuck) {
    entry.stuck = next;
    entry.set(next);
  }
}

function rootFor(root) {
  let r = roots.get(root);
  if (r) return r;
  r = { entries: new Set(), pending: false };
  const run = () => {
    r.pending = false;
    for (const entry of r.entries) measure(entry, root);
  };
  r.schedule = () => {
    if (r.pending) return;
    r.pending = true;
    raf(run);
  };
  root.addEventListener('scroll', r.schedule, { passive: true });
  window.addEventListener('resize', r.schedule, { passive: true });
  roots.set(root, r);
  return r;
}

function release(root, entry) {
  const r = roots.get(root);
  if (!r) return;
  r.entries.delete(entry);
  if (r.entries.size) return;
  root.removeEventListener('scroll', r.schedule);
  window.removeEventListener('resize', r.schedule);
  roots.delete(root);
}

export function useStuck(ref, { top = 0, enabled = true, bounded = false } = {}) {
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || typeof window === 'undefined') {
      setStuck(false);
      return undefined;
    }
    const root = scrollParent(el) || window;
    const entry = { el, top, bounded, stuck: false, set: setStuck };
    rootFor(root).entries.add(entry);
    measure(entry, root);
    return () => {
      release(root, entry);
      setStuck(false);
    };
  }, [ref, top, enabled, bounded]);
  return enabled && stuck;
}
