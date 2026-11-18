import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import App from '../../App.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// The planner header controls were measured under 44px (reconnect-first hitAreas.*:header):
// Zurück/Weiter 32x32, Heute 55x32, Woche/Monat/Liste 28 tall (34 wide on a phone), Kompakte
// Karten 32x32, Run-now 33x32 on a phone. Each now carries the 44px TAP_TARGET box (centred
// ::after, painted box unchanged; the segments use TAP_TARGET_Y so their boxes never reach
// over the neighbouring segment, plus a 44px width floor, since three icon segments side by
// side cannot each own 44px of width without it). Two 44px boxes on 32px buttons only stay
// apart at 12px, so the spacing that separates them grows to exactly that and no more. The
// real geometry (effective box + corner hit test) is measured in verify-shell-scroll.cjs.
vi.mock('../../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useActivity: () => ({ data: { activity: [] }, isLoading: false, isError: false }),
    usePlans: () => ({ data: { campaigns: [] }, isLoading: false, isError: false }),
    useAccounts: () => ({ data: {} }),
    useActiveClient: () => ({ activeClient: null, data: { clients: [], activeClientId: null }, isLoading: false, isError: false, activeClientId: null }),
    useClients: () => ({ data: { clients: [], activeClientId: null }, isLoading: false, isError: false, error: null }),
    usePendpostHealth: () => ({ data: null, isLoading: false, isError: false }),
  };
});

beforeEach(() => {
  window.location.hash = '';
  if (typeof window.localStorage === 'undefined' || typeof window.localStorage.getItem !== 'function') {
    const store = new Map();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
        clear: () => store.clear(),
      },
    });
  }
});

function renderApp() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ConfirmProvider>
        <App />
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}

const tok = (el, t) => (el.getAttribute('class') || '').split(/\s+/).includes(t);
const inHeader = (name) => {
  const header = document.querySelector('header');
  const btn = screen.getAllByRole('button', { name }).find((b) => header.contains(b));
  expect(btn, String(name)).toBeTruthy();
  return btn;
};

const FULL = [
  /^(Back|Zurück)$/,
  /^(Today|Heute)$/,
  /^(Next|Weiter)$/,
  // Run-now, the density toggle, delivery, language and theme live in this one overflow menu
  // since the Nov 2026 header diet (owner decision 8).
  /^(More|Mehr)$/,
];
const SEGMENTS = [/^(Week|Woche)$/, /^(Month|Monat)$/, /^(List|Liste)$/];

describe('planner header controls: 44px hit area, painted box unchanged', () => {
  it('back, today, next and the overflow menu carry the 44x44 TAP_TARGET box and stay painted h-8', () => {
    renderApp();
    for (const name of FULL) {
      const btn = inHeader(name);
      for (const t of ['after:h-11', 'after:min-w-11', 'after:absolute', 'h-8']) expect(tok(btn, t), `${name} ${t}`).toBe(true);
    }
  });

  it('the week/month/list segments carry a 44px-tall box and a 44px width floor, painted height unchanged', () => {
    renderApp();
    for (const name of SEGMENTS) {
      const btn = inHeader(name);
      for (const t of ['after:h-11', 'after:w-full', 'after:absolute', 'min-w-11', 'h-full']) expect(tok(btn, t), `${name} ${t}`).toBe(true);
      expect(tok(btn, 'after:min-w-11'), `${name} must not reach over its neighbour`).toBe(false);
    }
    expect(tok(inHeader(SEGMENTS[0]).parentElement, 'h-8')).toBe(true);
  });

  it('neighbouring boxes never overlap: back/today/next sit 6px apart, the header rows 12px apart', () => {
    renderApp();
    const nav = inHeader(FULL[0]).parentElement;
    expect(nav.contains(inHeader(FULL[2]))).toBe(true);
    expect(tok(nav, 'gap-1.5')).toBe(true);
    const header = document.querySelector('header');
    // menu -> nav on < lg, and the wrapped title row -> control row on a phone.
    expect(tok(header, 'gap-3')).toBe(true);
    // The control cluster wraps into rows on a phone; those rows need 12px too.
    const more = inHeader(FULL[3]);
    const cluster = [...header.children].find((c) => c.contains(more));
    expect(tok(cluster, 'max-sm:gap-y-3')).toBe(true);
  });

  // final-a7: the campaign <select> was 32px tall. A native select cannot carry a ::after box
  // (replaced element), and a wrapping <label> only focuses a select, it does not open it. So
  // the select ITSELF is 44px tall (h-11, a 44px width floor) and transparent, pulled back to
  // the 32px row by -my-1.5; a wrapper paints the familiar 32px pill and its focus ring.
  it('the campaign select is a real 44px target inside the unchanged 32px painted pill', () => {
    renderApp();
    const select = screen.getByRole('combobox', { name: /campaign|kampagne/i });
    for (const t of ['h-11', 'min-w-11', '-my-1.5', 'bg-transparent']) expect(tok(select, t), t).toBe(true);
    expect(tok(select, 'h-8')).toBe(false);
    // Square like the ::after box: browsers hit-test through border-radius, so rounded corners
    // would cut the 44px target's corners out (measured in verify-shell-scroll.cjs H2).
    expect((select.getAttribute('class') || '').split(/\s+/).some((c) => c.startsWith('rounded'))).toBe(false);
    const pill = select.parentElement;
    for (const t of ['h-8', 'rounded-xl', 'bg-zinc-200/60', 'has-[:focus-visible]:ring-2']) expect(tok(pill, t), t).toBe(true);
  });

  it('the header holds about six controls: back, today, next, the view pill, campaign, More', () => {
    renderApp();
    const header = document.querySelector('header');
    const names = [...header.querySelectorAll('button, select')].map((el) => el.getAttribute('aria-label') || el.textContent.trim());
    // The lg-hidden drawer trigger and the three view segments aside, nothing else sits there.
    for (const gone of [/run due/i, /cards/i, /delivery/i, /switch to/i, /needs you/i]) {
      expect(names.some((n) => gone.test(n)), String(gone)).toBe(false);
    }
  });

});
