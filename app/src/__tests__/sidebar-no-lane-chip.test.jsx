import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Sidebar from '../components/Sidebar.jsx';
import { TooltipProvider } from '../components/ui/Tooltip.jsx';
import { I18nProvider } from '../lib/i18n.js';

vi.mock('../lib/api.js', () => ({
  setSchedulerRunning: vi.fn(() => Promise.resolve({ ok: true })),
  useSignals: () => ({ data: null }),
}));
// No cloud: one project, publishing from this computer, scheduler running.
vi.mock('../lib/cloud.js', () => ({
  useDeliveryState: () => ({
    scope: 'one',
    connected: false,
    cloud: { count: 0, names: [], health: null, reason: null },
    local: { count: 1, names: ['Acme'], running: true, lastRun: '2026-09-26T08:02:00.000Z' },
  }),
  cloudTone: () => null,
  localTone: (running) => (running === false ? 'paused' : null),
}));
vi.mock('../components/ClientSwitcher.jsx', () => ({ default: () => null }));

function renderSidebar(props) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nProvider locale="de-CH">
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <Sidebar onNavigate={() => {}} onNew={() => {}} onOpenPost={() => {}} onShowOverdue={() => {}} {...props} />
        </TooltipProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

// Lanes in every tone the old rail chip painted: a failed probe (red), a
// not-connected lane (amber) and a healthy one (green).
const accounts = {
  meta: { configured: true, pageId: 'p', igUserId: 'i', live: { ok: true } },
  linkedin: { authenticated: true, live: { ok: false, detail: 'token expired' } },
  x: { authenticated: false },
  scheduler: { running: true },
};
const posting = { enabledPlatforms: ['facebook', 'instagram', 'linkedin', 'x'] };

// Final judge, blocker 2: the rail carried a textless chip (colour dot plus lane
// logos) that stated lane health by colour alone and spent green on a state that
// was not all-clear. The Einrichtung badge and the "Wartet auf dich" slot already
// carry that state in words, so the chip is gone.
describe('Sidebar without the textless lane-health chip', () => {
  it('renders no accounts chip and no colour status dot for lanes', () => {
    const { container } = renderSidebar({ accounts, posting, setupReady: false, setupIncomplete: 2 });
    expect(screen.queryByRole('button', { name: /Konten & Status/ })).toBeNull();
    // No lane-health dot in any tone anywhere in the rail.
    expect(container.querySelector('.bg-emerald-500, .bg-amber-500')).toBeNull();
  });

  it('keeps the lane state in words on the Einrichtung nav badge', () => {
    renderSidebar({ accounts, posting, setupReady: false, setupIncomplete: 2 });
    expect(screen.getByText('2', { selector: 'span[aria-hidden="true"]' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Einrichtung/ })).toHaveTextContent(/2/);
  });
});

// Phase 3 Tier-3 sweep: no "60s" or "Zyklus" anywhere in the rail. Contract B (owner
// 2026-11-01, "clear icons, not more redundant text"): the monitor glyph says "this computer",
// so the sub-line is only the short "Zuletzt geprüft 10:02" (polish 2026-11-01: plainer than
// "Letzter Lauf"), without the old "Lokal · aktiv".
describe('Sidebar delivery line', () => {
  it('reads only the short last run, no "Lokal · aktiv", no cycle jargon', () => {
    const { container } = renderSidebar({
      accounts: { ...accounts, scheduler: { running: true, lastRun: '2026-09-26T08:02:00.000Z' } },
      posting,
      setupReady: true,
      setupIncomplete: 0,
    });
    const card = screen.getByRole('group', { name: 'Zustellung' });
    expect(card.textContent).toMatch(/Zuletzt geprüft \d{2}:\d{2}/);
    expect(card.textContent).not.toMatch(/Letzter Lauf/);
    expect(card.textContent).not.toMatch(/Lokal · aktiv/);
    expect(container.textContent).not.toMatch(/60s|Zyklus|60-Sekunden/);
  });
});

// Studio fix flow (owner pick q5 a, 2026-11-01): the rail's red "Wartet auf dich: n" pill is
// gone. The header badge carries the one count and opens the planner's "Braucht dich" tray,
// so the rail no longer repeats it, even when an old caller still hands it the summary.
describe('Sidebar without the "Waiting on you" pill', () => {
  it('renders no attention pill, whatever the caller passes', () => {
    const { container } = renderSidebar({ accounts, posting, setupReady: true, setupIncomplete: 0, attention: { kind: 'needs-you', count: 3 } });
    expect(screen.queryByText(/Wartet auf dich/)).toBeNull();
    expect(screen.queryByText(/Überfällig/)).toBeNull();
    expect(container.querySelector('.animate-ping')).toBeNull();
  });
});
