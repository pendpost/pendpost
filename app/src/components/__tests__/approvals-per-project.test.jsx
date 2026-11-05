// approvals-per-project.test.jsx - the owner's report of 2026-11-01, pinned.
//
// "for pendpost we have X connected and set up. So why do you display X is not connected and
// blocked?" In All-projects mode every post was judged by the ACTIVE project's setup, so
// pendpost's X drafts read Blocked whenever the active project (say TILL) had no X. And each
// Approvals row stacked a Blocked pill, Reject, "Copy and post yourself", a campaign line and a
// tiny text preview beside the same text in bold. These tests pin the fix:
//   - a post is judged by its OWN project's setup (lib/setupByClient.js);
//   - the "Publishing as" strip is hidden in All-projects mode;
//   - a row carries ONE status signal and ONE action; Reject lives in the row menu; no
//     campaign text; no text-preview box for a text post.
import { render, screen, within, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Freigaben from '../Freigaben.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import { resolveSetup } from '../../lib/setupByClient.js';

let activeHealth;
vi.mock('../../lib/api.js', () => ({
  usePlatformValidate: () => ({ data: null }),
  approvePost: vi.fn(() => Promise.resolve({ ok: true })),
  rejectPost: vi.fn(() => Promise.resolve({ ok: true })),
  markPosted: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] })),
  usePendpostHealth: () => ({ data: activeHealth }),
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: { x: { handle: '' } }, isLoading: false, isError: false }),
}));

const X_ON = { setup: { platforms: [{ platform: 'x', status: 'connected' }] } };
const X_OFF = { setup: { platforms: [{ platform: 'x', status: 'incomplete' }] } };

const NO_MEDIA = { file: null, exists: false, bytes: null, url: null, cover: null, path: null };
const base = {
  campaign: 'release-2-10-0', approval: 'pending', derivedState: 'draft', scheduledAt: '2026-11-03T09:00:00Z',
  type: 'text', platforms: ['x'], media: NO_MEDIA, image: null,
};
// Two projects, both with a queued X draft. pendpost has X; TILL does not.
const pendpostX = {
  ...base, id: 'pp-x', clientId: 'pendpost', clientName: 'pendpost', accent: '#0f766e',
  caption: 'pendpost 2.10 is out\nOne status signal per row, and the planner reads every project right.',
};
const tillX = {
  ...base, id: 'till-x', clientId: 'till', clientName: 'TILL', accent: '#7c3aed',
  caption: 'TILL weekly note\nA short note for the week.',
};

function renderApprovals(posts, { allProjects = true, seed = [], onNavigate = vi.fn(), density = 'compact' } = {}) {
  try { localStorage.setItem('pendpost-approvals-density', density); } catch { /* jsdom quirk */ }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const [key, data] of seed) qc.setQueryData(key, data);
  const campaigns = [{ id: 'release-2-10-0', active: true, posts }];
  const utils = render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <Freigaben campaigns={campaigns} onOpen={() => {}} onNavigate={onNavigate} allProjects={allProjects} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { ...utils, onNavigate };
}

const rowFor = (title) => screen.getAllByRole('listitem').find((li) => li.textContent.includes(title));

// Node's experimental localStorage has no methods under vitest; stub it per file.
let store;
beforeEach(() => {
  store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  });
  // The ACTIVE project is TILL: no X.
  activeHealth = X_OFF;
});

const bothProjects = [
  [['pendpost-health', 'pendpost'], X_ON],
  [['pendpost-health', 'till'], X_OFF],
];

