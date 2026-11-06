// "Show me" from What's new (docs/specs/whats-new.md): an item's `go` is a spot key, and the
// Studio owns where each spot lives. The engine never names a page, so PAGES stays in App.jsx
// and a test checks every `go` in lib/whats-new.json against SPOTS.
//
// The spot element carries data-spot="<key>". A spot that is not on screen (the fix tray
// with nothing blocked, say) just opens its page: no error, nothing lights up.

// spot key -> the page it lives on
export const SPOTS = Object.freeze({
  approvals: 'freigaben',
  'bulk-select': 'planner',
  'fix-tray': 'planner',
  radar: 'radar',
});
// The planner view a spot needs (the bulk selection line only exists in the List).
export const SPOT_VIEW = Object.freeze({ 'bulk-select': 'list' });

// App.jsx listens for this event and moves to the page (and view), the same way a sidebar
// click does; the hash is set too, so the address bar matches at once.
export const SPOT_EVENT = 'pendpost:spot';
export const PULSE_CLASS = 'spot-pulse';
const WAIT_MS = 1500;
const PULSE_MS = 1600;

const raf = (fn) => (typeof window.requestAnimationFrame === 'function'
  ? window.requestAnimationFrame(fn)
  : setTimeout(fn, 16));

// Open the spot's page, then wait for the element to render (up to ~1.5s), scroll it into
// view (calm under prefers-reduced-motion, like lib/radarJump.js) and pulse a brand ring.
// Returns false for an unknown key.
export function jumpToSpot(key) {
  const page = SPOTS[key];
  if (!page || typeof window === 'undefined') return false;
  window.location.hash = `#${page}`;
  window.dispatchEvent(new CustomEvent(SPOT_EVENT, { detail: { key, page, view: SPOT_VIEW[key] || null } }));
  const until = Date.now() + WAIT_MS;
  const find = () => {
    const el = document.querySelector(`[data-spot="${key}"]`);
    if (el) { highlight(el); return; }
    if (Date.now() < until) raf(find);
  };
  raf(find);
  return true;
}

function highlight(el) {
  const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  el.scrollIntoView?.({ behavior: calm ? 'auto' : 'smooth', block: 'center' });
  el.classList.add(PULSE_CLASS);
  setTimeout(() => el.classList.remove(PULSE_CLASS), PULSE_MS);
}
