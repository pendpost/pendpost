import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import NeedsYou from '../radar/NeedsYou.jsx';
import { I18nProvider, useT } from '../../lib/i18n.js';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { recheckTiming, MIN_BUSY_MS } from '../../lib/useRecheck.js';

// The login ask's "Check again": while it checks it says "Checking" (not "Sending"), the
// spinner holds for the minimum, a pass says "Logged in" (not "Sent"), and a second identical
// "still not logged in" is dated as a new check.

let asksData;
let loading = false;
let isError = false;
const refetchMock = vi.fn();
const answerMock = vi.fn(() => Promise.resolve({ ok: true, confirm: false }));
const confirmMock = vi.fn(() => Promise.resolve({ ok: true }));
const dismissMock = vi.fn(() => Promise.resolve({ ok: true }));
const probeMock = vi.fn(() => Promise.resolve({ ok: true, usable: true }));
const markCopyPostedMock = vi.fn(() => Promise.resolve({ ok: true }));

vi.mock('../../lib/api.js', async (importOriginal) => { const real = await importOriginal(); return {
  useEngageAsks: () => ({ data: asksData, isLoading: loading, isError, refetch: refetchMock }),
  useActiveClient: () => ({ activeClient: { id: 'acme', displayName: 'Acme' }, activeClientId: 'acme' }),
  engageAnswer: (...a) => answerMock(...a),
  engageConfirmAsk: (...a) => confirmMock(...a),
  engageDismiss: (...a) => dismissMock(...a),
  engageProbe: (...a) => probeMock(...a),
  radarMarkCopyPosted: (...a) => markCopyPostedMock(...a),
  // The REAL error helpers (the one plain path), never a stub that could drift from it.
  errText: real.errText,
  errAlert: real.errAlert,
  errReason: real.errReason,
}; });

const ask = (over = {}) => ({
  id: 'ask-1',
  kind: 'question',
  status: 'open',
  lane: 'reddit',
  signalKey: 'reddit e1',
  actionId: null,
  question: 'Is the reviewer link included in Starter?',
  draft: 'Per client. Each brand has its own approval gate.',
  finalText: '',
  reasonLine: '',
  urgent: false,
  answer: '',
  createdAt: '2026-09-09T06:00:00.000Z',
  resolvedAt: null,
  signal: {
    source: 'reddit', externalId: 'e1', author: 'sam_builds', community: 'r/selfhosted',
    text: 'Does it do approval per client or only global?', url: 'https://example.test/e1', intentScore: 84,
  },
  ...over,
});

function Harness() {
  const t = useT();
  return <NeedsYou enabled t={t} />;
}
function renderStrip() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <Harness />
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  asksData = { ok: true, asks: [ask({ id: 'l1', kind: 'login', lane: 'linkedin', question: '', draft: '', signal: null })] };
  probeMock.mockReset().mockResolvedValue({ ok: true, usable: false, reason: 'not_logged_in' });
});

describe('NeedsYou Check again', () => {
  it('says Checking while it runs and holds it for the minimum', async () => {
    recheckTiming.minBusyMs = MIN_BUSY_MS;
    const user = userEvent.setup();
    renderStrip();
    const row = screen.getByRole('listitem');
    await user.click(within(row).getByRole('button', { name: 'Check again' }));
    await new Promise((r) => { setTimeout(r, MIN_BUSY_MS / 2); });
    const busy = within(row).getByRole('button', { name: 'Checking' });
    expect(busy).toBeDisabled();
    expect(within(row).queryByText('Sending')).toBeNull();
    expect(await within(row).findByRole('alert', {}, { timeout: 2000 })).toHaveTextContent('Still not logged in.');
  });

  it('dates a second identical "still not logged in"', async () => {
    const user = userEvent.setup();
    renderStrip();
    const row = screen.getByRole('listitem');
    await user.click(within(row).getByRole('button', { name: 'Check again' }));
    await within(row).findByRole('alert');
    await user.click(await within(row).findByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(within(row).getByRole('alert')).toHaveTextContent(/checked again at .+, no change/i));
  });

  it('a pass says Logged in, not Sent', async () => {
    probeMock.mockResolvedValue({ ok: true, usable: true });
    const user = userEvent.setup();
    renderStrip();
    await user.click(within(screen.getByRole('listitem')).getByRole('button', { name: 'Check again' }));
    expect(await screen.findByText('Logged in')).toBeInTheDocument();
    expect(screen.queryByText('Sent')).toBeNull();
  });
});
