import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Composer from '../Composer.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';

// B10 Part B: when an IG-story draft carries >=1 interactive sticker, flipping the
// surface off ('story' -> other type, OR deselecting instagram) silently drops the
// stickers via the derived interactiveStoryPayload. The Composer must intercept the
// type-select onChange and the togglePlatform handler with an async confirm() gate
// warning the stickers will be dropped: on cancel the change reverts and the
// stickers stay; on confirm the change proceeds and the stickers clear. With 0
// stickers there is nothing to strand, so no warning fires.

const confirmFn = vi.fn();

vi.mock('../ui/confirm.jsx', async (orig) => {
  const actual = await orig();
  return {
    ...actual,
    // A pass-through provider so the tree still mounts; the gate behaviour is
    // driven by the mocked useConfirm below (resolve true/false per test).
    ConfirmProvider: ({ children }) => children,
    useConfirm: () => confirmFn,
  };
});

vi.mock('../../lib/api.js', () => ({
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  useAssets: () => ({ data: { assets: [], dir: '/tmp/assets' } }),
  useConfig: () => ({ data: { posting: { hashtagPresets: [] } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  createPost: vi.fn(() => Promise.resolve({ ok: true })),
  updatePost: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, findings: [] })),
}));

function renderComposer(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <Composer
          mode="create"
          post={null}
          campaigns={[{ id: 'launch', active: true, posts: [] }]}
          onClose={vi.fn()}
          onSaved={vi.fn()}
          {...props}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

// Compose an IG-story draft with one mention sticker (mention is the only
// API-supported kind; any kind works for the strand test).
async function addStorySticker(user) {
  await user.selectOptions(screen.getByLabelText('Format'), 'story');
  await user.click(screen.getByRole('button', { name: /add sticker/i }));
  await user.click(screen.getByRole('button', { name: 'Mention' }));
  // The mention field proves the sticker landed in state.
  return screen.findByLabelText('Mention handle');
}

beforeEach(() => {
  confirmFn.mockReset();
});

describe('Composer warns before dropping stranded interactive stickers (B10 Part B)', () => {
  it('warns on type change away from story and reverts on cancel (stickers kept)', async () => {
    const user = userEvent.setup();
    confirmFn.mockResolvedValue(false); // operator cancels
    renderComposer();
    await addStorySticker(user);

    const typeSelect = screen.getByLabelText('Format');
    await user.selectOptions(typeSelect, 'reel');

    await waitFor(() => expect(confirmFn).toHaveBeenCalledTimes(1));
    // Cancelled => type stays 'story' and the sticker survives.
    expect(typeSelect).toHaveValue('story');
    expect(screen.getByLabelText('Mention handle')).toBeInTheDocument();
  });

  it('warns on type change and clears stickers on confirm', async () => {
    const user = userEvent.setup();
    confirmFn.mockResolvedValue(true); // operator confirms the drop
    renderComposer();
    await addStorySticker(user);

    const typeSelect = screen.getByLabelText('Format');
    await user.selectOptions(typeSelect, 'reel');

    await waitFor(() => expect(confirmFn).toHaveBeenCalledTimes(1));
    expect(typeSelect).toHaveValue('reel');
    // Sticker surface is gone and the stickers were cleared: switching back to
    // a story shows no surviving sticker fields.
    await user.selectOptions(typeSelect, 'story');
    expect(screen.queryByLabelText('Mention handle')).not.toBeInTheDocument();
  });

  it('warns on deselecting instagram and reverts on cancel (stickers kept)', async () => {
    const user = userEvent.setup();
    confirmFn.mockResolvedValue(false);
    renderComposer();
    await addStorySticker(user);

    await user.click(screen.getByRole('button', { name: 'Instagram' })); // deselect IG

    await waitFor(() => expect(confirmFn).toHaveBeenCalledTimes(1));
    // Cancelled => instagram stays selected and the sticker survives.
    expect(screen.getByRole('button', { name: 'Instagram' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Mention handle')).toBeInTheDocument();
  });

  it('does not warn when there are 0 stickers to strand', async () => {
    const user = userEvent.setup();
    confirmFn.mockResolvedValue(true);
    renderComposer();
    // IG story but no stickers added.
    await user.selectOptions(screen.getByLabelText('Format'), 'story');
    await user.selectOptions(screen.getByLabelText('Format'), 'reel');
    expect(confirmFn).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Format')).toHaveValue('reel');
  });

  it('has no axe violations', async () => {
    const { container } = renderComposer();
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
