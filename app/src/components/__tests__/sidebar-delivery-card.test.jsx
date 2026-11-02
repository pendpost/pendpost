// The sidebar Delivery card (contract B, owner 2026-11-01): "We have clearly two cloud setups
// active, but the icon shows me the icon for the local publishing. ... We want clear icons, not
// more redundant text." The card now shows a cloud + count and a monitor + count side by side
// when the projects in view are mixed, one glyph otherwise, and a status dot on the icon:
// green = the cloud is delivering, amber = needs a look, red = disrupted, amber on the monitor =
// this computer is paused. Every dot has an accessible name.
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Sidebar from '../Sidebar.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import { cloudTone as realCloudTone, localTone as realLocalTone } from '../../lib/deliveryState.js';
import enPack from '../../locales/en.json';
import dePack from '../../locales/de-CH.json';

const setSchedulerRunning = vi.fn(() => Promise.resolve({ ok: true }));
vi.mock('../../lib/api.js', () => ({
  setSchedulerRunning: (...a) => setSchedulerRunning(...a),
  useSignals: () => ({ data: null }),
}));
let delivery;
const useDeliveryState = vi.fn(() => delivery);
vi.mock('../../lib/cloud.js', () => ({
  useDeliveryState: (...a) => useDeliveryState(...a),
  cloudTone: (h) => realCloudTone(h),
  localTone: (r) => realLocalTone(r),
}));
vi.mock('../ClientSwitcher.jsx', () => ({ default: () => null }));

const LAST_RUN = '2026-11-01T08:59:00.000Z';
const state = ({ scope = 'all', cloud = {}, local = {} } = {}) => ({
  scope,
  connected: true,
  cloud: { count: 0, names: [], health: null, reason: null, ...cloud },
  local: { count: 0, names: [], running: true, lastRun: LAST_RUN, ...local },
});
const MIXED = state({
  cloud: { count: 2, names: ['Acme Studio', 'Northwind Bakery'], health: 'green', reason: 'all_confirmed' },
  local: { count: 2, names: ['Corner Cafe', 'Dune Surf'] },
});

function renderSidebar(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nProvider locale="en">
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <Sidebar
            accounts={{ scheduler: { running: delivery.local.running !== false, lastRun: LAST_RUN } }}
            onNavigate={() => {}} onNew={() => {}} onOpenPost={() => {}} onShowOverdue={() => {}}
            setupReady
            {...props}
          />
        </TooltipProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}
const card = () => screen.getByRole('group', { name: 'Delivery' });
const glyph = (channel) => card().querySelector(`[data-channel="${channel}"]`);
const dotOf = (channel) => glyph(channel)?.querySelector('[data-tone]') || null;

beforeEach(() => {
  setSchedulerRunning.mockClear();
  useDeliveryState.mockClear();
});

