import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import PostDetail from '../PostDetail.jsx';
import Composer from '../Composer.jsx';
import { ListView } from '../Planner.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import { createPost, updatePost } from '../../lib/api.js';

// X reply-chain surface (xReplyTo): a threaded post must be distinguishable from
// a standalone one, and deleting a parent must warn that its replies stay held
// (scripts/x-social.mjs fail-closes: a child whose parent is gone never fires).
//   1. PostDetail shows a "Replies to <id>" line linking to the parent post.
//   2. A dangling reference (parent deleted) reads as an explicit missing note.
//   3. The delete confirm names the replies that would be orphaned.
//   4. The Planner list marks a chained post with a glyph (sr-labelled).
//   5. The Composer can SET and CLEAR the field (clear-to-null is the escape
//      hatch for a dangling reference), X-targeted posts only.

vi.mock('../../lib/api.js', () => ({
  useActiveClient: () => ({ activeClient: { id: 'acme', displayName: 'Acme Retail', accent: '#22566d' }, activeClientId: 'acme' }),
  useAccounts: () => ({ data: { meta: { paused: false } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useAssets: () => ({ data: { assets: [], dir: '/tmp/assets' } }),
  useConfig: () => ({ data: { posting: { hashtagPresets: [] } } }),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, findings: [] })),
  createPost: vi.fn(() => Promise.resolve({ ok: true })),
  updatePost: vi.fn(() => Promise.resolve({ ok: true })),
  approvePost: vi.fn(),
  rejectPost: vi.fn(),
  deletePost: vi.fn(),
  unschedulePost: vi.fn(),
  reschedulePost: vi.fn(),
  markPosted: vi.fn(),
  verifyPost: vi.fn(),
  runPublishDue: vi.fn(),
  setCoverFrame: vi.fn(),
  uploadCover: vi.fn(),
  clearCover: vi.fn(),
}));

const mk = (id, extra = {}) => ({
  id,
  campaign: 'launch-2026-07',
  title: id,
  caption: `${id} caption`,
  firstComment: null,
  approvalNote: null,
  platforms: ['x'],
  approval: 'pending',
  derivedState: 'scheduled',
  scheduledAt: '2099-07-07T10:00:00Z',
  type: 'text',
  rev: 1,
  executionMode: 'fully-scheduled',
  image: null,
  ids: {},
  cover: null,
  publishedVia: null,
  externalUrl: null,
  verify: null,
  xReplyTo: null,
  media: { file: null, exists: false, bytes: 0, url: null, cover: null, path: null },
  ...extra,
});

const parent = mk('x-launch-thread');
const child = mk('launch-thread-2', { xReplyTo: 'x-launch-thread' });

function renderDetail({ post, posts = [], onOpenPost = vi.fn() } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <PostDetail post={post} posts={posts} onClose={() => {}} onEdit={() => {}} onOpenPost={onOpenPost} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { onOpenPost };
}

describe('PostDetail xReplyTo thread line', () => {
  it('shows a "Replies to" line that opens the parent post on click', async () => {
    const user = userEvent.setup();
    const { onOpenPost } = renderDetail({ post: child, posts: [parent, child] });
    const link = screen.getByRole('button', { name: /replies to x-launch-thread/i });
    await user.click(link);
    expect(onOpenPost).toHaveBeenCalledWith(expect.objectContaining({ id: 'x-launch-thread' }));
  });

  it('flags a dangling reference (parent missing) instead of linking', () => {
    renderDetail({ post: child, posts: [child] });
    expect(screen.getByText(/parent post missing/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /replies to/i })).not.toBeInTheDocument();
  });

  it('renders no thread line on a standalone post', () => {
    renderDetail({ post: parent, posts: [parent, child] });
    // parent's own header carries no "Replies to" (the delete confirm covers
    // the reverse direction, tested below).
    expect(screen.queryByText(/replies to/i)).not.toBeInTheDocument();
  });
});

