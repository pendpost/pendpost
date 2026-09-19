import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import ActivityView from '../Activity.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Spec 51 (D2): a row carrying entry.attest (stamped by lib/receipts.mjs onto the
// publish row) renders a 13px ShieldCheck glyph after the action label, with a
// title/aria-label naming the signing key. A row with no attest renders no glyph.
// No new filter or ACTION_GROUPS entry - just this one glyph on the existing row.
const ACTIVITY = [
  { ts: '2026-06-16T09:00:00.000Z', action: 'publish-reel', ok: true, platform: 'instagram', campaign: 'acme', postId: 'r1', attest: { kid: 'abc123def4567890', sig: 'deadbeefcafe' } },
  { ts: '2026-06-16T05:00:00.000Z', action: 'publish-text', ok: true, platform: 'x', campaign: 'acme', postId: 'x1' },
];

vi.mock('../../lib/api.js', () => ({
  useActivity: () => ({ data: { activity: ACTIVITY }, isLoading: false, isError: false }),
}));

function renderActivity(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ActivityView active platformFilter={[]} failuresOnly={false} actionGroups={[]} onOpenPost={() => {}} {...props} />
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('Activity attest glyph (spec 51 D2)', () => {
  it('renders a shield glyph with a key-naming label on a row carrying attest', () => {
    renderActivity();
    const glyph = screen.getByLabelText('Signed receipt, key abc123def4567890');
    expect(glyph).toBeTruthy();
  });

  it('renders no glyph on a row with no attest', () => {
    renderActivity();
    // Strengthened: assert the COUNT so this fails if the `entry.attest ?` guard is
    // ever removed and every row starts rendering a glyph (a query for a specific,
    // non-existent label would pass either way).
    expect(screen.getAllByLabelText(/^Signed receipt, key /)).toHaveLength(1);
  });

  it('has no axe violations with the attest glyph present', async () => {
    const { container } = renderActivity();
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