describe('Sidebar Delivery card', () => {
  it('All projects, 2 cloud + 2 local: both icons with counts and a green cloud dot', () => {
    delivery = MIXED;
    renderSidebar({ allClients: true });
    expect(useDeliveryState).toHaveBeenCalledWith({ allClients: true });
    expect(glyph('cloud')).toHaveTextContent('2');
    expect(glyph('local')).toHaveTextContent('2');
    // Counts are announced in words; the visible digit is decorative.
    expect(within(card()).getByText('On the cloud: 2')).toBeInTheDocument();
    expect(within(card()).getByText('On this computer: 2')).toBeInTheDocument();
    const dot = within(card()).getByRole('img', { name: 'Cloud is delivering' });
    expect(dot.className).toMatch(/\bbg-emerald-500\b/);
    // Local running: no dot on the monitor.
    expect(dotOf('local')).toBeNull();
    // Short sub-line, no redundant words like "Local · active".
    expect(within(card()).getByText(/^Last checked \d{1,2}:\d{2}/)).toBeInTheDocument();
    expect(card().textContent).not.toMatch(/Local · active|Local · paused/);
  });

  it('the cloud before the monitor, side by side in one row', () => {
    delivery = MIXED;
    renderSidebar({ allClients: true });
    const glyphs = card().querySelector('[data-delivery-glyphs]');
    expect([...glyphs.querySelectorAll('[data-channel]')].map((g) => g.dataset.channel)).toEqual(['cloud', 'local']);
  });

  it('the card stays visible when the selected project is on the cloud (it used to hide)', () => {
    delivery = state({ scope: 'one', cloud: { count: 1, names: ['Acme Studio'], health: 'green' } });
    renderSidebar();
    expect(glyph('cloud')).not.toBeNull();
    expect(glyph('local')).toBeNull();
    // One project in view: no count digit.
    expect(glyph('cloud').querySelector('[aria-hidden="true"].tabular-nums')).toBeNull();
  });

  it('single project, local: only the monitor, no dot while running', () => {
    delivery = state({ scope: 'one', local: { count: 1, names: ['Corner Cafe'] } });
    renderSidebar();
    expect(glyph('cloud')).toBeNull();
    expect(glyph('local')).not.toBeNull();
    expect(dotOf('local')).toBeNull();
  });

  it('cloud amber: amber dot named "needs a look" and the short reason as the sub-line', () => {
    delivery = state({
      cloud: { count: 2, names: ['Acme Studio', 'Northwind Bakery'], health: 'amber', reason: 'cloud_unreachable' },
      local: { count: 2, names: ['Corner Cafe', 'Dune Surf'] },
    });
    renderSidebar({ allClients: true });
    const dot = within(card()).getByRole('img', { name: 'Cloud needs a look' });
    expect(dot.className).toMatch(/\bbg-amber-500\b/);
    expect(dot.className).not.toMatch(/emerald/);
    expect(within(card()).getByText('Cloud unreachable')).toBeInTheDocument();
  });

  it('cloud amber: the glyph turns into the alert cloud, the reason line carries the alert icon + attention ink, and the last check stays', () => {
    delivery = state({
      cloud: { count: 2, names: ['Acme Studio', 'Northwind Bakery'], health: 'amber', reason: 'cloud_unreachable' },
      local: { count: 2, names: ['Corner Cafe', 'Dune Surf'] },
    });
    renderSidebar({ allClients: true });
    // Status is never the dot's colour alone: the cloud glyph itself changes shape.
    expect(glyph('cloud').querySelector('svg').getAttribute('class')).toMatch(/lucide-cloud-alert/);
    const reason = card().querySelector('[data-delivery-reason]');
    expect(reason).toHaveTextContent('Cloud unreachable');
    expect(reason.querySelector('svg')).not.toBeNull();
    expect(reason.className).toMatch(/text-amber-700/);
    expect(within(card()).getByText(/^Last checked \d{1,2}:\d{2}/)).toBeInTheDocument();
  });

  // 2.10.0 promised "the delivery card's sub-line no longer truncates in the narrow sidebar"; the
  // worker-stale reason still cut to "Cloud veröffentlicht ni..." at 1280. Every line of the card
  // under the title wraps instead of truncating, in every state (the flow measures it in the
  // browser: scrollWidth <= clientWidth at 1024-1440 and in the 375 drawer).
  it('the cloud reason and the sub-line wrap, never truncate (worker stale, the longest reason)', () => {
    delivery = state({
      cloud: { count: 2, names: ['Acme Studio', 'Northwind Bakery'], health: 'amber', reason: 'worker_stale' },
      local: { count: 2, names: ['Corner Cafe', 'Dune Surf'] },
    });
    renderSidebar({ allClients: true });
    const reason = card().querySelector('[data-delivery-reason]');
    expect(reason).toHaveTextContent('Cloud not publishing');
    const sub = card().querySelector('[data-delivery-sub]');
    expect(sub).toHaveTextContent(/^Last checked/);
    for (const el of [reason, ...reason.querySelectorAll('*'), sub]) {
      expect(el.getAttribute('class') || '').not.toMatch(/(^|\s)(truncate|whitespace-nowrap|text-ellipsis|line-clamp-\d)(\s|$)/);
    }
  });

  it('cloud green: the plain cloud glyph', () => {
    delivery = MIXED;
    renderSidebar({ allClients: true });
    expect(glyph('cloud').querySelector('svg').getAttribute('class')).not.toMatch(/cloud-alert/);
    expect(card().querySelector('[data-delivery-reason]')).toBeNull();
  });

  it('clicking the card (outside the scheduler button) opens the 24/7 Cloud service page', async () => {
    delivery = MIXED;
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    renderSidebar({ allClients: true, onNavigate });
    const open = within(card()).getByRole('button', { name: /Open the 24\/7 cloud service/ });
    await user.click(open);
    expect(onNavigate).toHaveBeenCalledWith('cloud');
    // The scheduler button is a sibling, so pressing it never also navigates.
    onNavigate.mockClear();
    await user.click(within(card()).getByRole('button', { name: 'Pause publishing from this computer' }));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(open.contains(within(card()).getByRole('button', { name: 'Pause publishing from this computer' }))).toBe(false);
  });

  it('the scheduler button shows Pause while running and Play while stopped', () => {
    delivery = MIXED;
    const { unmount } = renderSidebar({ allClients: true });
    const stop = within(card()).getByRole('button', { name: 'Pause publishing from this computer' });
    expect(stop.querySelector('svg').getAttribute('class')).toMatch(/lucide-pause/);
    unmount();
    delivery = state({ scope: 'one', local: { count: 1, names: ['Corner Cafe'], running: false, lastRun: null } });
    renderSidebar({ accounts: { scheduler: { running: false, lastRun: null } } });
    const start = within(card()).getByRole('button', { name: 'Resume publishing' });
    expect(start.querySelector('svg').getAttribute('class')).toMatch(/lucide-play/);
  });

  it('cloud red: red dot named "disrupted"', () => {
    delivery = state({ scope: 'one', cloud: { count: 1, names: ['Acme Studio'], health: 'red', reason: 'cloud_failures' } });
    renderSidebar();
    expect(within(card()).getByRole('img', { name: 'Cloud delivery is disrupted' }).className).toMatch(/\bbg-red-500\b/);
    expect(within(card()).getByText('A cloud publish failed')).toBeInTheDocument();
  });

  it('local paused: amber dot on the monitor, named, and "Paused" as the sub-line', () => {
    delivery = state({ scope: 'one', local: { count: 1, names: ['Corner Cafe'], running: false, lastRun: null } });
    renderSidebar();
    const dot = within(card()).getByRole('img', { name: 'Publishing from this computer is paused' });
    expect(dot.className).toMatch(/\bbg-amber-500\b/);
    expect(glyph('local').contains(dot)).toBe(true);
    expect(within(card()).getByText('Paused')).toBeInTheDocument();
  });

  it('the sub-line reads zinc-600 in light (zinc-500 on the zinc-100 card is 4.40:1, below AA)', () => {
    delivery = state({ scope: 'one', local: { count: 1, names: ['Corner Cafe'], running: false, lastRun: null } });
    renderSidebar();
    const sub = within(card()).getByText('Paused');
    expect(sub.className).toMatch(/(^|\s)text-zinc-600(\s|$)/);
    expect(sub.className).not.toMatch(/(^|\s)text-zinc-500(\s|$)/);
    expect(sub.className).toMatch(/dark:text-zinc-400/);
  });

  it('every dot has an accessible name', () => {
    delivery = state({
      cloud: { count: 1, names: ['Acme Studio'], health: 'red', reason: 'manifest_error' },
      local: { count: 1, names: ['Corner Cafe'], running: false },
    });
    renderSidebar({ allClients: true });
    const dots = card().querySelectorAll('[data-tone]');
    expect(dots.length).toBe(2);
    for (const d of dots) {
      expect(d.getAttribute('role')).toBe('img');
      expect(d.getAttribute('aria-label')).toBeTruthy();
    }
  });

  it('the tooltip names the projects per channel', async () => {
    delivery = MIXED;
    const user = userEvent.setup();
    renderSidebar({ allClients: true });
    await user.hover(card().querySelector('[data-delivery-card]'));
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('Cloud: Acme Studio, Northwind Bakery');
    expect(tip).toHaveTextContent('This computer: Corner Cafe, Dune Surf');
  });

  it('the scheduler stop/start button stays and still toggles', async () => {
    delivery = MIXED;
    const user = userEvent.setup();
    renderSidebar({ allClients: true });
    await user.click(within(card()).getByRole('button', { name: 'Pause publishing from this computer' }));
    expect(setSchedulerRunning).toHaveBeenCalledWith(false);
  });
});