describe('each post is judged by its own project', () => {
  it('a pendpost X post reads approvable while the active project has no X', () => {
    renderApprovals([pendpostX], { seed: bothProjects });
    const row = rowFor('pendpost 2.10 is out');
    expect(within(row).getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(within(row).queryByText(/not connected/i)).not.toBeInTheDocument();
    expect(within(row).queryByText(/^Blocked$/)).not.toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /connect x/i })).not.toBeInTheDocument();
  });

  it('a post whose own project lacks X reads not connected, with Connect X', () => {
    renderApprovals([pendpostX, tillX], { seed: bothProjects });
    const row = rowFor('TILL weekly note');
    expect(within(row).getByText('X is not connected')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Connect X' })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('the Connect fix of another project names that project to the navigation', () => {
    activeHealth = X_ON;
    const { onNavigate } = renderApprovals([tillX], { seed: bothProjects });
    fireEvent.click(screen.getByRole('button', { name: 'Connect X' }));
    expect(onNavigate).toHaveBeenCalledWith('setup', 'x', { action: 'reconnect' }, 'till');
  });

  it('an unknown project setup never borrows a verdict from the active project', () => {
    // Project setups not loaded yet: TILL is active with no X, but pendpost's post must not
    // read blocked on TILL's account.
    renderApprovals([pendpostX]);
    expect(screen.queryByText(/not connected/i)).not.toBeInTheDocument();
  });

  it('resolveSetup: own project, else the active one only for its own posts, else unknown', () => {
    const own = { platforms: [] };
    const act = { platforms: [{ platform: 'x', status: 'incomplete' }] };
    const byClient = new Map([['pendpost', own]]);
    expect(resolveSetup({ clientId: 'pendpost' }, { byClient, activeSetup: act, activeClientId: 'till' })).toBe(own);
    expect(resolveSetup({ clientId: 'till' }, { byClient, activeSetup: act, activeClientId: 'till' })).toBe(act);
    expect(resolveSetup({ clientId: 'globex' }, { byClient, activeSetup: act, activeClientId: 'till' })).toBeNull();
    expect(resolveSetup({}, { byClient, activeSetup: act, activeClientId: 'till' })).toBe(act);
  });
});

describe('the "Publishing as" strip', () => {
  it('is hidden in All-projects mode: accounts differ per project', () => {
    renderApprovals([pendpostX, tillX], { seed: bothProjects });
    expect(screen.queryByText('Publishing as')).not.toBeInTheDocument();
    expect(screen.queryByText(/no account on file/i)).not.toBeInTheDocument();
  });

  it('in one-project mode says "X not connected" plainly, never "No account on file"', () => {
    try { store.set('pendpost-destination-collapsed', '0'); } catch { /* noop */ }
    const { clientId, clientName, ...onePost } = tillX; // eslint-disable-line no-unused-vars
    renderApprovals([onePost], { allProjects: false });
    expect(screen.getByText('Publishing as')).toBeInTheDocument();
    expect(screen.getByText('X not connected')).toBeInTheDocument();
    expect(screen.queryByText(/no account on file/i)).not.toBeInTheDocument();
  });
});

