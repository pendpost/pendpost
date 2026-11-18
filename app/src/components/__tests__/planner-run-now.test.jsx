import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import { usePlannerRunNow } from '../PlannerRunNow.jsx';
import { RowMenu } from '../ui/RowMenu.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// B6 — planner Run-now. The header button now OPENS a review dialog
// (PlannerRunNowDialog) instead of publishing on one click: the dialog lists the
// posts the scheduler would fire now (isDueNow), pre-selects them all, and the
// owner picks a subset before the per-post publish loop runs. A recorded Meta-368
// still disables the button (the blocked lane is never poked). The dialog IS the
// confirmation; runPublishDue({campaign, postId}) is looped over the selection.

// The server's per-lane truth: a resolved call carries a matching ok `ran` row
// (an HTTP 200 without one now reads as "nothing fired", by design).
const ranRowFor = (scope = {}) => ({ ok: true, ran: [{ campaign: scope.campaign, postId: scope.postId, lane: 'x', ok: true }] });
const runPublishDue = vi.fn((scope) => Promise.resolve(ranRowFor(scope)));

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
// A YouTube video already uploaded but left private past its publishAt: run-now
// flips it public (derivedState 'verify-failed' + verify youtube 'private-overdue').
const releasePost = (id, over = {}) => ({
  campaign: 'c',
  id,
  type: 'youtube-short',
  approval: 'approved',
  derivedState: 'verify-failed',
  platforms: ['youtube'],
  scheduledAt: '2026-06-29T07:00:00.000Z',
  title: null,
  caption: `Caption ${id}`,
  media: { exists: true, cover: null, url: null },
  image: null,
  verify: { platforms: { youtube: { live: false, state: 'private-overdue' } } },
  ...over,
});
// Approved but scheduled in the FUTURE (waiting-due) - "ready" but NOT due now.
const futurePost = (id) => duePost(id, { derivedState: 'waiting-due', scheduledAt: '2099-01-01T09:00:00.000Z' });
const campaignsWith = (...posts) => [{ id: 'c', active: true, posts }];

// Since the Nov 2026 header diet the run-now gate is a pair of items in the header's overflow
// menu (App.jsx); this harness renders the same hook into the same RowMenu.
function RunNowMenu(props) {
  const { items, dialog } = usePlannerRunNow(props);
  return (
    <>
      <RowMenu label="More" items={items} />
      {dialog}
    </>
  );
}

