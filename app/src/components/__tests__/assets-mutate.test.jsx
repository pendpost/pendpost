import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Assets from '../Assets.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// C2: per-card delete + rename controls on the Library. Delete SURFACES the
// in-use posts before the destructive confirm; rename collects the new name via
// a prompt. Both invalidate ['assets'] on success and route through the
// deleteAsset/renameAsset api.js helpers (the REST face of the new write twins).

const MEDIA_DIR = 'data/media';
const UNUSED = {
  file: 'unused.mp4', bytes: 2048, url: '/media?p=unused.mp4', cover: null,
  probe: { durationSec: 8 }, checks: { resolution: 'story-9x16', codecOk: true, faststart: true },
  usedBy: [], captions: [],
};
const IN_USE = {
  file: 'in-use.mp4', bytes: 4096, url: '/media?p=in-use.mp4', cover: null,
  probe: { durationSec: 10 }, checks: { resolution: 'feed-4x5', codecOk: true, faststart: true },
  usedBy: [{ campaign: 'launch-2026', postId: 'r07', scheduledAt: '2099-01-01T09:00:00Z', state: 'waiting-due' }],
  captions: [],
};

let assetsData;
const deleteAssetMock = vi.fn(() => Promise.resolve({ ok: true }));
const renameAssetMock = vi.fn(() => Promise.resolve({ ok: true }));

vi.mock('../../lib/api.js', () => ({
  useAssets: () => ({ data: assetsData, isLoading: false, isError: false }),
  uploadAssetFile: vi.fn(() => Promise.resolve({ ok: true })),
  deleteAsset: (...a) => deleteAssetMock(...a),
  renameAsset: (...a) => renameAssetMock(...a),
}));

function renderAssets(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <ConfirmProvider>
            <Assets {...props} />
          </ConfirmProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  assetsData = { dir: MEDIA_DIR, assets: [UNUSED, IN_USE] };
  deleteAssetMock.mockClear();
  renameAssetMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Asset delete control (C2)', () => {
  it('renders a delete control per card with an accessible name referencing the file', () => {
    renderAssets();
    expect(screen.getByRole('button', { name: /delete.*unused\.mp4/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete.*in-use\.mp4/i })).toBeInTheDocument();
  });

  it('deleting an UNUSED asset confirms then calls deleteAsset and invalidates [assets]', async () => {
    const user = userEvent.setup();
    const { qc } = renderAssets();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    await user.click(screen.getByRole('button', { name: /delete.*unused\.mp4/i }));
    // A confirm dialog appears; accept it.
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: /delete/i }));
    await waitFor(() => expect(deleteAssetMock).toHaveBeenCalledTimes(1));
    expect(deleteAssetMock).toHaveBeenCalledWith('unused.mp4', expect.anything());
    expect(spy).toHaveBeenCalledWith({ queryKey: ['assets'] });
  });

  it('deleting an IN-USE asset SURFACES the using post before the destructive confirm', async () => {
    const user = userEvent.setup();
    renderAssets();
    await user.click(screen.getByRole('button', { name: /delete.*in-use\.mp4/i }));
    const dialog = await screen.findByRole('dialog');
    // The using post id is named in the destructive confirm body.
    expect(within(dialog).getByText(/r07/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /delete/i }));
    await waitFor(() => expect(deleteAssetMock).toHaveBeenCalledTimes(1));
    // The in-use delete passes confirm so the server-side gate is satisfied.
    expect(deleteAssetMock).toHaveBeenCalledWith('in-use.mp4', true);
  });

  it('cancelling the delete confirm calls nothing', async () => {
    const user = userEvent.setup();
    renderAssets();
    await user.click(screen.getByRole('button', { name: /delete.*unused\.mp4/i }));
    const dialog = await screen.findByRole('dialog');
    // Two "Cancel" affordances exist (the backdrop + the footer button); the
    // footer ghost button is the last one. Either dismisses without deleting.
    const cancels = within(dialog).getAllByRole('button', { name: /cancel/i });
    await user.click(cancels[cancels.length - 1]);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(deleteAssetMock).not.toHaveBeenCalled();
  });
});

describe('Asset rename control (C2)', () => {
  it('renders a rename control per card with an accessible name referencing the file', () => {
    renderAssets();
    expect(screen.getByRole('button', { name: /rename.*unused\.mp4/i })).toBeInTheDocument();
  });

  it('renaming prompts for a new name then calls renameAsset and invalidates [assets]', async () => {
    const user = userEvent.setup();
    const { qc } = renderAssets();
    const spy = vi.spyOn(qc, 'invalidateQueries');
    await user.click(screen.getByRole('button', { name: /rename.*unused\.mp4/i }));
    const dialog = await screen.findByRole('dialog');
    const field = within(dialog).getByRole('textbox');
    await user.clear(field);
    await user.type(field, 'renamed.mp4');
    await user.click(within(dialog).getByRole('button', { name: /rename|confirm|save/i }));
    await waitFor(() => expect(renameAssetMock).toHaveBeenCalledTimes(1));
    expect(renameAssetMock).toHaveBeenCalledWith('unused.mp4', 'renamed.mp4', expect.anything());
    expect(spy).toHaveBeenCalledWith({ queryKey: ['assets'] });
  });
});

describe('Asset mutate controls a11y (C2)', () => {
  it('has no axe violations on the grid with delete/rename controls', async () => {
    const { container } = renderAssets();
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
