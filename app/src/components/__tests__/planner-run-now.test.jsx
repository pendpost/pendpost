import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import PlannerRunNow from '../PlannerRunNow.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// B6 — planner Run-now. The header button now OPENS a review dialog
// (PlannerRunNowDialog) instead of publishing on one click: the dialog lists the
// posts the scheduler would fire now (isDueNow), pre-selects them all, and the
// owner picks a subset before the per-post publish loop runs. A recorded Meta-368
// still disables the button (the blocked lane is never poked). The dialog IS the
// confirmation; runPublishDue({campaign, postId}) is looped over the selection.

const runPublishDue = vi.fn(() => Promise.resolve({ ok: true }));

vi.mock('../../lib/api.js', () => ({
  runPublishDue: (...args) => runPublishDue(...args),
}));

// The server's 368 blocker line (lib/writes.mjs pendpostHealth blockers push), verbatim.
const BLOCKER_368 = 'Meta action block active (recorded 2026-06-10T08:00:00.000Z; clear it manually once Meta lifts it)';

// A post the scheduler would fire now: approved + overdue + a local render.
const duePost = (id, over = {}) => ({
  campaign: 'c',
  id,
  type: 'reel',
  approval: 'approved',
  derivedState: 'overdue',
  platforms: ['instagram'],
  scheduledAt: '2026-06-19T08:00:00.000Z',
  title: null,
  caption: `Caption ${id}`,
  media: { exists: true, cover: null, url: null },
  image: null,
  ...over,
});
const campaignsWith = (...posts) => [{ id: 'c', active: true, posts }];

function renderRunNow({ pendpostHealth, campaigns = [], onCheckReadiness = vi.fn(), clientName } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <I18nProvider locale="en">
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <ConfirmProvider>
            <PlannerRunNow pendpostHealth={pendpostHealth} campaigns={campaigns} onCheckReadiness={onCheckReadiness} clientName={clientName} />
          </ConfirmProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
  return { ...utils, qc, onCheckReadiness };
}

const HEALTHY = { ok: true, ready: true, schedulerRunning: true, blockers: [], nextDue: [] };
const BLOCKED = { ok: true, ready: false, schedulerRunning: true, blockers: [BLOCKER_368], nextDue: [] };

