import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import IssueFixButton, { fixLabel } from '../IssueFixButton.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider, makeT } from '../../lib/i18n.js';
import { postIssue } from '../../lib/postIssue.js';

// IssueFixButton is the single place a post's fix runs, where the owner already is. These
// prove the routing the contract names (studio fix flow, section A): a key lane connects in
// a modal right here, an OAuth lane goes to Setup with its reconnect started, a content issue
// offers the agent when one is connected, and an all-projects fix targets the post's project.

let healthData;
const connectPlatformMock = vi.fn(() => Promise.resolve({ ok: true, started: true }));
const connectStatusMock = vi.fn(() => Promise.resolve({ ok: true, state: 'connected' }));
const recheckHealthMock = vi.fn(() => Promise.resolve({ ok: true }));
const agentFixPostMock = vi.fn(() => Promise.resolve({ ok: true, state: 'running' }));

let fixData;
vi.mock('../../lib/agentFix.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useAgentFixes: () => ({ data: fixData }) };
});

vi.mock('../../lib/api.js', () => ({
  useActiveClient: () => ({ activeClientId: 'acme' }),
  usePendpostHealth: () => ({ data: healthData }),
  connectPlatform: (...a) => connectPlatformMock(...a),
  connectStatus: (...a) => connectStatusMock(...a),
  recheckHealth: (...a) => recheckHealthMock(...a),
  agentFixPost: (...a) => agentFixPostMock(...a),
  resumeLane: vi.fn(() => Promise.resolve({ ok: true })),
  markPosted: vi.fn(() => Promise.resolve({ ok: true })),
  deletePost: vi.fn(() => Promise.resolve({ ok: true })),
}));

const failing = (lastFailure, extra = {}) => ({
  id: 'p1', campaign: 'launch', clientId: 'acme', caption: 'Hello', platforms: ['linkedin'], approval: 'approved',
  status: 'planned', derivedState: 'publish-failed', lastFailure: { at: '2026-11-01T08:00:00Z', terminal: true, ...lastFailure }, ...extra,
});
const bskyReply = failing({ lane: 'bluesky', code: 'not_connected', message: 'Bluesky is not connected', recovery: 'reconnect' }, { platforms: ['bluesky'] });
const liRefused = failing({ lane: 'linkedin', code: 'needs_scope', message: 'LinkedIn POST /rest/posts: HTTP 401', recovery: 'reconnect' });
const xTooLong = failing({ lane: 'x', code: 'invalid_input', message: 'tweet is 300 chars', recovery: 'edit' }, { platforms: ['x'] });

function renderButton(post, props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  const onNavigate = vi.fn();
  const onEdit = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <IssueFixButton issue={postIssue(post, null)} post={post} onNavigate={onNavigate} onEdit={onEdit} {...props} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { onNavigate, onEdit, invalidate };
}

beforeEach(() => {
  healthData = { setup: { platforms: [] } };
  fixData = undefined;
  connectPlatformMock.mockClear();
  connectStatusMock.mockClear();
  recheckHealthMock.mockClear();
  agentFixPostMock.mockReset();
  agentFixPostMock.mockImplementation(() => Promise.resolve({ ok: true, state: 'running' }));
});

describe('connect on a key lane: the connect form opens right here', () => {
  it('Bluesky: Connect opens the form in a modal, never Setup, and closes once connected', async () => {
    const user = userEvent.setup();
    const { onNavigate, invalidate } = renderButton(bskyReply);
    const btn = screen.getByRole('button', { name: 'Connect Bluesky' });
    expect(btn).toHaveTextContent(/^Connect$/);
    await user.click(btn);
    expect(onNavigate).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog', { name: 'Connect Bluesky' });
    expect(dialog).toHaveTextContent(/app password/i);
    await user.type(screen.getByLabelText('Handle or email'), 'me.bsky.social');
    await user.type(screen.getByLabelText('App password'), 'aaaa-bbbb-cccc-dddd');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    // The ceremony targets the post's own project.
    await waitFor(() => expect(connectPlatformMock).toHaveBeenCalledWith('bluesky', { identifier: 'me.bsky.social', appPassword: 'aaaa-bbbb-cccc-dddd' }, 'acme'));
    // 'connected' closes the modal and refreshes the posts (their holds were released).
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Connect Bluesky' })).not.toBeInTheDocument());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['plans'] });
    // Bluesky has no health probe: the connect itself was the proof, no extra recheck.
    expect(recheckHealthMock).not.toHaveBeenCalledWith('bluesky', 'acme');
  });

  it('Telegram reconnect (an in-place key lane) opens the same modal and rechecks the lane once connected', async () => {
    const user = userEvent.setup();
    const post = failing({ lane: 'telegram', code: 'engine_failure', message: 'Telegram sendMessage: HTTP 401 - Unauthorized', recovery: 'reconnect' }, { platforms: ['telegram'] });
    const { onNavigate } = renderButton(post);
    await user.click(screen.getByRole('button', { name: 'Reconnect Telegram' }));
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Connect Telegram' })).toBeInTheDocument();
    await user.type(screen.getByLabelText(/bot token/i), '123:abc');
    await user.type(screen.getByLabelText(/channel/i), '@acme');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(recheckHealthMock).toHaveBeenCalledWith('telegram', 'acme'));
  });
});

