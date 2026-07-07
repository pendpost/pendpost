import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ThreadComposer, { allocateThreadIds, tweetTimes } from '../ThreadComposer.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import { createPost } from '../../lib/api.js';
import { collectThread, deriveThread } from '../../lib/format.js';

// The thread composer authors an X thread as ONE artifact, then saves it as N
// draft posts chained by xReplyTo. A thread is NOT a new entity - just existing
// posts linked by the existing field - so the load-bearing guarantees are:
//   1. save issues sequential createPost calls, ids chained by xReplyTo, X-only;
//   2. a mid-sequence failure STOPS (no orphan child) and retry skips the saved;
//   3. an out-of-order reply (gap < 1) and an over-280 tweet block the save;
//   4. the pure helpers (id allocation, staggered times, thread walk) are total.

vi.mock('../../lib/api.js', () => ({
  useActiveClient: () => ({ activeClient: { id: 'acme', displayName: 'Acme', accent: '#22566d' }, activeClientId: 'acme' }),
  useAssets: () => ({ data: { assets: [], dir: '/tmp/assets' } }),
  useConfig: () => ({ data: { posting: { hashtagPresets: [] } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, findings: [] })),
  createPost: vi.fn(() => Promise.resolve({ ok: true })),
  updatePost: vi.fn(() => Promise.resolve({ ok: true })),
}));

const campaigns = [{ id: 'launch-2026-07', active: true, posts: [] }];

function renderThread(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  const onSaved = vi.fn();
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <ThreadComposer campaigns={campaigns} onClose={onClose} onSaved={onSaved} {...props} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { onClose, onSaved };
}

// Author an N-tweet thread by typing into each textarea (adding rows as needed).
async function authorTweets(user, texts) {
  for (let i = 0; i < texts.length; i += 1) {
    if (i > 0) await user.click(screen.getByRole('button', { name: /add tweet/i }));
    const boxes = screen.getAllByRole('textbox');
    await user.clear(boxes[i]);
    await user.type(boxes[i], texts[i]);
  }
}

beforeEach(() => { createPost.mockClear(); createPost.mockImplementation(() => Promise.resolve({ ok: true })); });

