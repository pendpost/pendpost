import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Composer from '../Composer.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// A4: the live brand-lint must learn which platform(s) the draft targets so the
// caption/hashtag caps are correct (a Facebook caption is not falsely flagged at
// the conservative 2200 default; IG's 30-hashtag ceiling does not collapse to
// 10). We mock the api layer and spy on lintText, then assert the exact
// (text, platform) call shape for single-select, multi-select (most-permissive),
// and the default unary signature.

const lintText = vi.fn(() => Promise.resolve({ ok: true, clean: true, findings: [] }));

vi.mock('../../lib/api.js', () => ({
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  // useLint reads useAssets(true); a stable empty result keeps the asset picker
  // inert so the test isolates the lint wiring.
  useAssets: () => ({ data: { assets: [], dir: '/tmp/assets' } }),
  // The Composer reads useConfig for the global hashtag presets (B10); a stable
  // empty result keeps the lint test focused.
  useConfig: () => ({ data: { posting: { hashtagPresets: [] } } }),
  // B2: read-only validate hooks; inert (undefined data) in this create-mode lint test.
  usePlatformValidate: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  createPost: vi.fn(() => Promise.resolve({ ok: true })),
  updatePost: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: (...args) => lintText(...args),
}));

function renderComposer(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ConfirmProvider>
          <Composer
            mode="create"
            post={null}
            campaigns={[{ id: 'launch', active: true, posts: [] }]}
            onClose={vi.fn()}
            onSaved={vi.fn()}
            {...props}
          />
        </ConfirmProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  lintText.mockClear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

describe('Composer live brand-lint platform threading (A4)', () => {
  it('sends the selected platform (Facebook only) to lintText', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderComposer();
    // Default selection is Instagram; switch to Facebook only.
    await user.click(screen.getByRole('button', { name: 'Instagram' })); // deselect IG
    await user.click(screen.getByRole('button', { name: 'Facebook' })); // select FB
    await user.type(screen.getByLabelText('Caption'), 'hello facebook');
    vi.advanceTimersByTime(400);
    await waitFor(() => {
      expect(lintText).toHaveBeenCalledWith('hello facebook', 'facebook');
    });
  });

  it('sends the most-permissive platform (facebook) when Instagram + Facebook are both selected', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderComposer();
    // Default is Instagram; add Facebook so both are selected.
    await user.click(screen.getByRole('button', { name: 'Facebook' }));
    await user.type(screen.getByLabelText('Caption'), 'multi target');
    vi.advanceTimersByTime(400);
    await waitFor(() => {
      const captionCalls = lintText.mock.calls.filter((c) => c[0] === 'multi target');
      expect(captionCalls.length).toBeGreaterThan(0);
      // Every caption lint for the multi-select draft must use the most-permissive
      // cap (facebook), never instagram, so the caption is not over-flagged.
      for (const call of captionCalls) {
        expect(call[1]).toBe('facebook');
      }
    });
  });

  it('threads the same derived platform into the description lint', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderComposer();
    // Select YouTube (so a description field is available) only.
    await user.click(screen.getByRole('button', { name: 'Instagram' })); // deselect IG
    await user.click(screen.getByRole('button', { name: 'YouTube' }));
    const description = await screen.findByLabelText('Description (YouTube)');
    await user.type(description, 'a yt description');
    vi.advanceTimersByTime(400);
    await waitFor(() => {
      expect(lintText).toHaveBeenCalledWith('a yt description', 'youtube');
    });
  });

  it('has no axe violations (the Composer is an interactive surface)', async () => {
    // Real timers here: jest-axe runs async and the fake-timer beforeEach is for
    // the debounce assertions above, not this a11y pass.
    vi.useRealTimers();
    const { container } = renderComposer();
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
