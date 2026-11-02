// The one way to land on a Radar signal card. The card's DOM id is its `source externalId` key
// (the same key the server logs on an agent activity entry), so the agent transcript's "finding
// reported" lines and Radar "Replies to you" ("Open in Radar") share this jump.

export const signalDomId = (key) => `radar-sig-${encodeURIComponent(key)}`;

// Scroll the card into view (calm under prefers-reduced-motion). With `focus`, the card also
// takes keyboard focus for the moment, so it carries the brand focus ring the card already
// declares (focus:ring-2 focus:ring-brand); the temporary tab stop goes away on blur, so a
// mouse click on the card never focuses it. Returns false when the card is not rendered.
export function jumpToSignal(key, { focus = false } = {}) {
  if (!key || typeof document === 'undefined') return false;
  const el = document.getElementById(signalDomId(key));
  if (!el) return false;
  const calm = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
  el.scrollIntoView?.({ behavior: calm ? 'auto' : 'smooth', block: 'center' });
  if (focus) {
    if (!el.hasAttribute('tabindex')) {
      el.setAttribute('tabindex', '-1');
      el.addEventListener('blur', () => el.removeAttribute('tabindex'), { once: true });
    }
    el.focus({ preventScroll: true });
  }
  return true;
}
