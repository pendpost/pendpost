import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Freigaben from '../Freigaben.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// The advisory brand-lint badge must be exactly that: ADVISORY. Rendering it on a
// card whose caption trips a severity:'error' brand rule must NOT disable the
// Approve/Reject actions - the gate lives server-side in lib/scheduler.mjs and is
// byte-untouched. We mock the write/read layer so the test asserts enablement,
// not the network. lintText returns a tripping envelope so the badge appears.
const approvePost = vi.fn(() => Promise.resolve({ ok: true }));
const rejectPost = vi.fn(() => Promise.resolve({ ok: true }));
const lintText = vi.fn(() =>
  Promise.resolve({ ok: true, clean: false, errors: 1, warnings: 0, findings: [{ rule: 'banned', severity: 'error', match: 'x', index: 0, hint: 'no' }] }),
);

vi.mock('../../lib/api.js', () => ({
  approvePost: (...a) => approvePost(...a),
  rejectPost: (...a) => rejectPost(...a),
  lintText: (...a) => lintText(...a),
}));

const campaigns = [
  {
    id: 'spring',
    active: true,
    posts: [
      {
        id: 'p1',
        campaign: 'spring',
        title: 'Spring promo',
        caption: 'a caption that trips a brand rule',
        platforms: ['instagram', 'linkedin'],
        approval: 'pending',
        derivedState: 'draft',
        scheduledAt: '2026-07-01T10:00:00Z',
        type: 'reel',
      },
    ],
  },
];

function renderFreigaben() {
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

beforeEach(() => {
  approvePost.mockClear();
  rejectPost.mockClear();
  lintText.mockClear();
});

describe('Freigaben advisory brand-lint badge', () => {
  it('shows the advisory error badge yet keeps Approve and Reject fully enabled (advisory, not a gate)', async () => {
    renderFreigaben();
    // Badge surfaces (errors>0 on a target platform).
    expect(await screen.findByRole('status')).toBeInTheDocument();
    // The advisory badge does NOT disable the actions.
    const approve = screen.getByRole('button', { name: /approve/i });
    const reject = screen.getByRole('button', { name: /reject/i });
    expect(approve).toBeEnabled();
    expect(reject).toBeEnabled();
  });

  it('has no axe violations with the badge present', async () => {
    const { container } = renderFreigaben();
    await screen.findByRole('status');
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
