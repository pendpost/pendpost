import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, screen, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePostActions } from '../usePostActions.js';
import AppToast from '../../components/AppToast.jsx';
import { ConfirmProvider } from '../../components/ui/confirm.jsx';
import { TooltipProvider } from '../../components/ui/Tooltip.jsx';
import { I18nProvider } from '../i18n.js';
import { recheckTiming } from '../useRecheck.js';

// The row menu's Verify / Re-check closes the menu on click, so its whole story is the toast:
// a spinner notice while it reads back, then what came back (live on N of M, or not live yet).
// Before, a not-live answer said nothing at all and the click read as dead.

const deletePostMock = vi.fn();
const approvePostMock = vi.fn();
const verifyPostMock = vi.fn();
const unschedulePostMock = vi.fn();
const resumeLaneMock = vi.fn();
const runPublishDueMock = vi.fn();

vi.mock('../api.js', () => ({
  approvePost: (...a) => approvePostMock(...a),
  rejectPost: vi.fn(),
  verifyPost: (...a) => verifyPostMock(...a),
  deletePost: (...a) => deletePostMock(...a),
  unschedulePost: (...a) => unschedulePostMock(...a),
  runPublishDue: (...a) => runPublishDueMock(...a),
  reschedulePost: vi.fn(),
  resumeLane: (...a) => resumeLaneMock(...a),
}));

function wrapper({ children }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            {children}
            <AppToast />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}

const row = { id: 'p1', campaign: 'launch', approval: 'approved', executionMode: 'fully-scheduled', scheduledAt: '2026-06-01T10:00:00Z', derivedState: 'verify-failed', verify: { ok: false } };

beforeEach(() => { verifyPostMock.mockReset(); });

function verifyItem() {
  const { result } = renderHook(() => usePostActions(row), { wrapper });
  return result.current.items.find((i) => i.key === 'verify');
}

describe('usePostActions verify: the toast says it ran and what came back', () => {
  it('shows a progress notice while the read-back runs', async () => {
    recheckTiming.minBusyMs = 40;
    let resolve;
    verifyPostMock.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const item = verifyItem();
    let pending;
    act(() => { pending = item.run(); });
    expect(await screen.findByRole('status')).toHaveTextContent(/verifying/i);
    await act(async () => { resolve({ ok: true, liveCount: 1, checked: 2 }); await pending; });
    expect(screen.getByRole('status')).toHaveTextContent('Verify complete: 1 of 2 platforms live.');
  });

  it('a not-live answer is said, not swallowed', async () => {
    verifyPostMock.mockResolvedValue({ ok: true, liveCount: 0, checked: 1 });
    const item = verifyItem();
    await act(async () => { await item.run(); });
    expect(await screen.findByRole('alert')).toHaveTextContent(/did not read back as live/i);
  });
});
