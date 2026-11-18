import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Setup from '../Setup.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// Fix 7 (judge pass 2, C2): the cloud popover's "Reconnect" lands on the lane in Setup.
// The lane's EXISTING status chip then names the cloud's reason ("Cloud: no account
// connected") instead of a generic "Incomplete" - a relabel, never a second chip. The
// reason is read from the same cloud roll-up (sync.issues[] kind 'credential') and only
// for the ACTIVE project.
let cloudIssues;
let activeId;
let plansData;
let laneValidation;
const disconnectPlatformMock = vi.fn(() => Promise.resolve({ ok: true }));
vi.mock('../../lib/cloud.js', () => ({
  useCapabilities: () => ({ data: undefined }),
  useCloud: () => ({ data: { workspaceId: 'ws_1', apiKey: { present: true }, sync: { state: 'red', issues: cloudIssues } } }),
  useCloudClients: () => ({ data: { clients: [{ clientId: 'acme', active: activeId === 'acme' }, { clientId: 'globex', active: activeId === 'globex' }] } }),
}));

const lane = {
  platform: 'linkedin', label: 'LinkedIn', status: 'incomplete', mode: 'mock', connected: false, skipped: false,
  get validation() { return laneValidation; },
  missing: [{ kind: 'secret', label: 'a token', how: 'cli', action: 'node scripts/linkedin-social.mjs auth' }],
  connectAction: 'node scripts/linkedin-social.mjs auth',
  playbook: { portalUrl: 'https://www.linkedin.com/developers/apps', appToCreate: 'an app', productsToAdd: [], scopes: [], steps: [] },
};
vi.mock('../../lib/api.js', () => ({
  usePendpostHealth: () => ({ data: { ok: true, ready: false, setup: { ok: true, ready: false, summary: { connected: 0, validated: 0, skipped: 0, incomplete: 1, total: 1 }, config: { locale: 'en' }, platforms: [lane] } }, isLoading: false, isError: false }),
  useSignals: () => ({ data: undefined, isLoading: false }),
  usePlans: () => ({ data: plansData }),
  useConfig: () => ({ data: { ok: true, rev: 'r1', identifiers: {}, posting: { locale: 'en', platforms: { linkedin: true }, skippedPlatforms: [] }, secrets: {} }, isLoading: false }),
  useAccounts: () => ({ data: {} }),
  useActiveClient: () => ({ activeClient: { displayName: 'Acme' } }),
  useDiscover: () => ({ data: undefined, isLoading: true }),
  saveConfig: vi.fn(), recheckHealth: vi.fn(), connectPlatform: vi.fn(), connectStatus: vi.fn(),
  setMetaLane: vi.fn(), refreshLinkedinToken: vi.fn(), refreshXToken: vi.fn(), disconnectPlatform: (...a) => disconnectPlatformMock(...a),
  mastodonUpdateProfile: vi.fn(), nostrUpdateProfile: vi.fn(), telegramUpdateProfile: vi.fn(), youtubeUpdateProfile: vi.fn(),
}));

function renderSetup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ConfirmProvider>
          <Setup focus="linkedin" />
        </ConfirmProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const credential = (clientId) => ({ clientId, kind: 'credential', lane: 'linkedin', code: 'account_unresolved', campaign: 'c', postId: 'p' });

beforeEach(() => {
  activeId = 'acme'; cloudIssues = []; plansData = undefined;
  laneValidation = { state: 'unproven', ok: null, detail: null, checkedAt: null, fix: null };
});

describe('Setup: cloud credential refusal relabels the lane chip', () => {
  it('names the cloud reason on the chip (and in the rail) instead of "Incomplete"', () => {
    cloudIssues = [credential('acme')];
    renderSetup();
    const card = within(screen.getByRole('region', { name: 'LinkedIn' }));
    expect(card.getByText('Cloud: no account connected')).toBeInTheDocument();
    expect(card.queryByText('Incomplete')).not.toBeInTheDocument();
    // The rail row's accessible name carries the same reason (status is never colour-only).
    expect(screen.getByRole('button', { name: /LinkedIn.*Cloud: no account connected/ })).toBeInTheDocument();
  });

  it('a refusal in ANOTHER project does not relabel this project\'s lane', () => {
    cloudIssues = [credential('globex')];
    renderSetup();
    expect(screen.queryByText('Cloud: no account connected')).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'LinkedIn' })).getByText('Incomplete')).toBeInTheDocument();
  });
});

