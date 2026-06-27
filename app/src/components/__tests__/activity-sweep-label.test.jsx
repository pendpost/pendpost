import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import ActivityCheckNow from '../ActivityCheckNow.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// B8 (US-PUB-01): the Activity sweep control used to read "Check now" - a vague
// label for what is in fact a real publish sweep (publish_due_run publishes every
// approved, due post for the active client now, no undo). B8 relabels it to an
// HONEST i18n string ("Publish due now") routed via t() for idle/loading/success/
// error. Behavior is UNCHANGED: it still raises the B4 confirm and only then calls
// the mocked runPublishDue() + invalidates activity+plans. Copy honesty only.

const runPublishDue = vi.fn(() => Promise.resolve({ ok: true }));
let activeState;

vi.mock('../../lib/api.js', () => ({
  runPublishDue: (...args) => runPublishDue(...args),
  useActiveClient: () => activeState,
}));

function renderControl(locale = 'en') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nProvider locale={locale}>
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <ConfirmProvider>
            <ActivityCheckNow />
          </ConfirmProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  runPublishDue.mockReset();
  runPublishDue.mockResolvedValue({ ok: true });
  activeState = {
    activeClient: { id: 'acme', displayName: 'Acme Retail', status: 'active', accent: '#22566d' },
    activeClientId: 'acme',
  };
});

describe('Activity sweep control honest relabel (B8)', () => {
  it('the idle label is the honest publish string and NOT the old vague "Check now"', () => {
    renderControl();
    expect(screen.getByRole('button', { name: /publish due now/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /check now/i })).not.toBeInTheDocument();
  });

  it('de-CH renders the honest German label (never the English literal, never an eszett)', () => {
    renderControl('de-CH');
    const btn = screen.getByRole('button');
    // Whatever the de-CH copy is, it must be real German (umlauts allowed) and not
    // the English "Check now" literal leaking through.
    expect(btn.textContent).not.toMatch(/check now/i);
    expect(btn.textContent).not.toMatch(/ß/); // Mandate A: Swiss German never uses the eszett
  });

  it('clicking still raises the confirm and, on confirm, calls the mocked runPublishDue()', async () => {
    const user = userEvent.setup();
    renderControl();

    await user.click(screen.getByRole('button', { name: /publish due now/i }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toBeInTheDocument();
    // Behavior unchanged: nothing publishes until the human confirms.
    expect(runPublishDue).not.toHaveBeenCalled();

    const confirmBtn = within(dialog).getByRole('button', { name: /publish|confirm/i });
    await user.click(confirmBtn);
    await waitFor(() => expect(runPublishDue).toHaveBeenCalledTimes(1));
  });

  it('has no axe violations', async () => {
    const { container } = renderControl();
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
