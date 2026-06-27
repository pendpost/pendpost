import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Assets from '../Assets.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// Assets (US-ONB-03): a true zero-asset library on first run must read as a
// welcome that frames mock-by-default and points to upload - DISTINCT from the
// pre-existing "No matching files" state that appears when a search/filter
// yields zero of N>0 assets. We mock useAssets so the test drives both shapes.
let assetsState;

vi.mock('../../lib/api.js', () => ({
  useAssets: () => ({ data: assetsState, isLoading: false, isError: false }),
  uploadAssetFile: vi.fn(() => Promise.resolve({ ok: true })),
  deleteAsset: vi.fn(() => Promise.resolve({ ok: true })),
  renameAsset: vi.fn(() => Promise.resolve({ ok: true })),
}));

function renderAssets() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ConfirmProvider>
          <Assets />
        </ConfirmProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const ONE_ASSET = {
  assets: [
    { file: 'clip.mp4', bytes: 1024, checks: { resolution: 'story-9x16', codecOk: true, faststart: true }, usedBy: [] },
  ],
};

beforeEach(() => { assetsState = { assets: [] }; });

describe('Assets empty states (A6)', () => {
  it('shows a distinct first-run empty-state when the library is truly empty (assets.length===0)', () => {
    assetsState = { assets: [] };
    renderAssets();
    // First-run copy frames mock-by-default and points to upload; it is NOT the
    // "No matching files" no-match copy.
    expect(screen.getByText(/no media yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/no matching files/i)).not.toBeInTheDocument();
  });

  it('shows the existing no-match state when a filter yields zero of N>0 assets', async () => {
    const user = userEvent.setup();
    assetsState = ONE_ASSET;
    renderAssets();
    // Filter to a search that matches nothing -> the one asset is filtered out,
    // but the library is NOT empty, so the no-match state shows (not first-run).
    await user.type(screen.getByPlaceholderText(/search/i), 'zzzznomatch');
    expect(screen.getByText(/no matching files/i)).toBeInTheDocument();
    expect(screen.queryByText(/no media yet/i)).not.toBeInTheDocument();
  });

  it('has no axe violations on the first-run empty-state', async () => {
    assetsState = { assets: [] };
    const { container } = renderAssets();
    expect(await axeClean(container)).toHaveNoViolations();
  });
});

describe('Assets filter/search a11y (US-ASSET-02)', () => {
  // Finding 1: filter chips expose aria-pressed (active state not color-only) via
  // the shared FilterChip primitive, so a screen reader can tell which is active.
  it('marks the active folder filter with aria-pressed and toggles it on click', async () => {
    const user = userEvent.setup();
    assetsState = ONE_ASSET;
    renderAssets();
    // The usage/aspect filter group is its own labeled group (distinct from the A4
    // media-type group, which also has an "All" chip), so scope the query to it.
    const usageGroup = screen.getByRole('group', { name: /usage/i });
    const all = within(usageGroup).getByRole('button', { name: /all/i });
    const unused = within(usageGroup).getByRole('button', { name: /unused/i });
    // "All" is the default selection.
    expect(all).toHaveAttribute('aria-pressed', 'true');
    expect(unused).toHaveAttribute('aria-pressed', 'false');
    await user.click(unused);
    expect(unused).toHaveAttribute('aria-pressed', 'true');
    expect(all).toHaveAttribute('aria-pressed', 'false');
  });

  // Finding 2: the search field carries an accessible name (not just a placeholder),
  // so it is reachable by accessible name, not only by placeholder text.
  it('gives the search input an accessible name', () => {
    assetsState = ONE_ASSET;
    renderAssets();
    expect(screen.getByRole('textbox', { name: /search/i })).toBeInTheDocument();
  });

  // Finding 3: the per-file upload status list is a polite live region so each
  // row's state change (uploading -> done/error) is announced to a screen reader.
  it('announces upload status via a polite live region', async () => {
    const user = userEvent.setup();
    assetsState = ONE_ASSET;
    const { container } = renderAssets();
    const fileInput = container.querySelector('input[type="file"]');
    const file = new File(['x'], 'new-clip.mp4', { type: 'video/mp4' });
    await user.upload(fileInput, file);
    const live = await screen.findByRole('status');
    expect(live.tagName).toBe('UL');
    expect(live).toHaveAttribute('aria-live', 'polite');
  });
});
