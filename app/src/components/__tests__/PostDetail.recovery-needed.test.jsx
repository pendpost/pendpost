import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PostDetail from '../PostDetail.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Retry honesty. A failure the engine classifies with a recovery (lib/publish-hold.mjs
// failureRecovery -> post.lastFailure.recovery) is refused again on every publish, so the
// failure panel must neither say "tries again on its own" nor offer "Publish now" /
// "Try again". It names the one action that recovers it, reusing an existing verb:
//   reconnect -> "Reconnect" (Setup, focused on that lane - the cloud issue row's action)
//   manual    -> "Copy and post yourself", then "Mark as posted" (the hand-off pair)
//   edit      -> "Open in editor"

// Mutable per test: a setup payload whose LinkedIn row is incomplete makes LinkedIn an
// offline (hand-off) lane, which is what put the "paste it yourself" route beside Reconnect.
let healthData;

vi.mock('../../lib/api.js', () => ({
  useInsights: () => ({ data: undefined }),
  useActiveClient: () => ({ activeClient: { id: 'acme', displayName: 'Acme Retail', accent: '#22566d' }, activeClientId: 'acme' }),
  usePendpostHealth: () => ({ data: healthData }),
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: { meta: { paused: false } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePresubmitCheck: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useAssets: () => ({ data: { dir: 'data/media', assets: [] } }),
  approvePost: vi.fn(),
  rejectPost: vi.fn(),
  runPublishDue: vi.fn(() => Promise.resolve({ ran: [] })),
  deletePost: vi.fn(() => Promise.resolve({ ok: true })),
  unschedulePost: vi.fn(),
  reschedulePost: vi.fn(() => Promise.resolve({ ok: true })),
  markPosted: vi.fn(() => Promise.resolve({ ok: true })),
  verifyPost: vi.fn(() => Promise.resolve({ ok: true })),
  setCoverFrame: vi.fn(),
  uploadCover: vi.fn(),
  clearCover: vi.fn(),
  updatePost: vi.fn(),
  editPublished: vi.fn(),
  discordScheduleEvent: vi.fn(),
  mastodonPin: vi.fn(),
  resumeLane: vi.fn(),
}));

const base = {
  id: 'p1',
  campaign: 'launch',
  caption: 'Hello world',
  platforms: ['linkedin'],
  approval: 'approved',
  status: 'planned',
  scheduledAt: '2026-06-01T10:00:00Z',
  type: 'text',
  rev: 1,
  executionMode: 'fully-scheduled',
  image: null,
  ids: {},
  cover: null,
  publishedVia: null,
  externalUrl: null,
  verify: null,
  derivedState: 'publish-failed',
  media: { file: null, exists: true, bytes: 10, url: null, cover: null, path: null },
};

const credentialPost = {
  ...base,
  lastFailure: { lane: 'linkedin', at: '2026-06-01T10:03:00Z', code: 'account_unresolved', message: 'Nothing was published: ...', terminal: true, recovery: 'reconnect', halted: false, haltCode: null },
};

// A LOCAL credential failure (reconnect-first, lib/publish-hold.mjs isCredentialFailure):
// the engine's own needs_scope on the first attempt, held, recovery reconnect.
const localScopePost = {
  ...base,
  id: 'p4',
  platforms: ['linkedin'],
  publishHold: { at: '2026-06-01T10:03:00Z', lane: 'linkedin', code: 'needs_scope', message: 'LinkedIn POST /rest/posts: HTTP 403 ACCESS_DENIED - missing w_organization_social' },
  attempts: [{ ts: '2026-06-01T10:03:00Z', platform: 'linkedin', action: 'publish', ok: false, errorCode: 'needs_scope', errorMessage: 'LinkedIn POST /rest/posts: HTTP 403 ACCESS_DENIED - missing w_organization_social' }],
  lastFailure: { lane: 'linkedin', at: '2026-06-01T10:03:00Z', code: 'needs_scope', message: 'LinkedIn POST /rest/posts: HTTP 403 ACCESS_DENIED - missing w_organization_social', terminal: true, recovery: 'reconnect', halted: false, haltCode: null },
};

const X_REPLY = 'X POST /tweets: HTTP 403 - You can only reply to or quote posts where you are mentioned or are the author.';
const xReplyPost = {
  ...base,
  id: 'p2',
  platforms: ['x'],
  caption: 'Thanks, that matches what we saw.',
  radarReplyTo: { source: 'x', externalId: '123', url: 'https://x.com/someone/status/123', author: '@someone' },
  publishHold: { at: '2026-06-01T10:03:00Z', lane: 'x', code: 'needs_scope', message: X_REPLY },
  lastFailure: { lane: 'x', at: '2026-06-01T10:03:00Z', code: 'needs_scope', message: X_REPLY, terminal: true, recovery: 'manual', halted: false, haltCode: null },
};

const editPost = {
  ...base,
  id: 'p3',
  platforms: ['x'],
  publishHold: { at: '2026-06-01T10:03:00Z', lane: 'x', code: 'invalid_input', message: 'tweet is 300 chars' },
  lastFailure: { lane: 'x', at: '2026-06-01T10:03:00Z', code: 'invalid_input', message: 'tweet is 300 chars', terminal: true, recovery: 'edit', halted: false, haltCode: null },
};

function renderDetail(post, { onNavigate = vi.fn(), onEdit = vi.fn(), locale = 'en' } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale={locale}>
        <TooltipProvider>
          <ConfirmProvider>
            <PostDetail post={post} onClose={() => {}} onEdit={onEdit} onNavigate={onNavigate} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { onNavigate, onEdit };
}

function failureBanner() {
  const el = screen.getAllByRole('alert').find((n) => /did not accept this post/i.test(n.textContent));
  expect(el).toBeTruthy();
  return el;
}

function expectNoRetry() {
  expect(screen.queryByText(/tries again on its own/i)).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /publish this overdue post now/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /clear the block and publish this post again/i })).not.toBeInTheDocument();
  expect(screen.queryByText('Retrying')).not.toBeInTheDocument();
}