describe('reconnect on an OAuth lane: Setup with the reconnect started', () => {
  it('LinkedIn calls onNavigate with the reconnect action', async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderButton(liRefused);
    await user.click(screen.getByRole('button', { name: 'Reconnect LinkedIn' }));
    expect(onNavigate).toHaveBeenCalledWith('setup', 'linkedin', { action: 'reconnect' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('edit: the agent when it can, the editor always', () => {
  it('with an agent connected, the fix reads "Fix with agent" and asks the agent; the editor stays the second way', async () => {
    const user = userEvent.setup();
    healthData = { setup: { platforms: [], agent: { connected: true, validation: { state: 'live' } } } };
    const { onEdit, invalidate } = renderButton(xTooLong);
    const fix = screen.getByRole('button', { name: 'Fix with agent' });
    await user.click(fix);
    await waitFor(() => expect(agentFixPostMock).toHaveBeenCalledWith('launch', 'p1', 'acme'));
    // The job list refetches at once, so the running job shows without waiting for a poll.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['agentFix'] });
    expect(await screen.findByText(/your agent is on it/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open in editor' }));
    expect(onEdit).toHaveBeenCalledWith(xTooLong);
  });

  it('a fix already running for the project says so inline, on the same button', async () => {
    const user = userEvent.setup();
    healthData = { setup: { platforms: [], agent: { connected: true, validation: { state: 'live' } } } };
    agentFixPostMock.mockImplementation(() => Promise.reject(Object.assign(new Error('the agent is fixing a post in another project'), { code: 'agent_busy' })));
    renderButton(xTooLong);
    await user.click(screen.getByRole('button', { name: 'Fix with agent' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already fixing a post/i);
    expect(screen.getByRole('button', { name: 'Fix with agent' })).toBeInTheDocument();
  });

  it.each([
    ['agent_unavailable', /no agent is connected/i],
    ['not_fixable', /nothing on this post the agent can fix/i],
    ['in_flight', /publishing right now/i],
  ])('the route refusal %s reads as its own plain sentence', async (code, text) => {
    const user = userEvent.setup();
    healthData = { setup: { platforms: [], agent: { connected: true, validation: { state: 'live' } } } };
    agentFixPostMock.mockImplementation(() => Promise.reject(Object.assign(new Error(`engine: ${code}`), { code })));
    renderButton(xTooLong);
    await user.click(screen.getByRole('button', { name: 'Fix with agent' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
    // The engine line rides the "?" only, never the sentence itself.
    expect(screen.getByRole("alert")).not.toHaveTextContent(`engine: ${code}`);
  });

  it('while the post\'s fix job runs, the button reads "Agent working..." and waits', () => {
    healthData = { setup: { platforms: [], agent: { connected: true, validation: { state: 'live' } } } };
    fixData = { fixes: [{ campaign: 'launch', postId: 'p1', state: 'running', at: '2026-11-01T09:00:00Z' }] };
    renderButton(xTooLong);
    const btn = screen.getByRole('button', { name: /agent working/i });
    expect(btn).toBeDisabled();
  });

  it('a finished job says the next step is approving again', () => {
    healthData = { setup: { platforms: [], agent: { connected: true, validation: { state: 'live' } } } };
    fixData = { fixes: [{ campaign: 'launch', postId: 'p1', state: 'done', summary: 'shortened to 270 chars', at: '2026-11-01T09:00:00Z' }] };
    renderButton(xTooLong);
    expect(screen.getByText(/approve it again/i)).toBeInTheDocument();
  });

  it('a job older than the failure is history and says nothing', () => {
    healthData = { setup: { platforms: [], agent: { connected: true, validation: { state: 'live' } } } };
    fixData = { fixes: [{ campaign: 'launch', postId: 'p1', state: 'failed', at: '2026-10-01T09:00:00Z' }] };
    renderButton(xTooLong);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fix with agent' })).toBeEnabled();
  });

  it('without an agent it is just "Open in editor"', async () => {
    const user = userEvent.setup();
    const { onEdit } = renderButton(xTooLong);
    expect(screen.queryByRole('button', { name: 'Fix with agent' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open in editor' }));
    expect(onEdit).toHaveBeenCalledWith(xTooLong);
    expect(agentFixPostMock).not.toHaveBeenCalled();
  });
});

describe('all projects: the fix targets the post\'s project, never the active one', () => {
  it('a post from another project connects and fixes THAT project', async () => {
    const user = userEvent.setup();
    healthData = { setup: { platforms: [], agent: { connected: true, validation: { state: 'live' } } } };
    renderButton({ ...xTooLong, clientId: 'other' });
    await user.click(screen.getByRole('button', { name: 'Fix with agent' }));
    await waitFor(() => expect(agentFixPostMock).toHaveBeenCalledWith('launch', 'p1', 'other'));
  });

  it('the connect form of another project\'s post writes that project', async () => {
    const user = userEvent.setup();
    renderButton({ ...bskyReply, clientId: 'other' });
    await user.click(screen.getByRole('button', { name: 'Connect Bluesky' }));
    await user.type(screen.getByLabelText('Handle or email'), 'x.bsky.social');
    await user.type(screen.getByLabelText('App password'), 'p');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(connectPlatformMock).toHaveBeenCalledWith('bluesky', { identifier: 'x.bsky.social', appPassword: 'p' }, 'other'));
    await waitFor(() => expect(connectStatusMock).toHaveBeenCalledWith('bluesky', 'other'));
  });
});

describe('fixLabel', () => {
  const t = makeT('de-CH');
  it('names each fix in plain words (the tray reuses it)', () => {
    expect(fixLabel(postIssue(bskyReply), t)).toBe('Verbinden');
    expect(fixLabel(postIssue(liRefused), t)).toBe('Neu verbinden');
    expect(fixLabel(postIssue(xTooLong), t)).toBe('Im Editor öffnen');
    expect(fixLabel(postIssue(xTooLong), t, { agent: true })).toBe('Mit Agent beheben');
    expect(fixLabel(null, t)).toBe('');
  });
});