describe('ThreadComposer save orchestration', () => {
  it('creates each tweet in order, chained by xReplyTo, X-only, all drafts', async () => {
    const user = userEvent.setup();
    const { onClose } = renderThread();
    await authorTweets(user, ['one', 'two', 'three']);
    await user.click(screen.getByRole('button', { name: /create thread/i }));
    await waitFor(() => expect(createPost).toHaveBeenCalledTimes(3));

    const posts = createPost.mock.calls.map((c) => c[1]);
    expect(posts.map((p) => p.caption)).toEqual(['one', 'two', 'three']);
    // Chain: opener has no parent, each reply threads under the previous id.
    expect(posts[0].xReplyTo).toBeUndefined();
    expect(posts[1].xReplyTo).toBe(posts[0].id);
    expect(posts[2].xReplyTo).toBe(posts[1].id);
    // Deterministic ids: base + -2/-3.
    expect(posts[0].id).toBe('txt1');
    expect(posts[1].id).toBe('txt1-2');
    expect(posts[2].id).toBe('txt1-3');
    // X-only, text drafts.
    for (const p of posts) {
      expect(p.platforms).toEqual(['x']);
      expect(p.type).toBe('text');
      expect(p.campaign).toBeUndefined(); // campaign is the first createPost arg, not the post body
    }
    expect(createPost.mock.calls.every((c) => c[0] === 'launch-2026-07')).toBe(true);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('reorder before save renumbers ids and rechains xReplyTo by position', async () => {
    const user = userEvent.setup();
    renderThread();
    await authorTweets(user, ['first', 'second']);
    // Move the second tweet up so it becomes the opener (the opener's own move-up
    // is disabled, so target the reply row's - the second move-up control).
    const ups = screen.getAllByRole('button', { name: /move up/i });
    await user.click(ups[1]);
    await user.click(screen.getByRole('button', { name: /create thread/i }));
    await waitFor(() => expect(createPost).toHaveBeenCalledTimes(2));
    const posts = createPost.mock.calls.map((c) => c[1]);
    expect(posts[0].caption).toBe('second');
    expect(posts[1].caption).toBe('first');
    expect(posts[0].xReplyTo).toBeUndefined();
    expect(posts[1].xReplyTo).toBe(posts[0].id);
  });

  it('stops on the first failure and never creates a child of a failed parent', async () => {
    const user = userEvent.setup();
    createPost.mockImplementationOnce(() => Promise.resolve({ ok: true }))
      .mockImplementationOnce(() => Promise.reject(Object.assign(new Error('boom'), { code: 'x' })));
    renderThread();
    await authorTweets(user, ['a', 'b', 'c']);
    await user.click(screen.getByRole('button', { name: /create thread/i }));
    // Only 2 attempts: opener ok, second fails, third (its child) never attempted.
    await waitFor(() => expect(createPost).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole('alert')).toHaveTextContent(/saved 1 of 3/i);
  });

  it('retry after a partial failure skips the already-saved tweets (no double-create)', async () => {
    const user = userEvent.setup();
    createPost
      .mockImplementationOnce(() => Promise.resolve({ ok: true }))
      .mockImplementationOnce(() => Promise.reject(new Error('boom')));
    renderThread();
    await authorTweets(user, ['a', 'b', 'c']);
    await user.click(screen.getByRole('button', { name: /create thread/i }));
    await waitFor(() => expect(createPost).toHaveBeenCalledTimes(2));
    // Now let the rest succeed and retry.
    createPost.mockImplementation(() => Promise.resolve({ ok: true }));
    await user.click(screen.getByRole('button', { name: /retry remaining/i }));
    await waitFor(() => expect(createPost).toHaveBeenCalledTimes(4)); // 2 + retry(b, c)
    const ids = createPost.mock.calls.map((c) => c[1].id);
    // txt1 was created once (in the first run) and NOT re-created on retry.
    expect(ids.filter((id) => id === 'txt1')).toHaveLength(1);
    expect(ids).toEqual(['txt1', 'txt1-2', 'txt1-2', 'txt1-3']);
  });
});

describe('ThreadComposer validation', () => {
  it('blocks save when a reply gap is below 1 minute (would stall the chain)', async () => {
    const user = userEvent.setup();
    renderThread();
    await authorTweets(user, ['opener', 'reply']);
    const gap = screen.getByRole('spinbutton'); // the single reply gap
    await user.clear(gap);
    await user.type(gap, '0');
    await user.click(screen.getByRole('button', { name: /create thread/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(createPost).not.toHaveBeenCalled();
  });

  it('blocks save when a tweet is over 280 characters', async () => {
    const user = userEvent.setup();
    renderThread();
    const boxes = screen.getAllByRole('textbox');
    await user.click(boxes[0]);
    await user.paste('x'.repeat(281));
    await user.click(screen.getByRole('button', { name: /create thread/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(createPost).not.toHaveBeenCalled();
  });
});

describe('ThreadComposer pure helpers', () => {
  it('allocateThreadIds returns a collision-free base + suffixes', () => {
    expect(allocateThreadIds([], 3)).toEqual(['txt1', 'txt1-2', 'txt1-3']);
    // Skips a base whose suffixes would collide with existing ids.
    expect(allocateThreadIds([{ id: 'txt1' }, { id: 'txt1-2' }], 2)).toEqual(['txt2', 'txt2-2']);
  });

  it('tweetTimes staggers replies monotonically after the opener', () => {
    const times = tweetTimes('2099-07-07T09:00:00.000Z', [
      { gapMin: 0 }, { gapMin: 2 }, { gapMin: 3 },
    ]);
    expect(times[0]).toBe('2099-07-07T09:00:00.000Z');
    expect(new Date(times[1]).getTime()).toBe(new Date(times[0]).getTime() + 2 * 60000);
    expect(new Date(times[2]).getTime()).toBe(new Date(times[1]).getTime() + 3 * 60000);
    // No opener time -> all null (pure drafts).
    expect(tweetTimes(null, [{ gapMin: 0 }, { gapMin: 2 }])).toEqual([null, null]);
  });
});

// The thread-walk helpers back the ListView folding + Freigaben "select thread".
describe('collectThread / deriveThread', () => {
  const mk = (id, xReplyTo = null) => ({ id, campaign: 'c', xReplyTo });
  const opener = mk('t1');
  const r1 = mk('t1-2', 't1');
  const r2 = mk('t1-3', 't1-2'); // chained under r1, not the opener
  const other = mk('solo');
  const all = [opener, r1, r2, other];

  it('deriveThread gives only the DIRECT parent and replies', () => {
    expect(deriveThread(r1, all).parent).toBe(opener);
    expect(deriveThread(opener, all).replies).toEqual([r1]); // not r2 (that chains under r1)
  });

  it('collectThread walks the whole chain from any member, root-first', () => {
    const ids = (p) => collectThread(p, all).map((x) => x.id);
    expect(ids(r2)).toEqual(['t1', 't1-2', 't1-3']);
    expect(ids(opener)).toEqual(['t1', 't1-2', 't1-3']);
    expect(collectThread(other, all).map((x) => x.id)).toEqual(['solo']);
  });
});
