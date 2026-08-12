// freigaben-sort.test.jsx - the order the approvals list opens in, and the control.
//
// "Alle Beitraege" opened OLDEST first, so the archive greeted the operator with posts
// from 11.06. The two tabs are different objects and get different defaults: the queue
// is work (act on the soonest due), the archive is recall (find the most recent). The
// direction is the operator's, persisted PER TAB, because one shared key would let a
// choice made on the archive silently reorder the work queue.

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Freigaben from '../Freigaben.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider, makeT } from '../../lib/i18n.js';

const t = makeT('en');

vi.mock('../../lib/api.js', () => ({
  approvePost: vi.fn(() => Promise.resolve({ ok: true })),
  rejectPost: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] })),
  usePendpostHealth: () => ({ data: null }),
  useConfig: () => ({ data: null }),
  // Freigaben reads the connected accounts once at the parent for the destination strip.
  useAccounts: () => ({ data: null, isLoading: false, isError: false }),
}));

// Node 22's experimental `localStorage` global shadows jsdom's and exposes no methods,
// so every pref read silently no-ops under vitest. The per-tab persistence assertions
// need a real backend; the same Map-backed stub SidebarResizer.test.jsx installs.
function installStorage() {
  const map = new Map();
  const stub = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => { map.clear(); },
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: stub, configurable: true, writable: true });
  Object.defineProperty(window, 'localStorage', { value: stub, configurable: true, writable: true });
  return stub;
}

const post = (id, title, scheduledAt, approval, campaign = 'spring') => ({
  id,
  campaign,
  title,
  caption: `${title}\nBody copy for ${id}.`,
  platforms: ['instagram'],
  approval,
  derivedState: approval === 'pending' ? 'draft' : 'scheduled',
  scheduledAt,
  type: 'reel',
  image: null,
  media: null,
});

// Three dated posts plus one with NO date, which must sort last in BOTH directions.
const campaigns = [{
  id: 'spring',
  active: true,
  posts: [
    post('mid', 'Mid post', '2026-07-02T10:00:00Z', 'pending'),
    post('oldest', 'Oldest post', '2026-06-11T10:00:00Z', 'pending'),
    post('newest', 'Newest post', '2026-07-25T10:00:00Z', 'pending'),
    post('undated', 'Undated post', null, 'pending'),
  ],
}];

function renderList() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <Freigaben campaigns={campaigns} onOpen={() => {}} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

/** The card headlines in rendered order. */
function order() {
  return screen.getAllByRole('listitem').map((li) => {
    for (const name of ['Oldest post', 'Mid post', 'Newest post', 'Undated post']) {
      if ((li.textContent || '').includes(name)) return name;
    }
    return '?';
  });
}

const sortButton = () => screen.getByRole('button', { name: new RegExp(`${t('approvals.sort.newest')}|${t('approvals.sort.oldest')}`) });
const allTab = () => screen.getByRole('button', { name: t('approvals.view.all') });

beforeEach(() => { installStorage(); });

describe('Freigaben ordering', () => {
  it('opens the QUEUE oldest first - the soonest-due item is the one to act on', () => {
    renderList();
    expect(order()).toEqual(['Oldest post', 'Mid post', 'Newest post', 'Undated post']);
  });

  it('opens the ARCHIVE newest first - this is the regression that started the ticket', async () => {
    renderList();
    await userEvent.click(allTab());
    expect(order()).toEqual(['Newest post', 'Mid post', 'Oldest post', 'Undated post']);
  });

  it('an undated post sorts LAST in both directions, never floated to the top', async () => {
    renderList();
    expect(order().at(-1)).toBe('Undated post');
    await userEvent.click(sortButton());
    expect(order().at(-1)).toBe('Undated post');
  });

  it('the toggle reverses the order and states which direction is active', async () => {
    renderList();
    expect(sortButton()).toHaveAccessibleName(t('approvals.sort.oldest'));
    await userEvent.click(sortButton());
    expect(order().slice(0, 3)).toEqual(['Newest post', 'Mid post', 'Oldest post']);
    expect(sortButton()).toHaveAccessibleName(t('approvals.sort.newest'));
  });

  it('the control is on BOTH tabs, so neither tab leaves its order unstated', async () => {
    renderList();
    expect(sortButton()).toBeInTheDocument();
    await userEvent.click(allTab());
    expect(sortButton()).toBeInTheDocument();
  });

  it('the preference is per tab: reordering the archive leaves the queue alone', async () => {
    renderList();
    // Flip the ARCHIVE to oldest-first.
    await userEvent.click(allTab());
    await userEvent.click(sortButton());
    expect(order().slice(0, 3)).toEqual(['Oldest post', 'Mid post', 'Newest post']);
    // The queue keeps its own direction.
    await userEvent.click(screen.getByRole('button', { name: /To review/i }));
    expect(order().slice(0, 3)).toEqual(['Oldest post', 'Mid post', 'Newest post']);
    // Both keys are stored independently.
    expect(localStorage.getItem('pendpost-approvals-sort:all')).toBe('oldest');
    expect(localStorage.getItem('pendpost-approvals-sort:pending')).toBe('oldest');
  });

  it('a stored preference survives a remount, per tab', async () => {
    const first = renderList();
    await userEvent.click(sortButton()); // queue -> newest first
    expect(localStorage.getItem('pendpost-approvals-sort:pending')).toBe('newest');
    first.unmount();

    renderList();
    expect(order().slice(0, 3)).toEqual(['Newest post', 'Mid post', 'Oldest post']);
    // The archive kept its own default, untouched by the queue's change.
    await userEvent.click(allTab());
    expect(order().slice(0, 3)).toEqual(['Newest post', 'Mid post', 'Oldest post']);
    expect(localStorage.getItem('pendpost-approvals-sort:all')).toBe('newest');
  });

  it('archived-campaign work still sorts after active work, whichever direction is set', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <I18nProvider locale="en">
          <TooltipProvider>
            <ConfirmProvider>
              <Freigaben
                campaigns={[
                  { id: 'spring', active: true, posts: [post('a', 'Active late', '2026-08-01T10:00:00Z', 'pending', 'spring')] },
                  { id: 'old', active: false, posts: [post('b', 'Archived early', '2026-06-01T10:00:00Z', 'pending', 'old')] },
                ]}
                onOpen={() => {}}
              />
            </ConfirmProvider>
          </TooltipProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );
    const headlines = () => screen.getAllByRole('listitem').map((li) => (li.textContent || ''));
    const idx = (s) => headlines().findIndex((h) => h.includes(s));
    expect(idx('Active late')).toBeLessThan(idx('Archived early'));
    await userEvent.click(screen.getByRole('button', { name: new RegExp(`${t('approvals.sort.newest')}|${t('approvals.sort.oldest')}`) }));
    expect(idx('Active late')).toBeLessThan(idx('Archived early'));
  });
});