// Judge round 2 (K1 step 3): "Neu verbinden" on a post whose LOCAL publish failed on the
// lane's own credential (lastFailure.recovery 'reconnect', lib/publish-hold.mjs) lands here.
// The same existing chip names why the owner is here (a relabel from the plans read the
// app already polls, never a second chip); the full sentence rides the chip tooltip.
const failedPost = (lastFailure) => ({ id: 'p1', derivedState: 'publish-failed', platforms: ['linkedin'], lastFailure });
const needsScope = { code: 'needs_scope', lane: 'linkedin', message: 'needs_scope: w_member_social', at: '2026-09-25T10:00:00Z', terminal: true, recovery: 'reconnect', halted: false };

describe('Setup: a local credential failure relabels the lane chip', () => {
  // D9: the failure sentence is visible text under the chip (it used to live only in the chip's
  // tooltip); the chip is just its status word and drops the tooltip that would repeat it.
  it('names the reason on the chip and in the rail, the failure sentence visible under it', () => {
    plansData = { campaigns: [{ id: 'launch', posts: [failedPost(needsScope)] }] };
    renderSetup();
    const card = within(screen.getByRole('region', { name: 'LinkedIn' }));
    expect(card.getByText('Permission missing')).toBeInTheDocument();
    expect(card.queryByRole('button', { name: 'Permission missing' })).toBeNull();
    expect(card.getAllByText('LinkedIn needs a permission the connection does not have. Reconnecting fixes it.')).toHaveLength(1);
    expect(card.queryByText('Incomplete')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /LinkedIn.*Permission missing/ })).toBeInTheDocument();
  });

  it('an expired login reads "Login expired"', () => {
    plansData = { campaigns: [{ id: 'launch', posts: [failedPost({ ...needsScope, code: null, message: 'HTTP 401 Unauthorized' })] }] };
    renderSetup();
    expect(within(screen.getByRole('region', { name: 'LinkedIn' })).getByText('Login expired')).toBeInTheDocument();
  });

  it('ignores failures that are not reconnect-first, and ones a later live check already cleared', () => {
    plansData = { campaigns: [{ id: 'launch', posts: [failedPost({ ...needsScope, recovery: 'edit' })] }] };
    const { unmount } = renderSetup();
    expect(within(screen.getByRole('region', { name: 'LinkedIn' })).getByText('Incomplete')).toBeInTheDocument();
    unmount();
    plansData = { campaigns: [{ id: 'launch', posts: [failedPost(needsScope)] }] };
    laneValidation = { state: 'live', ok: true, detail: null, checkedAt: '2026-09-25T11:00:00Z', fix: null };
    renderSetup();
    expect(screen.queryByText('Permission missing')).not.toBeInTheDocument();
  });

  // Judge final2 (item 2): on an INCOMPLETE lane the chip's tooltip promises "Reconnecting fixes
  // it", so the connect route is open, not folded away behind "Set up manually", and its button
  // says what it does.
  it('an incomplete lane with a reconnect refusal shows the connect route, labelled Reconnect', () => {
    plansData = { campaigns: [{ id: 'launch', posts: [failedPost(needsScope)] }] };
    renderSetup();
    const card = within(screen.getByRole('region', { name: 'LinkedIn' }));
    expect(card.getByRole('button', { name: /set up manually/i })).toHaveAttribute('aria-expanded', 'true');
    expect(card.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    expect(card.queryByRole('button', { name: 'Connect' })).toBeNull();
  });

  it('a cloud refusal for the same lane still wins', () => {
    plansData = { campaigns: [{ id: 'launch', posts: [failedPost(needsScope)] }] };
    cloudIssues = [credential('acme')];
    renderSetup();
    const card = within(screen.getByRole('region', { name: 'LinkedIn' }));
    expect(card.getByText('Cloud: no account connected')).toBeInTheDocument();
    expect(card.queryByText('Permission missing')).not.toBeInTheDocument();
  });
});