function renderRunNow({ pendpostHealth, campaigns = [], onCheckReadiness = vi.fn(), clientName } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <I18nProvider locale="en">
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <ConfirmProvider>
            <RunNowMenu pendpostHealth={pendpostHealth} campaigns={campaigns} onCheckReadiness={onCheckReadiness} clientName={clientName} />
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
const openMenu = async (user) => user.click(screen.getByRole('button', { name: 'More' }));
const openDialog = async (user) => { await openMenu(user); await user.click(screen.getByRole('menuitem', { name: /run due posts now/i })); };
const runBtn = () => screen.getByRole('button', { name: /run due now \(/i });

beforeEach(() => {
  runPublishDue.mockReset();
  runPublishDue.mockImplementation((scope) => Promise.resolve(ranRowFor(scope)));
});

describe('PlannerRunNow', () => {
  it('with a recorded Meta-368 blocker: the button is disabled and clicking never publishes', async () => {
    const user = userEvent.setup();
    renderRunNow({ pendpostHealth: BLOCKED, campaigns: campaignsWith(duePost('a')) });

    await openMenu(user);
    const btn = screen.getByRole('menuitem', { name: /run due posts now/i });
    expect(btn).toBeDisabled();
    await user.click(btn);

    await user.click(screen.getByRole('menuitem', { name: /check readiness/i }));
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

  it('a genuine lane failure wins over the halt marker on a mixed post (Fix A)', async () => {
    const user = userEvent.setup();
    // The run drops X (lane_halted marker) AND genuinely fails Instagram: the actionable
    // IG reason must surface, not "resume the lane".
    runPublishDue.mockResolvedValueOnce({ ok: true, ran: [
      { campaign: 'c', postId: 'a', lane: 'x', ok: false, errorCode: 'lane_halted', errorMessage: 'x paused (credits)' },
      { campaign: 'c', postId: 'a', lane: 'instagram', ok: false, errorCode: 'engine_failure', errorMessage: 'instagram upload rejected: no public URL' },
    ] });
    renderRunNow({ pendpostHealth: HEALTHY, campaigns: campaignsWith(duePost('a')) });

    await openDialog(user);
    await screen.findByRole('dialog');
    await user.click(runBtn());

    // The lane's failure says a plain sentence naming the lane; the engine's English line
    // rides the "?" only, never the summary.
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('0 published, 1 failed: a (Instagram did not accept the post.)');
    expect(alert).not.toHaveTextContent(/upload rejected/);
    expect(screen.getByRole('button', { name: /more about this/i })).toHaveAccessibleDescription('a: instagram upload rejected: no public URL');
    expect(screen.queryByText(/paused because the credits are used up/i)).not.toBeInTheDocument();
  });

  it('a cloud_claim_wait marker says the cloud already has the post, never the 20-minute backstop promise', async () => {
    const user = userEvent.setup();
    // The fail-closed hold: the cloud has the post and cannot answer the publish claim, so
    // nothing goes out locally until it answers. The cloud_held copy would be false here.
    runPublishDue.mockResolvedValueOnce({ ok: true, ran: [
      { campaign: 'c', postId: 'a', lane: 'meta', ok: false, errorCode: 'cloud_claim_wait', errorMessage: 'the cloud already has this post' },
    ] });
    renderRunNow({ pendpostHealth: HEALTHY, campaigns: campaignsWith(duePost('a')) });
    await openDialog(user);
    await screen.findByRole('dialog');
    await user.click(runBtn());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/won't publish it from here until the cloud answers/i);
    expect(alert).not.toHaveTextContent(/20 minutes/);
  });

  it('a message-less failure still names the post in the plain summary', async () => {
    const user = userEvent.setup();
    runPublishDue.mockRejectedValueOnce(new Error());
    renderRunNow({ pendpostHealth: HEALTHY, campaigns: campaignsWith(duePost('a')) });
    await openDialog(user);
    await screen.findByRole('dialog');
    await user.click(runBtn());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('0 published, 1 failed: a');
    expect(alert).not.toHaveTextContent(/Error/);
  });

  it('an English server error is not in the summary; it rides the "?" only', async () => {
    const user = userEvent.setup();
    runPublishDue.mockRejectedValueOnce(new Error('HTTP 500 internal'));
    renderRunNow({ pendpostHealth: HEALTHY, campaigns: campaignsWith(duePost('a')) });
    await openDialog(user);
    await screen.findByRole('dialog');
    await user.click(runBtn());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('0 published, 1 failed: a');
    expect(alert).not.toHaveTextContent(/HTTP 500/);
    expect(screen.getByRole('button', { name: /more about this/i })).toHaveAccessibleDescription('a: HTTP 500 internal');
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

    // The server escalation confirm appears (the Studio's own sentence, never the engine
    // line); continuing retries the same post.
    const confirmDialog = await screen.findByRole('dialog', { name: /confirm publish run/i });
    expect(confirmDialog).toHaveTextContent('The server needs an explicit confirmation to run the publish. Continue?');
    expect(confirmDialog).not.toHaveTextContent(/confirmation required/);
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

  it('lists a private-overdue YouTube video as a release row and runs it (the run-now recovery)', async () => {
    const user = userEvent.setup();
    renderRunNow({ pendpostHealth: HEALTHY, campaigns: campaignsWith(releasePost('yt1')) });

    await openDialog(user);
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Caption yt1');
    // The row is labelled as a make-public action, not a generic publish.
    expect(dialog).toHaveTextContent(/make public/i);

    await user.click(runBtn());
    await waitFor(() => expect(runPublishDue).toHaveBeenCalledWith({ campaign: 'c', postId: 'yt1' }));
  });

  it('does NOT count future waiting-due posts (the old tooltip overcount): empty dialog', async () => {
    const user = userEvent.setup();
    renderRunNow({ pendpostHealth: HEALTHY, campaigns: campaignsWith(futurePost('a'), futurePost('b')) });

    await openDialog(user);
    await screen.findByRole('dialog');
    expect(screen.getByText(/nothing due/i)).toBeInTheDocument();
    expect(runBtn()).toBeDisabled();
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