describe('PostDetail delete confirm thread warning', () => {
  it('warns with the reply ids when other posts thread under this one', async () => {
    const user = userEvent.setup();
    renderDetail({ post: parent, posts: [parent, child] });
    await user.click(screen.getByRole('button', { name: /more actions/i }));
    await user.click(screen.getByRole('button', { name: /delete post/i }));
    const dialog = await screen.findByRole('dialog', { name: /delete post/i });
    expect(dialog).toHaveTextContent(/launch-thread-2/);
    expect(dialog).toHaveTextContent(/will not publish/i);
  });

  it('stays plain when nothing references the post', async () => {
    const user = userEvent.setup();
    renderDetail({ post: child, posts: [child] });
    await user.click(screen.getByRole('button', { name: /more actions/i }));
    await user.click(screen.getByRole('button', { name: /delete post/i }));
    const dialog = await screen.findByRole('dialog', { name: /delete post/i });
    expect(dialog).not.toHaveTextContent(/will not publish/i);
  });
});

describe('Planner list reply-chain glyph', () => {
  const renderList = (posts) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <I18nProvider locale="en">
          <ConfirmProvider>
            <TooltipProvider>
              <ListView posts={posts} onSelect={() => {}} loading={false} lane={{}} />
            </TooltipProvider>
          </ConfirmProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );

  it('marks only the chained post with an sr-labelled glyph', () => {
    renderList([parent, child]);
    const marks = screen.getAllByText(/replies to x-launch-thread/i);
    expect(marks).toHaveLength(1);
  });

  it('renders no glyph when no post is chained', () => {
    renderList([parent]);
    expect(screen.queryByText(/replies to/i)).not.toBeInTheDocument();
  });
});

describe('Composer xReplyTo edit affordance', () => {
  const campaigns = [{ id: 'launch-2026-07', active: true, posts: [parent, child] }];

  function renderComposer(post) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <I18nProvider locale="en">
          <TooltipProvider>
            <ConfirmProvider>
              <Composer mode={post ? 'edit' : 'create'} post={post} campaigns={campaigns} onClose={() => {}} onSaved={() => {}} />
            </ConfirmProvider>
          </TooltipProvider>
        </I18nProvider>
      </QueryClientProvider>,
    );
  }

  beforeEach(() => {
    createPost.mockClear();
    updatePost.mockClear();
  });

  it('prefills replies-to on an X post and clears it to null on save', async () => {
    const user = userEvent.setup();
    renderComposer(child);
    const input = screen.getByLabelText(/replies to/i);
    expect(input).toHaveValue('x-launch-thread');
    await user.clear(input);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updatePost).toHaveBeenCalled());
    expect(updatePost.mock.calls[0][3]).toMatchObject({ xReplyTo: null });
  });

  it('saves a typed sibling id and offers same-campaign X posts, never itself', async () => {
    const user = userEvent.setup();
    renderComposer(parent);
    // The datalist suggests the sibling X post but excludes the post itself.
    const options = [...document.querySelectorAll('#composer-x-reply-to-posts option')].map((o) => o.value);
    expect(options).toContain('launch-thread-2');
    expect(options).not.toContain('x-launch-thread');
    await user.type(screen.getByLabelText(/replies to/i), 'launch-thread-2');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updatePost).toHaveBeenCalled());
    expect(updatePost.mock.calls[0][3]).toMatchObject({ xReplyTo: 'launch-thread-2' });
  });

  it('rejects a malformed or self-referencing id without saving', async () => {
    const user = userEvent.setup();
    renderComposer(child);
    const input = screen.getByLabelText(/replies to/i);
    await user.clear(input);
    await user.type(input, 'not a valid id!');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(updatePost).not.toHaveBeenCalled();
    // Self-reference is the same footgun: a post can never thread under itself.
    await user.clear(input);
    await user.type(input, child.id);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(updatePost).not.toHaveBeenCalled();
  });

  it('carries the typed id in the create payload', async () => {
    const user = userEvent.setup();
    renderComposer(null);
    await user.click(screen.getByRole('button', { name: 'X' }));
    await user.type(screen.getByLabelText(/replies to/i), 'x-launch-thread');
    await user.click(screen.getByRole('button', { name: /create draft/i }));
    await waitFor(() => expect(createPost).toHaveBeenCalled());
    expect(createPost.mock.calls[0][1]).toMatchObject({ xReplyTo: 'x-launch-thread' });
  });

  it('renders no replies-to field when X is not targeted', () => {
    renderComposer(mk('ig-only', { platforms: ['instagram'] }));
    expect(screen.queryByLabelText(/replies to/i)).not.toBeInTheDocument();
  });
});
