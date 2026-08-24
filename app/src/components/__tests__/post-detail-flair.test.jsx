import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PostDetail from '../PostDetail.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// The flair picker, IN the post detail. Flair is a closed set of valid values, so the
// canon wants the control where the decision happens - not advice pointing at reddit.com
// and not a round-trip through the Composer. The picker is the Composer's verbatim (same
// hook, same four states, same locale keys), staged into the shared dirty->Save model,
// and the blockers panel's "Choose a flair" action focuses it: advisory, control, and
// save are one loop that never leaves the modal.
const flairsState = { data: undefined, isLoading: false };
const presubmitState = { data: undefined };
const updatePost = vi.fn(() => Promise.resolve({ ok: true }));

vi.mock('../../lib/api.js', () => ({
  useInsights: () => ({ data: undefined }),
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  usePendpostHealth: () => ({ data: { setup: { platforms: [{ platform: 'reddit', status: 'connected' }] } } }),
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: { meta: { paused: false }, reddit: { subreddit: 'selfhosted' } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useRedditFlairs: (...args) => { flairsState.calls = [...(flairsState.calls || []), args]; return flairsState; },
  usePresubmitCheck: () => presubmitState,
  useValidateMedia: () => ({ data: undefined }),
  useAssets: () => ({ data: { dir: 'data/media', assets: [] } }),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] })),
  approvePost: vi.fn(() => Promise.resolve({ ok: true })),
  rejectPost: vi.fn(),
  deletePost: vi.fn(),
  unschedulePost: vi.fn(),
  reschedulePost: vi.fn(),
  markPosted: vi.fn(),
  verifyPost: vi.fn(),
  setCoverFrame: vi.fn(),
  uploadCover: vi.fn(),
  clearCover: vi.fn(),
  runPublishDue: vi.fn(),
  updatePost: (...a) => updatePost(...a),
  editPublished: vi.fn(),
  discordScheduleEvent: vi.fn(),
  mastodonPin: vi.fn(),
}));
vi.mock('../../lib/cloud.js', () => ({ useCloudDelivery: () => ({ cloudOn: false, cloudLanes: [], resolved: true }) }));

const FLAIRS = [
  { id: 'aaa-111', text: 'Discussion', editable: false },
  { id: 'bbb-222', text: 'Show and tell', editable: true },
];

const redditPost = (over = {}) => ({
  id: 'p-flair',
  campaign: 'launch',
  caption: 'Sharing a self-hosted option.',
  platforms: ['reddit'],
  redditSubreddit: 'selfhosted',
  approval: 'pending',
  derivedState: 'waiting-due',
  scheduledAt: '2026-07-20T10:00:00Z',
  type: 'text',
  rev: 3,
  executionMode: 'fully-scheduled',
  image: null,
  ids: {},
  cover: null,
  media: { file: null, exists: false, bytes: 0, url: null, cover: null, path: null },
  ...over,
});

function renderDetail(post = redditPost(), onEdit = () => {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <PostDetail post={post} onClose={() => {}} onEdit={onEdit} onNavigate={() => {}} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  flairsState.data = { ok: true, subreddit: 'selfhosted', items: FLAIRS };
  flairsState.isLoading = false;
  flairsState.calls = [];
  presubmitState.data = undefined;
  updatePost.mockClear();
});

describe('the flair picker lives in the post detail', () => {
  it('renders the populated select for an editable reddit post, keyed to the effective subreddit', () => {
    renderDetail();
    const select = screen.getByRole('combobox', { name: 'Flair (Reddit)' });
    expect(select).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Discussion' })).toBeInTheDocument();
    expect(flairsState.calls.at(-1)?.[0]).toBe('selfhosted');
  });

  it('stages the pick into the shared Save and PATCHes id + editable text together', async () => {
    const user = userEvent.setup();
    renderDetail();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Flair (Reddit)' }), 'bbb-222');
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    expect(updatePost).toHaveBeenCalledWith('launch', 'p-flair', 3, expect.objectContaining({
      redditFlairId: 'bbb-222',
      redditFlairText: 'Show and tell', // editable template carries its text
    }));
  });

  it('a non-editable template never sends a flair text', async () => {
    const user = userEvent.setup();
    renderDetail();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Flair (Reddit)' }), 'aaa-111');
    await user.click(screen.getByRole('button', { name: /save changes/i }));
    expect(updatePost).toHaveBeenCalledWith('launch', 'p-flair', 3, expect.objectContaining({
      redditFlairId: 'aaa-111',
      redditFlairText: null,
    }));
  });

  it('"Choose a flair" focuses the inline picker instead of opening the Composer', async () => {
    presubmitState.data = {
      ok: true,
      platforms: { reddit: { problems: [{ code: 'flairRequired', text: '' }], warnings: [] } },
    };
    const onEdit = vi.fn();
    const user = userEvent.setup();
    renderDetail(redditPost(), onEdit);
    await user.click(screen.getByRole('button', { name: /choose a flair/i }));
    expect(onEdit).not.toHaveBeenCalled();
    expect(screen.getByRole('combobox', { name: 'Flair (Reddit)' })).toHaveFocus();
  });

  it('a failed read shows the honest unavailable hint, never a fake "no flairs"', () => {
    flairsState.data = { ok: false, error: 'scope_missing', items: [] };
    renderDetail();
    expect(screen.getByText(/flair unavailable for r\/selfhosted/i)).toBeInTheDocument();
    expect(screen.queryByText(/no flairs for/i)).not.toBeInTheDocument();
  });

  it('shows no picker on a post that does not target reddit, and never fetches', () => {
    renderDetail(redditPost({ platforms: ['x'], redditSubreddit: undefined }));
    expect(screen.queryByRole('combobox', { name: 'Flair (Reddit)' })).not.toBeInTheDocument();
    // enabled-gated: the hook is called (rules of hooks) but never allowed to fetch.
    expect(flairsState.calls.every((c) => c[1] === false)).toBe(true);
  });

  it('the read-only Details chip yields to the picker - one answer per job', () => {
    renderDetail(redditPost({ redditFlairId: 'aaa-111', redditFlairText: 'Discussion' }));
    // The picker carries the value; no duplicate "Flair (Reddit)" dt row in Details.
    expect(screen.getAllByText('Flair (Reddit)')).toHaveLength(1);
    expect(screen.getByRole('combobox', { name: 'Flair (Reddit)' })).toHaveValue('aaa-111');
  });

  it('keeps the read-only chip on a posted post (review signage, no dead control)', () => {
    renderDetail(redditPost({ derivedState: 'posted', approval: 'approved', redditFlairId: 'aaa-111', redditFlairText: 'Discussion' }));
    expect(screen.queryByRole('combobox', { name: 'Flair (Reddit)' })).not.toBeInTheDocument();
    expect(screen.getByText('Discussion')).toBeInTheDocument();
  });
});
