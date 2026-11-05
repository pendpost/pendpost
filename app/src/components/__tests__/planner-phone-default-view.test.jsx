import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import App from '../../App.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// Phase 3 D3: on a phone (max-width 639px) the planner opens on the List, because seven
// readable day columns cannot fit 341px. Wider screens keep Week. The choice is not
// persisted and the switcher is unchanged, so Week and Month stay one tap away. jsdom has no
// matchMedia, so the initializer guards for it and falls back to Week.
const POST = {
  campaign: 'launch', id: 'p1', approval: 'pending', derivedState: 'draft', scheduledAt: '2026-09-28T10:00:00Z',
  type: 'image', platforms: ['mastodon'], media: { file: null, exists: false }, caption: 'Hello', title: 'Hello',
};

vi.mock('../../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useActivity: () => ({ data: { activity: [] }, isLoading: false, isError: false }),
    usePlans: () => ({ data: { campaigns: [{ id: 'launch', active: true, posts: [POST] }] }, isLoading: false, isError: false }),
    useAccounts: () => ({ data: {} }),
    useActiveClient: () => ({ activeClient: null, data: { clients: [], activeClientId: null }, isLoading: false, isError: false, activeClientId: null }),
    useClients: () => ({ data: { clients: [], activeClientId: null }, isLoading: false, isError: false, error: null }),
    usePendpostHealth: () => ({ data: null, isLoading: false, isError: false }),
  };
});

const hadMatchMedia = Object.prototype.hasOwnProperty.call(window, 'matchMedia');
const originalMatchMedia = window.matchMedia;

// A phone answers only the phone query with true; every other query (the lg sidebar
// listener, reduced motion) stays false so nothing else changes under the stub.
function stubMatchMedia(phone) {
  window.matchMedia = vi.fn((query) => ({
    matches: phone && query === '(max-width: 639px)',
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

beforeEach(() => {
  window.location.hash = '#planner';
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

afterEach(() => {
  cleanup();
  window.location.hash = '';
  if (hadMatchMedia) window.matchMedia = originalMatchMedia;
  else delete window.matchMedia;
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

const segment = (name) => screen.getByRole('button', { name });
const WEEK = /^(Week|Woche)$/;
const MONTH = /^(Month|Monat)$/;
const LIST = /^(List|Liste)$/;

describe('planner default view (D3)', () => {
  it('a phone opens on the List segment', () => {
    stubMatchMedia(true);
    renderApp();
    expect(segment(LIST)).toHaveAttribute('aria-pressed', 'true');
    expect(segment(WEEK)).toHaveAttribute('aria-pressed', 'false');
    expect(segment(MONTH)).toHaveAttribute('aria-pressed', 'false');
    // No 840px grid on the page at all in the list view.
    expect(document.querySelector('[class*="min-w-[840px]"]')).toBeNull();
  });

  // The List's keys (j / k, x, Enter, e, Esc) ride the filter bar's "?" popover while the
  // Planer shows the List, and only then: the page itself carries no hint line.
  it('the "?" popover lists the List\'s shortcuts in List view only', async () => {
    const user = userEvent.setup();
    stubMatchMedia(true);
    renderApp();
    await user.click(document.querySelector('[data-filter-legend]'));
    const keys = await waitFor(() => {
      const el = document.querySelector('[data-keyboard-shortcuts]');
      expect(el).not.toBeNull();
      return el;
    });
    expect([...keys.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['j', 'k', 'x', 'Enter', 'e', 'Esc']);
    await user.keyboard('{Escape}');
    await user.click(segment(WEEK));
    await user.click(document.querySelector('[data-filter-legend]'));
    await waitFor(() => expect(document.querySelector('[data-filter-legend]')).toHaveAttribute('aria-expanded', 'true'));
    expect(document.querySelector('[data-keyboard-shortcuts]')).toBeNull();
  });

  it('a wider screen opens on Week', () => {
    stubMatchMedia(false);
    renderApp();
    expect(segment(WEEK)).toHaveAttribute('aria-pressed', 'true');
    expect(segment(LIST)).toHaveAttribute('aria-pressed', 'false');
  });

  it('without matchMedia (jsdom) it falls back to Week', () => {
    delete window.matchMedia;
    renderApp();
    expect(segment(WEEK)).toHaveAttribute('aria-pressed', 'true');
  });

  it('the 840px week grid pans only inside its own overflow-x-auto wrapper, never the page', () => {
    stubMatchMedia(false);
    renderApp();
    const grid = document.querySelector('[class*="min-w-[840px]"]');
    expect(grid).not.toBeNull();
    const pan = grid.closest('.overflow-x-auto');
    expect(pan).not.toBeNull();
    // The canvas around it clips sideways (overflow-x-clip), and <main> can shrink (min-w-0),
    // so nothing wide reaches the page.
    const canvas = pan.parentElement;
    expect(canvas.classList.contains('overflow-x-clip')).toBe(true);
    expect(document.querySelector('main').classList.contains('min-w-0')).toBe(true);
    // The header and its control cluster wrap on a phone instead of running off the edge.
    const header = document.querySelector('header');
    expect(header.classList.contains('max-sm:flex-wrap')).toBe(true);
    const cluster = [...header.children].find((c) => c.contains(segment(WEEK)));
    expect(cluster.classList.contains('max-sm:flex-wrap')).toBe(true);
  });
});
