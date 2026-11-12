import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FixButton } from '../CloudIssues.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import { recheckTiming, MIN_BUSY_MS } from '../../lib/useRecheck.js';

// The cloud "Check again" (FixButton): a fast probe still shows its spinner, a second "not
// yet" in the same minute is dated as a new check (not the old line left standing), and a
// failed check says why when the reason is known.
const recheckCloud = vi.fn();
vi.mock('../../lib/cloud.js', () => ({
  recheckCloud: (...a) => recheckCloud(...a),
  pushCloud: vi.fn(),
  useSetCloudSync: () => vi.fn(),
}));

const STILL = { ok: true, checkedAt: '2026-10-16T08:05:00.000Z', reached: false, sync: { issues: [{ kind: 'unreachable' }] } };

function renderFix() {
  return render(
    <I18nProvider locale="en">
      <TooltipProvider>
        <FixButton gone={() => false} />
      </TooltipProvider>
    </I18nProvider>,
  );
}
const btn = () => screen.getByRole('button', { name: 'Check again' });

beforeEach(() => { recheckCloud.mockReset(); });

describe('FixButton Check again', () => {
  it('holds the spinner for the minimum on a fast probe', async () => {
    recheckTiming.minBusyMs = MIN_BUSY_MS;
    recheckCloud.mockResolvedValue(STILL);
    const user = userEvent.setup();
    renderFix();
    await user.click(btn());
    await new Promise((r) => { setTimeout(r, MIN_BUSY_MS / 2); });
    expect(btn()).toHaveAttribute('aria-busy', 'true');
    expect(await screen.findByText(/^Not yet · /, {}, { timeout: 2000 })).toBeInTheDocument();
  });

  it('dates a second identical "not yet"', async () => {
    recheckCloud.mockResolvedValue(STILL);
    const user = userEvent.setup();
    renderFix();
    await user.click(btn());
    await screen.findByText(/^Not yet · /);
    await waitFor(() => expect(btn()).not.toBeDisabled());
    await user.click(btn());
    expect(await screen.findByText(/checked again at .+, no change/i)).toBeInTheDocument();
  });

  it('a failed check says the known reason, and the button stays to retry', async () => {
    recheckCloud.mockRejectedValue(Object.assign(new Error('timed out'), { code: 'timeout' }));
    const user = userEvent.setup();
    renderFix();
    await user.click(btn());
    expect(await screen.findByText(/took too long to answer/i)).toBeInTheDocument();
    await waitFor(() => expect(btn()).not.toBeDisabled());
  });
});