beforeEach(() => {
  healthData = undefined;
  vi.spyOn(window, 'open').mockImplementation(() => null);
});

describe('a failure only the operator can recover: no retry, the real way out', () => {
  it('credential refusal: says it waits on you, offers Reconnect to Setup for that lane', async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderDetail(credentialPost);
    expectNoRetry();
    const banner = failureBanner();
    expect(within(banner).getByText(/until then, this post does not go out/i)).toBeInTheDocument();
    expect(screen.getAllByText('Waiting on you').length).toBeGreaterThan(0);
    const fix = within(banner).getByRole('button', { name: /^reconnect linkedin$/i });
    expect(fix).toHaveTextContent(/^Reconnect$/);
    await user.click(fix);
    // An OAuth lane: Setup opens on that lane with its reconnect already started.
    expect(onNavigate).toHaveBeenCalledWith('setup', 'linkedin', { action: 'reconnect' });
    // The recovery replaces the terminal fallback, it does not sit beside it.
    expect(within(banner).queryByRole('button', { name: /mark as posted/i })).not.toBeInTheDocument();
  });

  it('local needs_scope: waits on you, names the missing permission, Reconnect goes to that lane', async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderDetail(localScopePost);
    expectNoRetry();
    const banner = failureBanner();
    // Judge round 2: the fix is said ONCE. The plain sentence names the cause and the fix,
    // the button carries it; the old "Waiting on you: reconnect LinkedIn." restated both.
    expect(within(banner).queryByText(/waiting on you: reconnect/i)).not.toBeInTheDocument();
    expect(within(banner).getByText(/until then, this post does not go out/i)).toBeInTheDocument();
    // The plain sentence names the cause (the engine's needs_scope code), never the raw dump.
    expect(within(banner).getByText(/linkedin needs a permission the connection does not have/i)).toBeInTheDocument();
    expect(within(banner).queryByText(/HTTP 403|ACCESS_DENIED/)).not.toBeInTheDocument();
    expect(screen.getAllByText('Waiting on you').length).toBeGreaterThan(0);
    const fix = within(banner).getByRole('button', { name: /^reconnect linkedin$/i });
    expect(fix).toHaveTextContent(/^Reconnect$/);
    await user.click(fix);
    // An OAuth lane: Setup opens on that lane with its reconnect already started.
    expect(onNavigate).toHaveBeenCalledWith('setup', 'linkedin', { action: 'reconnect' });
    expect(within(banner).queryByRole('button', { name: /mark as posted/i })).not.toBeInTheDocument();
  });

  it('local needs_scope in German: the fix said once, then "Neu verbinden" with a 44px hit area', () => {
    renderDetail(localScopePost, { locale: 'de-CH' });
    const banner = screen.getAllByRole('alert').find((n) => /hat diesen Beitrag nicht angenommen/i.test(n.textContent));
    expect(banner).toBeTruthy();
    expect(within(banner).queryByText(/Verbinde LinkedIn neu/)).not.toBeInTheDocument();
    expect(within(banner).getByText('Bis dahin geht dieser Beitrag nicht raus.')).toBeInTheDocument();
    const btn = within(banner).getByRole('button', { name: 'LinkedIn neu verbinden' });
    expect(btn).toHaveTextContent(/^Neu verbinden$/);
    // The shared TAP_TARGET ::after box (ui/recipes.js): 44px hit area, painted size unchanged.
    expect(btn.className).toMatch(/after:h-11/);
    expect(btn.className).toMatch(/after:min-w-11/);
    // The detail's close glyph and footer overflow get the same invisible 44px box.
    expect(screen.getByRole('button', { name: 'Detail schliessen' }).className).toMatch(/after:h-11/);
    expect(screen.getByRole('button', { name: 'Weitere Aktionen' }).className).toMatch(/after:h-11/);
    expect(screen.getAllByText('Wartet auf dich').length).toBeGreaterThan(0);
  });

  it('reconnect with the lane offline: no competing "paste it yourself" route', () => {
    healthData = { setup: { platforms: [{ platform: 'linkedin', status: 'incomplete' }] } };
    renderDetail(localScopePost);
    expect(within(failureBanner()).getByRole('button', { name: /^reconnect linkedin$/i })).toBeInTheDocument();
    expect(screen.queryByText(/paste the text on linkedin yourself/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Where this goes')).not.toBeInTheDocument();
  });

  it('X reply restriction: no Try again; copy the reply and post it yourself, then mark it', async () => {
    const user = userEvent.setup();
    // userEvent.setup() installs its own clipboard stub; spy on that one.
    const writeText = vi.spyOn(navigator.clipboard, 'writeText');
    renderDetail(xReplyPost);
    expectNoRetry();
    const banner = failureBanner();
    expect(within(banner).getByText(/waiting on you: copy the text/i)).toBeInTheDocument();
    await user.click(within(banner).getByRole('button', { name: /copy and post yourself/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Thanks, that matches what we saw.'));
    expect(window.open).toHaveBeenCalledWith('https://x.com/someone/status/123', '_blank', 'noopener,noreferrer');
    expect(await within(failureBanner()).findByRole('button', { name: /mark as posted/i })).toBeInTheDocument();
  });

  it('content block: no Try again; Open in editor is the way out', async () => {
    const user = userEvent.setup();
    const { onEdit } = renderDetail(editPost);
    expectNoRetry();
    const banner = failureBanner();
    expect(within(banner).getByText(/waiting on you: edit the post/i)).toBeInTheDocument();
    await user.click(within(banner).getByRole('button', { name: /open in editor/i }));
    expect(onEdit).toHaveBeenCalledWith(editPost);
  });

  // Q5: the engine keeps post.lastFailure after a reschedule (lib/plans.mjs lastFailureFor
  // reads the attempts tail, which a reschedule leaves alone), so a post moved to a new slot
  // arrives waiting-due WITH the old failure. The banner follows the derived state, not the
  // field: no failure panel, no "Did not accept" on a post that is healthy again.
  it('a stale lastFailure on a rescheduled, healthy post shows no failure banner', () => {
    renderDetail({ ...localScopePost, publishHold: null, derivedState: 'waiting-due', scheduledAt: '2099-01-01T10:00:00Z' });
    expect(screen.queryAllByRole('alert').filter((n) => /did not accept this post/i.test(n.textContent))).toHaveLength(0);
    expect(screen.queryByText(/did not accept this post/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
  });
});