// Polish 2026-11-01: the next-post chip must never advertise a post that will not go out.
describe('Sidebar next-post chip', () => {
  const next = { id: 'n1', campaign: 'launch', type: 'text', title: 'Behind the scenes', platforms: ['linkedin'], scheduledAt: '2099-01-02T14:35:00Z' };
  const chip = () => screen.getByRole('button', { name: /^Next post:/ });

  it('a blocked next post carries the rose alert glyph and says so in its accessible name', () => {
    delivery = MIXED;
    renderSidebar({ nextPost: next, nextPostIssue: { kind: 'blocked', lane: 'linkedin', fix: { type: 'connect', lane: 'linkedin' } } });
    const alert = chip().querySelector('[data-next-alert]');
    expect(alert).not.toBeNull();
    expect(alert.getAttribute('class')).toMatch(/text-rose-700/);
    expect(chip()).toHaveAccessibleName(/Will not go out, needs you$/);
  });

  it('a calm next post has no alert', () => {
    delivery = MIXED;
    renderSidebar({ nextPost: next });
    expect(chip().querySelector('[data-next-alert]')).toBeNull();
    expect(chip()).not.toHaveAccessibleName(/needs you/);
  });
});

// One delivery vocabulary (release polish, 2026-11-01): the sidebar card, its pause/resume
// button, the Needs-you tray row, the header delivery popover and the 24/7 cloud page say what
// happens ("Publishing from this computer is paused"), never the internal word "Scheduler",
// and name this machine one way ("this computer" / "dieser Computer"), never "Rechner" or "Mac".
describe('Delivery vocabulary', () => {
  const SURFACE_KEY = /^(delivery\.|sidebar\.delivery\.|sidebar\.scheduler\.|tray\.system\.|connection\.|cloud\.)/;
  for (const [name, pack, banned] of [
    ['en', enPack, /\bscheduler\b|\bmachine\b|\bMac\b/i],
    ['de-CH', dePack, /scheduler|Rechner|\bMac\b/i],
  ]) {
    it(`${name}: no "Scheduler" and one name for this computer on the delivery surfaces`, () => {
      // `sidebar.scheduler` (the bare key) is rendered nowhere; only its children are copy.
      const offenders = Object.entries(pack.strings)
        .filter(([k, v]) => k !== 'sidebar.scheduler' &&SURFACE_KEY.test(k) && banned.test(v))
        .map(([k]) => k);
      expect(offenders).toEqual([]);
    });
  }
});