// The header button (aria "Run due posts now") opens the dialog; the dialog's run
// button is "Run due now (N)". The regexes below keep them unambiguous.
const openDialog = async (user) => user.click(screen.getByRole('button', { name: /run due posts now/i }));
const runBtn = () => screen.getByRole('button', { name: /run due now \(/i });

beforeEach(() => {
  runPublishDue.mockReset();
  runPublishDue.mockResolvedValue({ ok: true });
});

describe('PlannerRunNow', () => {
  it('with a recorded Meta-368 blocker: the button is disabled and clicking never publishes', async () => {
    const user = userEvent.setup();
    renderRunNow({ pendpostHealth: BLOCKED, campaigns: campaignsWith(duePost('a')) });

    expect(screen.getByText(/Meta action block active/i)).toBeInTheDocument();
    const btn = screen.queryByRole('button', { name: /run due posts now/i });
    if (btn) expect(btn).toBeDisabled();

    const check = screen.getByRole('button', { name: /check readiness/i });
    await user.click(check);
    if (btn) await user.click(btn);
    // No dialog opens and nothing publishes.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(runPublishDue).not.toHaveBeenCalled();
  });

  it('clicking opens the review dialog listing the due posts and publishes nothing yet', async () => {
    const user = userEvent.setup();
    renderRunNow({ pendpostHealth: HEALTHY, campaigns: campaignsWith(duePost('a'), duePost('b')) });

    await openDialog(user);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Caption a');
    expect(dialog).toHaveTextContent('Caption b');
    expect(runPublishDue).not.toHaveBeenCalled();
  });

  it('runs the pre-selected posts, each scoped by { campaign, postId }', async () => {
    const user = userEvent.setup();
    renderRunNow({ pendpostHealth: HEALTHY, campaigns: campaignsWith(duePost('a'), duePost('b')) });

    await openDialog(user);
    await screen.findByRole('dialog');
    await user.click(runBtn());

    await waitFor(() => expect(runPublishDue).toHaveBeenCalledTimes(2));
    const scopes = runPublishDue.mock.calls.map(([s]) => s);
    expect(scopes).toContainEqual({ campaign: 'c', postId: 'a' });
    expect(scopes).toContainEqual({ campaign: 'c', postId: 'b' });
  });

  it('deselecting a post excludes it from the run', async () => {
    const user = userEvent.setup();
    renderRunNow({ pendpostHealth: HEALTHY, campaigns: campaignsWith(duePost('a'), duePost('b')) });

    await openDialog(user);
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('checkbox', { name: /select caption a/i }));
    await user.click(runBtn());

    await waitFor(() => expect(runPublishDue).toHaveBeenCalledTimes(1));
    expect(runPublishDue).toHaveBeenCalledWith({ campaign: 'c', postId: 'b' });
  });

  it('shows an empty state and a disabled run button when nothing is due', async () => {
    const user = userEvent.setup();
    // A pending post is not due (fail-closed), so the list is empty.
    renderRunNow({ pendpostHealth: HEALTHY, campaigns: campaignsWith(duePost('a', { approval: 'pending' })) });

    await openDialog(user);
    await screen.findByRole('dialog');
    expect(screen.getByText(/nothing due/i)).toBeInTheDocument();
    expect(runBtn()).toBeDisabled();
  });

  it('in_flight (HTTP 423) stops with a friendly message and no auto-retry', async () => {
    const user = userEvent.setup();
    runPublishDue.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'in_flight' }));
    renderRunNow({ pendpostHealth: HEALTHY, campaigns: campaignsWith(duePost('a'), duePost('b')) });

    await openDialog(user);
    await screen.findByRole('dialog');
    await user.click(runBtn());

    expect(await screen.findByText(/already in progress/i)).toBeInTheDocument();
    expect(screen.queryByText(/423/)).not.toBeInTheDocument();
    // Stopped after the first attempt: the second selected post is never poked.
    await waitFor(() => expect(runPublishDue).toHaveBeenCalledTimes(1));
  });

  it('needs_confirm re-prompts and retries the post once with confirm', async () => {
    const user = userEvent.setup();
    runPublishDue
      .mockRejectedValueOnce(Object.assign(new Error('confirmation required'), { code: 'needs_confirm' }))
      .mockResolvedValueOnce({ ok: true });
    renderRunNow({ pendpostHealth: HEALTHY, campaigns: campaignsWith(duePost('a')) });

    await openDialog(user);
    await screen.findByRole('dialog');
    await user.click(runBtn());

    // The server escalation confirm appears; continuing retries the same post.
    await user.click(await screen.findByRole('button', { name: /continue/i }));
    await waitFor(() => expect(runPublishDue).toHaveBeenCalledTimes(2));
  });

  it('on full success invalidates the activity and plans queries and closes the dialog', async () => {
    const user = userEvent.setup();
    const { qc } = renderRunNow({ pendpostHealth: HEALTHY, campaigns: campaignsWith(duePost('a')) });
    const spy = vi.spyOn(qc, 'invalidateQueries');

    await openDialog(user);
    await screen.findByRole('dialog');
    await user.click(runBtn());

    await waitFor(() => expect(runPublishDue).toHaveBeenCalled());
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({ queryKey: ['activity'] });
      expect(spy).toHaveBeenCalledWith({ queryKey: ['plans'] });
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('has no axe violations (healthy, dialog closed)', async () => {
    const { container } = renderRunNow({ pendpostHealth: HEALTHY, campaigns: campaignsWith(duePost('a')) });
    expect(await axeClean(container)).toHaveNoViolations();
  });

  it('has no axe violations (blocked)', async () => {
    const { container } = renderRunNow({ pendpostHealth: BLOCKED, campaigns: campaignsWith(duePost('a')) });
    expect(await axeClean(container)).toHaveNoViolations();
  });

  it('has no axe violations with the review dialog open', async () => {
    const user = userEvent.setup();
    const { container } = renderRunNow({ pendpostHealth: HEALTHY, campaigns: campaignsWith(duePost('a'), duePost('b')) });
    await openDialog(user);
    await screen.findByRole('dialog');
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
