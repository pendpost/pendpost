import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import PostDetail from '../PostDetail.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// The missing-post branch (rules-of-hooks regression).
//
// PostDetail used to guard mid-body with `if (!post) return null`, roughly 370 lines
// ABOVE its useConfig(true) call for the sign-off config. So on a null post that hook
// was skipped: hooks ran in one order for a real post and a shorter order for a null
// one, which is exactly the unstable order React forbids (and eslint flagged as
// react-hooks/rules-of-hooks). The branch was also unreachable in practice, because the
// body dereferenced `post.lastFailure` long before the guard could return.
//
// The guard now lives in a thin wrapper around PostDetailBody, so the body's hooks are
// unconditional. This pins both halves: a null post renders nothing instead of throwing,
// and flipping post null -> real -> null never trips a hook-order error.

vi.mock('../../lib/api.js', () => ({
  useInsights: () => ({ data: undefined }),
  useActiveClient: () => ({ activeClient: { id: 'acme', displayName: 'Acme Retail', accent: '#22566d' }, activeClientId: 'acme' }),
  usePendpostHealth: () => ({ data: { setup: { platforms: [] } } }),
  // The very hook the old early return skipped.
  useConfig: () => ({ data: { posting: { review: { required: true } } } }),
  useAccounts: () => ({ data: { meta: { paused: false } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePresubmitCheck: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useAssets: () => ({ data: { dir: 'data/media', assets: [] } }),
  approvePost: vi.fn(),
  rejectPost: vi.fn(),
  deletePost: vi.fn(),
  unschedulePost: vi.fn(),
  reschedulePost: vi.fn(),
  markPosted: vi.fn(),
  verifyPost: vi.fn(),
  setCoverFrame: vi.fn(),
  uploadCover: vi.fn(),
  clearCover: vi.fn(),
  updatePost: vi.fn(),
  editPublished: vi.fn(),
  discordScheduleEvent: vi.fn(),
  mastodonPin: vi.fn(),
}));

const POST = {
  id: 'p1',
  campaign: 'launch',
  caption: 'Hello from the detail drawer',
  platforms: ['mastodon'],
  approval: 'approved',
  derivedState: 'scheduled',
  status: 'scheduled',
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
  media: { file: null, exists: false, bytes: 0, url: null, cover: null, path: null },
};

const wrap = (post) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <I18nProvider locale="en">
      <TooltipProvider>
        <ConfirmProvider>
          <PostDetail post={post} onClose={() => {}} onEdit={() => {}} />
        </ConfirmProvider>
      </TooltipProvider>
    </I18nProvider>
  </QueryClientProvider>
);

let errors;
let spy;

beforeEach(() => {
  errors = [];
  spy = vi.spyOn(console, 'error').mockImplementation((...args) => { errors.push(String(args[0])); });
});

afterEach(() => {
  spy.mockRestore();
});

const hookComplaints = () => errors.filter((m) => /hook/i.test(m));

describe('PostDetail missing-post branch', () => {
  it('renders nothing (and does not throw) when there is no post', () => {
    const { container } = render(wrap(null));
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(hookComplaints()).toEqual([]);
  });

  it('renders the drawer for a real post, and survives flipping the post away and back', () => {
    const { rerender } = render(wrap(null));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    rerender(wrap(POST));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Hello from the detail drawer')).toBeInTheDocument();

    rerender(wrap(null));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    rerender(wrap(POST));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Hello from the detail drawer')).toBeInTheDocument();

    expect(hookComplaints()).toEqual([]);
  });
});
