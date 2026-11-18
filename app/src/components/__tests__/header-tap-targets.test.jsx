import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import App from '../../App.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// Judge final (evidence gap): the header icon buttons (menu, cloud status, language, theme)
// are painted 32x32 and had no 44px hit area. They get TAP_TARGET (an absolutely positioned,
// centred 44x44 ::after box) with NO change to the painted h-8 w-8 box. Two 44px boxes on
// 32px buttons only stay apart when the buttons sit at least 12px apart, so the status/
// language/theme cluster uses gap-3 (one Tailwind step = 4px). The real geometry (effective
// box + corner hit test) is measured in the browser flow verify-reconnect-first.cjs.
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

// Since the Nov 2026 header diet (owner decision 8) the delivery status, language and theme
// sit in ONE overflow menu, so the persistent icons are the drawer trigger and that menu.
const LABELS = [/^(Open menu|Menü öffnen)$/, /^(More|Mehr)$/];

describe('header icon buttons: 44px hit area, unchanged painted box', () => {
  it('the drawer trigger and the overflow menu each carry the 44x44 TAP_TARGET box and stay painted h-8 w-8', () => {
    renderApp();
    const header = document.querySelector('header');
    expect(header).not.toBeNull();
    for (const name of LABELS) {
      const btn = screen.getAllByRole('button', { name }).find((b) => header.contains(b));
      expect(btn, String(name)).toBeTruthy();
      const cls = btn.className;
      expect(cls, String(name)).toMatch(/(^|\s)after:h-11(\s|$)/);
      expect(cls, String(name)).toMatch(/(^|\s)after:min-w-11(\s|$)/);
      expect(cls, String(name)).toMatch(/(^|\s)after:absolute(\s|$)/);
      expect(cls, String(name)).toMatch(/(^|\s)h-8(\s|$)/);
      expect(cls, String(name)).toMatch(/(^|\s)w-8(\s|$)/);
    }
  });

  it('the overflow menu lists delivery, language and theme on every page', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    renderApp();
    const header = document.querySelector('header');
    await user.click(screen.getAllByRole('button', { name: LABELS[1] }).find((b) => header.contains(b)));
    const items = screen.getAllByRole('menuitem').map((b) => b.textContent);
    expect(items.some((x) => /switch to (english|german)/i.test(x))).toBe(true);
    expect(items.some((x) => /switch to (dark|light) theme/i.test(x))).toBe(true);
    expect(items.length).toBeGreaterThanOrEqual(3);
  });
});

// UX round 10, F1: Approvals and Radar carry no header card. Their title stays an sr-only <h1>
// and the same two controls (the drawer trigger and the "..." menu) ride the page's first row:
// the FilterBar on Approvals, the Radar title row on Radar. Every other page keeps its header.
describe('pages without a header card: Approvals and Radar', () => {
  const firstRow = {
    freigaben: () => document.querySelector('[data-filter-bar]'),
    radar: () => document.querySelector('[data-spot="radar"]'),
  };
  for (const [page, title] of [['freigaben', /^(Approvals|Freigaben)$/], ['radar', /^Radar$/]]) {
    it(`${page}: no header card, an sr-only h1, and both controls in the first row`, async () => {
      window.location.hash = `#${page}`;
      renderApp();
      expect(document.querySelector('header')).toBeNull();
      const h1 = screen.getByRole('heading', { level: 1, name: title });
      expect(h1.className.split(/\s+/)).toContain('sr-only');
      const row = await vi.waitFor(() => {
        const el = firstRow[page]();
        if (!el) throw new Error('first row not rendered');
        return el;
      });
      for (const name of LABELS) {
        const btn = screen.getAllByRole('button', { name }).find((b) => row.contains(b));
        expect(btn, String(name)).toBeTruthy();
        expect(btn.className, String(name)).toMatch(/(^|\s)after:h-11(\s|$)/);
      }
    });
  }

  it('the menu in the Approvals first row still lists delivery, language and theme', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    window.location.hash = '#freigaben';
    renderApp();
    const bar = document.querySelector('[data-filter-bar]');
    await user.click(screen.getAllByRole('button', { name: LABELS[1] }).find((b) => bar.contains(b)));
    const items = screen.getAllByRole('menuitem').map((b) => b.textContent);
    expect(items.some((x) => /switch to (english|german)/i.test(x))).toBe(true);
    expect(items.some((x) => /switch to (dark|light) theme/i.test(x))).toBe(true);
    expect(items.length).toBe(3);
  });

  it('the planner keeps its header card', () => {
    renderApp();
    expect(document.querySelector('header')).not.toBeNull();
  });
});