describe('an Approvals row reads in one glance', () => {
  // The row's own action controls: everything on the row except the open-detail button, the
  // checkbox and the menu trigger.
  const rowActions = (row) => within(row).getAllByRole('button')
    .filter((b) => !b.closest('[data-open-detail]') && b.getAttribute('aria-haspopup') !== 'menu' && !b.textContent.includes('weekly note') && !b.textContent.includes('2.10 is out'));

  for (const density of ['compact', 'comfortable']) {
    it(`${density}: an approvable row has exactly one action, Approve; Reject is in the menu`, async () => {
      renderApprovals([pendpostX], { seed: bothProjects, density });
      const row = rowFor('pendpost 2.10 is out');
      const actions = rowActions(row).map((b) => b.getAttribute('aria-label') || b.textContent.trim());
      expect(actions).toEqual(['Approve']);
      fireEvent.click(within(row).getByRole('button', { name: 'More actions' }));
      const items = await screen.findAllByRole('menuitem');
      expect(items[0]).toHaveTextContent('Reject');
    });

    it(`${density}: a blocked row has exactly one action, the fix, and no pill beside it`, () => {
      renderApprovals([tillX], { seed: bothProjects, density });
      const row = rowFor('TILL weekly note');
      const actions = rowActions(row).map((b) => b.getAttribute('aria-label') || b.textContent.trim());
      expect(actions).toEqual(['Connect X']);
      expect(within(row).queryByText(/^Blocked$/)).not.toBeInTheDocument();
      expect(within(row).queryByText(/copy and post yourself/i)).not.toBeInTheDocument();
      expect(within(row).queryByText(/^Reject$/)).not.toBeInTheDocument();
    });

    it(`${density}: no campaign text and no text-preview box on a text post`, () => {
      const { container } = renderApprovals([pendpostX], { seed: bothProjects, density });
      const row = rowFor('pendpost 2.10 is out');
      expect(row.textContent).not.toMatch(/Campaign:/);
      expect(row.textContent).not.toMatch(/Release 2 10 0/i);
      // An X post publishes no title: no bold line, the caption is one paragraph, first line kept.
      expect(row.querySelector('[data-row-title]')).toBeNull();
      expect(within(row).getByText(/^pendpost 2\.10 is out One status signal per row/)).toBeInTheDocument();
      // No thumbnail for a text post (CoverThumb renders an img or a text tile): a quiet lane tile.
      expect(row.querySelector('img, video')).toBeNull();
      expect(row.querySelector('[data-row-media] [data-lane-tile="x"]')).not.toBeNull();
      expect(container.querySelectorAll('[data-text-preview]')).toHaveLength(0);
    });

    // Release polish 2026-11-01: Approve sat top-right on the title line while Connect sat
    // bottom-right on the alert line, so the action column was ragged. Every row now has ONE
    // action slot holding its action and its ⋯; the rose status line only says why.
    it(`${density}: Approve and the fix sit in the same action slot, each with its ⋯`, () => {
      renderApprovals([pendpostX, tillX], { seed: bothProjects, density });
      for (const [title, name] of [['pendpost 2.10 is out', 'Approve'], ['TILL weekly note', 'Connect X']]) {
        const row = rowFor(title);
        const slots = row.querySelectorAll('[data-row-action]');
        expect(slots).toHaveLength(1);
        expect(within(slots[0]).getByRole('button', { name })).toBeInTheDocument();
        expect(within(slots[0]).getByRole('button', { name: 'More actions' })).toBeInTheDocument();
      }
      const status = rowFor('TILL weekly note').querySelector('[data-row-status]');
      expect(status).toHaveTextContent('X is not connected');
      expect(within(status).queryByRole('button')).toBeNull();
      expect(rowFor('pendpost 2.10 is out').querySelector('[data-row-status]')).toBeNull();
      // Dark: the fix pill's fill differs from the row's zinc-800 surface, so it keeps its shape.
      const fix = within(rowFor('TILL weekly note')).getByRole('button', { name: 'Connect X' });
      expect(rowFor('TILL weekly note').className).toMatch(/dark:bg-zinc-800(\s|$)/);
      expect(fix.className).toMatch(/dark:bg-zinc-700\/60/);
      expect(fix.className).not.toMatch(/dark:bg-zinc-800/);
    });

    it(`${density}: the date's tooltip names the campaign humanised, version dots kept`, async () => {
      renderApprovals([pendpostX], { seed: bothProjects, density });
      const date = rowFor('pendpost 2.10 is out').querySelector('[data-row-meta] .tabular-nums');
      fireEvent.focus(date);
      fireEvent.pointerMove(date);
      const tip = await screen.findByRole('tooltip');
      expect(tip).toHaveTextContent('Campaign: Release 2.10.0');
    });
  }

  it('list and grid show the same date format', () => {
    const { unmount } = renderApprovals([pendpostX], { seed: bothProjects, density: 'compact' });
    const dateOf = () => rowFor('pendpost 2.10 is out').querySelector('[data-row-meta] .tabular-nums').textContent;
    const listDate = dateOf();
    unmount();
    renderApprovals([pendpostX], { seed: bothProjects, density: 'comfortable' });
    expect(dateOf()).toBe(listDate);
    // The row's readable when (fmtRowWhen): a day word, or weekday + day + short month (+ year).
    expect(listDate).toMatch(/^(Today|Tomorrow|Yesterday|[A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}(, \d{4})?) · \d{2}:\d{2}\s?[AP]M$/);
    // "01:25 PM" never breaks between the time and its AM/PM.
    expect(rowFor('pendpost 2.10 is out').querySelector('[data-row-meta] .tabular-nums').className).toContain('whitespace-nowrap');
  });

  it('the project chip shows in All-projects mode and not in one-project mode', () => {
    const { unmount } = renderApprovals([pendpostX], { seed: bothProjects });
    expect(within(rowFor('pendpost 2.10 is out')).getByText('pendpost')).toBeInTheDocument();
    unmount();
    const { clientId, clientName, ...onePost } = pendpostX; // eslint-disable-line no-unused-vars
    renderApprovals([onePost], { allProjects: false });
    expect(within(rowFor('pendpost 2.10 is out')).queryByText(/^pendpost$/)).not.toBeInTheDocument();
  });
});
