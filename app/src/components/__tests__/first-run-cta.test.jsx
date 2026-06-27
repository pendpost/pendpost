import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import FirstRunEmptyState from '../FirstRunEmptyState.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// US-ONB-08: the first-run screen must guide a non-technical owner - no decorative
// "React icon", and a real next action (connect a platform) beyond the single
// create-campaign field.
vi.mock('../../lib/api.js', () => ({
  createCampaign: vi.fn(() => Promise.resolve({ ok: true })),
  usePendpostHealth: () => ({
    data: { ok: true, ready: false, schedulerRunning: false, blockers: ['Meta credentials not configured'], nextDue: [] },
    isLoading: false, isError: false,
  }),
  setSchedulerRunning: vi.fn(() => Promise.resolve({ ok: true })),
}));

function renderEmpty(onNavigate = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <FirstRunEmptyState onNavigate={onNavigate} />
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { ...utils, onNavigate };
}

describe('FirstRunEmptyState onboarding CTAs (US-ONB-08)', () => {
  it('renders no decorative Sparkles icon', () => {
    const { container } = renderEmpty();
    expect(container.querySelector('.lucide-sparkles')).toBeNull();
  });

  it('offers a "Connect a platform" action that navigates to Setup', async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderEmpty();
    await user.click(screen.getByRole('button', { name: /connect a platform/i }));
    expect(onNavigate).toHaveBeenCalledWith('setup');
  });

  it('has no axe violations', async () => {
    const { container } = renderEmpty();
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