// Judge final2 (item 2): a CONNECTED lane whose last post failed on its credential used to show
// the chip "Permission missing" above the sentence "The connection has expired", and a tooltip
// that promised "Reconnecting fixes it" over a panel whose only action was "Copy prompt". ONE
// failure now drives both (the chip's precedence: the local refusal, which is a reconnect by
// definition, outranks the probe), and the card offers the reconnect it promises.
describe('Setup: chip, sentence and action agree on a connected lane', () => {
  beforeEach(() => {
    lane.status = 'connected'; lane.connected = true; lane.missing = [];
  });
  afterEach(() => {
    lane.status = 'incomplete'; lane.connected = false;
    lane.missing = [{ kind: 'secret', label: 'a token', how: 'cli', action: 'node scripts/linkedin-social.mjs auth' }];
  });

  it('the sentence names the same failure as the chip, and Reconnect replaces Disconnect', () => {
    plansData = { campaigns: [{ id: 'launch', posts: [failedPost(needsScope)] }] };
    laneValidation = { state: 'failed', ok: false, detail: 'invalid_grant: token revoked', checkedAt: '2026-09-25T09:00:00Z', fix: null };
    renderSetup();
    const card = within(screen.getByRole('region', { name: 'LinkedIn' }));
    // The chip is just its word: its tooltip would only repeat the sentence printed below it.
    expect(card.getByText('Permission missing')).toBeInTheDocument();
    expect(card.getAllByText('LinkedIn needs a permission the connection does not have. Reconnecting fixes it.')).toHaveLength(1);
    expect(card.queryByText(/has expired/)).toBeNull();
    expect(card.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
    expect(card.queryByRole('button', { name: 'Disconnect' })).toBeNull();
    // The debug prompt stays, as the secondary path.
    expect(card.getByRole('button', { name: /copy debug and fix prompt for linkedin/i })).toBeInTheDocument();
  });

  it('a live probe older than the refusal no longer claims "ready to publish" under the refusal chip', () => {
    plansData = { campaigns: [{ id: 'launch', posts: [failedPost(needsScope)] }] };
    laneValidation = { state: 'live', ok: true, detail: null, checkedAt: '2026-09-25T09:00:00Z', fix: null };
    renderSetup();
    const card = within(screen.getByRole('region', { name: 'LinkedIn' }));
    expect(card.getByText('Permission missing')).toBeInTheDocument();
    expect(card.getByText('LinkedIn needs a permission the connection does not have. Reconnecting fixes it.')).toBeInTheDocument();
    expect(card.queryByText(/ready to publish/)).toBeNull();
    expect(card.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
  });

  it('an expired probe with no refusal offers Reconnect too (the sentence says "Reconnect LinkedIn")', () => {
    laneValidation = { state: 'failed', ok: false, detail: 'token expired', checkedAt: '2026-09-25T09:00:00Z', fix: null };
    renderSetup();
    const card = within(screen.getByRole('region', { name: 'LinkedIn' }));
    expect(card.getByText('The connection has expired. Reconnect LinkedIn.')).toBeInTheDocument();
    expect(card.getByRole('button', { name: 'Reconnect' })).toBeInTheDocument();
  });

  it('a failure a reconnect cannot fix keeps Disconnect and offers no Reconnect', () => {
    laneValidation = { state: 'failed', ok: false, detail: 'HTTP 429 Too Many Requests', checkedAt: '2026-09-25T09:00:00Z', fix: null };
    renderSetup();
    const card = within(screen.getByRole('region', { name: 'LinkedIn' }));
    expect(card.queryByRole('button', { name: 'Reconnect' })).toBeNull();
    expect(card.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
  });

  // A user who clicked "Reconnect" is asked to reconnect, never "Disconnect LinkedIn?": the
  // ceremony underneath is still the disconnect, but its confirm speaks the reconnect.
  it('Reconnect runs the existing disconnect ceremony behind its own reconnect confirm', async () => {
    plansData = { campaigns: [{ id: 'launch', posts: [failedPost(needsScope)] }] };
    laneValidation = { state: 'failed', ok: false, detail: 'token expired', checkedAt: '2026-09-25T09:00:00Z', fix: null };
    const user = userEvent.setup();
    renderSetup();
    await user.click(within(screen.getByRole('region', { name: 'LinkedIn' })).getByRole('button', { name: 'Reconnect' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('Reconnect LinkedIn?')).toBeInTheDocument();
    expect(dialog.getByText('pendpost removes the current connection, and you connect LinkedIn again in the next step.')).toBeInTheDocument();
    expect(dialog.queryByText(/Disconnect/)).toBeNull();
    expect(dialog.queryByRole('button', { name: 'Disconnect' })).toBeNull();
    await user.click(dialog.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(disconnectPlatformMock).toHaveBeenCalledWith('linkedin'));
  });

  it('cancelling the reconnect confirm keeps the connection', async () => {
    disconnectPlatformMock.mockClear();
    plansData = { campaigns: [{ id: 'launch', posts: [failedPost(needsScope)] }] };
    const user = userEvent.setup();
    renderSetup();
    await user.click(within(screen.getByRole('region', { name: 'LinkedIn' })).getByRole('button', { name: 'Reconnect' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.click(dialog.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(disconnectPlatformMock).not.toHaveBeenCalled();
  });
});
