import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePostActions } from '../usePostActions.js';
import { bulkPlan } from '../bulkPlan.js';
import { canApproveNow } from '../postActions.js';
import AppToast from '../../components/AppToast.jsx';
import { ConfirmProvider } from '../../components/ui/confirm.jsx';
import { TooltipProvider } from '../../components/ui/Tooltip.jsx';
import { I18nProvider } from '../i18n.js';

// ONE "can approve" check (planner judge round 2, item 7): the row's ⋯ menu offered Freigeben on
// a LinkedIn post the List's bulk bar refused (LinkedIn not connected: approving publishes
// nothing there). canApproveNow is the one answer, and both surfaces read it.

const approvePostMock = vi.fn();
vi.mock('../api.js', () => ({
  approvePost: (...a) => approvePostMock(...a),
  rejectPost: vi.fn(),
  verifyPost: vi.fn(),
  deletePost: vi.fn(),
  unschedulePost: vi.fn(),
  runPublishDue: vi.fn(),
  reschedulePost: vi.fn(),
  resumeLane: vi.fn(),
}));

function wrapper({ children }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <I18nProvider locale="de-CH">
        <TooltipProvider>
          <ConfirmProvider>{children}</ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}

function withToast({ children }) {
  return wrapper({ children: <>{children}<AppToast /></> });
}

const setup = { platforms: [{ platform: 'linkedin', status: 'incomplete' }, { platform: 'x', status: 'connected' }] };
const base = { campaign: 'c', executionMode: 'fully-scheduled', scheduledAt: '2099-01-01T09:00:00Z', derivedState: 'scheduled' };
const POSTS = [
  { ...base, id: 'li-pending', platforms: ['linkedin'], approval: 'pending' },
  { ...base, id: 'li-draft', platforms: ['linkedin'], approval: 'draft' },
  { ...base, id: 'x-pending', platforms: ['x'], approval: 'pending' },
  { ...base, id: 'x-approved', platforms: ['x'], approval: 'approved' },
  { ...base, id: 'x-edited', platforms: ['x'], approval: 'approved', editedSinceApproval: true },
  { ...base, id: 'x-posted', platforms: ['x'], approval: 'approved', derivedState: 'posted' },
  { ...base, id: 'both-pending', platforms: ['x', 'linkedin'], approval: 'pending' },
];

const menuOffersApprove = (post) => {
  const { result } = renderHook(() => usePostActions(post, { setup }), { wrapper });
  return result.current.items.some((i) => i.key === 'approve');
};

describe('canApproveNow: the one approve gate', () => {
  it('needs an approvable post AND no unconnected lane', () => {
    expect(canApproveNow(POSTS[2], { offlineLanes: [] })).toBe(true);
    expect(canApproveNow(POSTS[0], { offlineLanes: ['linkedin'] })).toBe(false);
    expect(canApproveNow(POSTS[3], { offlineLanes: [] })).toBe(false);
    expect(canApproveNow(POSTS[5], { offlineLanes: [] })).toBe(false);
  });

  it('the row menu never offers Freigeben on a post whose lane is not connected', () => {
    expect(menuOffersApprove(POSTS[0])).toBe(false);
    expect(menuOffersApprove(POSTS[6])).toBe(false);
    expect(menuOffersApprove(POSTS[2])).toBe(true);
  });

  it('the row menu and the bulk bar agree on every post', () => {
    const plan = bulkPlan(POSTS, { setupFor: () => setup });
    for (const post of POSTS) {
      expect(menuOffersApprove(post), post.id).toBe(plan.approvable.includes(post));
    }
  });
});

// Item 10: the single-row approve says the retime, with the bulk bar's sentence.
describe('the row menu approve of a past-due Radar reply', () => {
  it('toasts that it goes out 5 minutes after the approval, naming it', async () => {
    approvePostMock.mockResolvedValue({ ok: true });
    const reply = { ...base, id: 'r1', platforms: ['x'], approval: 'pending', caption: 'Antwort an Anna', radarReplyTo: { url: 'https://x.com/a/status/1', source: 'x' }, scheduledAt: new Date(Date.now() - 3600_000).toISOString() };
    const { result } = renderHook(() => usePostActions(reply, { setup }), { wrapper: withToast });
    await act(async () => { await result.current.items.find((i) => i.key === 'approve').run(); });
    expect((await screen.findByRole('status')).textContent).toBe('Freigegeben. Der Termin war vorbei, darum 5 Minuten nach der Freigabe: Antwort an Anna');
  });

  it('stays silent for a reply still ahead of its time', async () => {
    approvePostMock.mockResolvedValue({ ok: true });
    const reply = { ...base, id: 'r2', platforms: ['x'], approval: 'pending', caption: 'Später', radarReplyTo: { url: 'https://x.com/a/status/2', source: 'x' }, scheduledAt: new Date(Date.now() + 3600_000).toISOString() };
    const { result } = renderHook(() => usePostActions(reply, { setup }), { wrapper: withToast });
    await act(async () => { await result.current.items.find((i) => i.key === 'approve').run(); });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
