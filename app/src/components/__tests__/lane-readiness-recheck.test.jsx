import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import LaneReadinessLine from '../radar/LaneReadinessLine.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { recheckTiming, MIN_BUSY_MS } from '../../lib/useRecheck.js';

// "Check again" on a not-logged-in / wrong-account lane: the state word does not change while
// the probe runs, so before this a click only greyed the button for a frame and the line came
// back identical. Now it spins (at least the minimum), then dates what it found.
const engageProbeMock = vi.fn();
vi.mock('../../lib/api.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    engageProbe: (...a) => engageProbeMock(...a),
    engageConfirmHandle: vi.fn(),
    resumeLane: vi.fn(),
    errText: real.errText,
    errAlert: real.errAlert,
    errReason: real.errReason,
  };
});

function renderLine() {
  return render(
    <I18nProvider locale="en">
      <TooltipProvider>
        <LaneReadinessLine lane="linkedin" label="LinkedIn" clientName="Acme" runtime={{ reason: 'not_logged_in' }} onRefresh={() => {}} />
      </TooltipProvider>
    </I18nProvider>,
  );
}
const btn = () => screen.getByRole('button', { name: 'Check again' });

beforeEach(() => { engageProbeMock.mockReset().mockResolvedValue({ ok: true, usable: false, reason: 'not_logged_in' }); });

describe('LaneReadinessLine Check again', () => {
  it('spins for the minimum, then says when it checked', async () => {
    recheckTiming.minBusyMs = MIN_BUSY_MS;
    const user = userEvent.setup();
    renderLine();
    await user.click(btn());
    expect(btn()).toBeDisabled();
    expect(btn()).toHaveAttribute('aria-busy', 'true');
    await new Promise((r) => { setTimeout(r, MIN_BUSY_MS / 2); });
    expect(btn()).toHaveAttribute('aria-busy', 'true');
    expect(await screen.findByText(/^Checked at .+\.$/, {}, { timeout: 2000 })).toBeInTheDocument();
  });

  it('dates a second identical answer as a new check', async () => {
    const user = userEvent.setup();
    renderLine();
    await user.click(btn());
    await screen.findByText(/^Checked at .+\.$/);
    await waitFor(() => expect(btn()).not.toBeDisabled());
    await user.click(btn());
    expect(await screen.findByText(/checked again at .+, no change/i)).toBeInTheDocument();
  });

  it('a repeated identical failure is dated too', async () => {
    engageProbeMock.mockRejectedValue(new TypeError('Load failed'));
    const user = userEvent.setup();
    renderLine();
    await user.click(btn());
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Could not check LinkedIn\. Could not reach your local pendpost\. Is it running\?$/);
    await waitFor(() => expect(btn()).not.toBeDisabled());
    await user.click(btn());
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/checked again at .+, no change/i));
  });
});
