import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import ReadinessChecklist from '../ReadinessChecklist.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider, makeT } from '../../lib/i18n.js';

// US-ONB-09: readiness blockers must be calm, clickable rows that deep-link to
// Setup (no dead ends), the redundant "next due" overview is removed (the
// calendar carries it), and on the Planner the panel is collapsible so the
// calendar dominates.
let healthState;
vi.mock('../../lib/api.js', () => ({
  usePendpostHealth: () => ({ data: healthState, isLoading: false, isError: false }),
  setSchedulerRunning: vi.fn(() => Promise.resolve({ ok: true })),
}));

function renderChecklist(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ReadinessChecklist {...props} />
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  healthState = {
    ok: true, ready: false, schedulerRunning: true,
    blockers: ['Meta credentials not configured', 'LinkedIn not authenticated'],
    nextDue: [
      { campaign: 'acme', postId: 'reel-99', scheduledAt: '2026-06-20T09:00:00.000Z', platforms: ['instagram'], blockers: ['approval: draft'], type: 'reel', caption: 'Hi', media: { cover: null, url: null }, image: null },
    ],
  };
});

describe('ReadinessChecklist clickable blockers + no nextDue (US-ONB-09)', () => {
  it('renders blocker rows as buttons that deep-link to Setup', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    renderChecklist({ onNavigate });
    await user.click(screen.getByRole('button', { name: /Meta credentials not configured/i }));
    expect(onNavigate).toHaveBeenCalledWith('setup');
  });

  it('no longer renders the redundant "next due" overview', () => {
    renderChecklist();
    expect(screen.queryByText('reel-99')).not.toBeInTheDocument();
  });

  it('when collapsible, hides the blockers until expanded', async () => {
    const user = userEvent.setup();
    renderChecklist({ collapsible: true });
    expect(screen.queryByText('Meta credentials not configured')).not.toBeInTheDocument();
    // With two blockers seeded, the collapsed toggle names the count via
    // t('readiness.expandCount', { count }); resolve it through the live t() so
    // this holds whether or not the new key has been merged into locales yet.
    const expandName = makeT('en')('readiness.expandCount', { count: 2 });
    await user.click(screen.getByRole('button', { name: expandName }));
    expect(screen.getByText('Meta credentials not configured')).toBeInTheDocument();
  });

  it('exposes the hidden blocker count in the collapsed toggle accessible name', () => {
    // An explicit aria-label overrides the descendant badge text, so the bare
    // numeral is never announced; the count must live IN the accessible name.
    // beforeEach seeds two blockers, so the collapsed toggle names that count via
    // t('readiness.expandCount', { count: 2 }) - compared against the live t() so
    // the assertion holds whether or not the new key has been merged into locales.
    const expected = makeT('en')('readiness.expandCount', { count: 2 });
    renderChecklist({ collapsible: true });
    expect(screen.getByRole('button', { name: expected })).toBeInTheDocument();
    // The visual badge is aria-hidden, so the count is announced exactly once.
    expect(screen.queryByRole('button', { name: /^show readiness$/i })).not.toBeInTheDocument();
  });

  it('has no axe violations with clickable blockers', async () => {
    const { container } = renderChecklist({ onNavigate: vi.fn() });
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
