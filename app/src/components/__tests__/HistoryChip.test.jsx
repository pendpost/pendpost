import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// HistoryChip (spec 49 R12, §5.1): the quiet "Nth exchange" marker. It renders ONLY at
// exchangeCount >= 2 (S1a/S1b), shows a "forgotten" indicator + un-forget for a tombstone
// (S6u), and never a broken node for a null/corrupt read (S9e). The api.js module is mocked
// so the chip is driven purely by the record shape the hook returns.

let engagerState;
const unforgetMock = vi.fn(() => Promise.resolve({ ok: true }));

vi.mock('../../lib/api.js', () => ({
  useEngager: () => engagerState,
  unforgetEngager: (...a) => unforgetMock(...a),
  forgetEngager: vi.fn(() => Promise.resolve({ ok: true })),
  linkEngagers: vi.fn(() => Promise.resolve({ ok: true })),
  unlinkEngagers: vi.fn(() => Promise.resolve({ ok: true })),
  dismissLinkGuess: vi.fn(() => Promise.resolve({ ok: true })),
}));

import HistoryChip from '../HistoryChip.jsx';

function renderChip(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <HistoryChip lane="mastodon" handle="jane" {...props} />
    </QueryClientProvider>,
  );
}

const record = (count) => ({
  data: {
    ok: true,
    engager: { lane: 'mastodon', handle: 'jane', handleNorm: 'jane', exchangeCount: count, exchanges: Array.from({ length: count }, (_, i) => ({ kind: 'comment', ts: `2026-08-0${i + 1}T00:00:00Z`, direction: 'they', excerpt: `msg ${i}` })) },
    suggestions: [],
    links: [],
  },
});

describe('HistoryChip', () => {
  beforeEach(() => { unforgetMock.mockClear(); engagerState = undefined; });

  it('renders NO chip at exchangeCount < 2 (a single interaction is a stranger, S1b)', () => {
    engagerState = record(1);
    const { container } = renderChip();
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(/exchange/i)).toBeNull();
  });

  it('renders NO chip when the read returns no record (null / corrupt, S9e/S2b)', () => {
    engagerState = { data: { ok: true, engager: null, suggestions: [], links: [] } };
    const { container } = renderChip();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the exact ordinal chip at exchangeCount >= 2 (S1a)', () => {
    engagerState = record(3);
    renderChip();
    expect(screen.getByText('3rd exchange')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'See our history' })).toBeInTheDocument();
  });

  it('opens the history popover on click (one popover, the chip is the trigger)', async () => {
    const user = userEvent.setup();
    engagerState = record(2);
    renderChip();
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'See our history' }));
    expect(screen.getByRole('dialog', { name: 'Our history' })).toBeInTheDocument();
  });

  it('shows a "forgotten" indicator + un-forget for a tombstoned key (S6u), never a history chip', async () => {
    const user = userEvent.setup();
    engagerState = { data: { ok: true, engager: { lane: 'mastodon', handleNorm: 'jane', forgotten: true, forgottenTs: '2026-08-01T00:00:00Z' }, suggestions: [], links: [] } };
    renderChip();
    expect(screen.getByText('forgotten')).toBeInTheDocument();
    expect(screen.queryByText(/exchange/i)).toBeNull();
    const btn = screen.getByRole('button', { name: /allow again/i });
    await user.click(btn);
    expect(unforgetMock).toHaveBeenCalledWith('mastodon', 'jane');
  });

  it('keeps only ONE popover open across chips (S1c)', async () => {
    const user = userEvent.setup();
    engagerState = record(2);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <HistoryChip lane="mastodon" handle="jane" slot="a" />
        <HistoryChip lane="mastodon" handle="jane" slot="b" />
      </QueryClientProvider>,
    );
    const [chipA, chipB] = screen.getAllByRole('button', { name: 'See our history' });
    await user.click(chipA);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    await user.click(chipB);
    // opening B closes A: still exactly one popover on the page.
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
  });
});
