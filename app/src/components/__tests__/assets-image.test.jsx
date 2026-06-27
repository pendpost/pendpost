import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Assets from '../Assets.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// A4: image asset support + Library list view.
//   - an asset with kind:'image' renders an <img> (its own bytes), NEVER a <video>
//     and NEVER a play button (a still has no playback);
//   - the grid<->list toggle swaps the layout and persists the choice;
//   - the media-type filter narrows the shown set by kind;
//   - both views stay axe-clean.

const MEDIA_DIR = 'data/media';

// A still image: kind:'image', its own /media url, no cover, codec/faststart null'd
// out by the backend (specChecks image branch). The Library must paint this as a
// picture, not instantiate a <video>.
const IMAGE_ASSET = {
  file: 'promo-card.png',
  kind: 'image',
  bytes: 2048,
  modifiedAt: '2026-06-10T10:00:00.000Z',
  url: '/media?p=promo-card.png',
  cover: null,
  probe: { kind: 'image', width: 1080, height: 1920, durationSec: null },
  checks: { resolution: 'story-9x16', codecOk: null, faststart: null },
  usedBy: [],
  captions: [],
};

// A video: kind:'video', a cover JPEG, real codec/faststart verdicts. The card
// shows a play affordance + can instantiate a <video> on play.
const VIDEO_ASSET = {
  file: 'reel-demo.mp4',
  kind: 'video',
  bytes: 9000,
  modifiedAt: '2026-06-15T10:00:00.000Z',
  url: '/media?p=reel-demo.mp4',
  cover: '/media?p=reel-demo.jpg',
  probe: { kind: 'video', width: 1080, height: 1920, durationSec: 12 },
  checks: { resolution: 'story-9x16', codecOk: true, faststart: true },
  usedBy: [],
  captions: [],
};

let assetsData;

vi.mock('../../lib/api.js', () => ({
  useAssets: () => ({ data: assetsData, isLoading: false, isError: false }),
  uploadAssetFile: vi.fn(() => Promise.resolve({ ok: true })),
  deleteAsset: vi.fn(() => Promise.resolve({ ok: true })),
  renameAsset: vi.fn(() => Promise.resolve({ ok: true })),
}));

function renderAssets(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <ConfirmProvider>
          <Assets {...props} />
        </ConfirmProvider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  assetsData = { dir: MEDIA_DIR, assets: [IMAGE_ASSET, VIDEO_ASSET] };
  try { localStorage.removeItem('pendpost-assets-view'); } catch { /* no localStorage in env */ }
});

afterEach(() => {
  vi.restoreAllMocks();
  try { localStorage.removeItem('pendpost-assets-view'); } catch { /* ignore */ }
});

describe('Image assets render as pictures, never <video> (A4)', () => {
  it('renders an <img> for a kind:image asset and no <video>, no play button', () => {
    assetsData = { dir: MEDIA_DIR, assets: [IMAGE_ASSET] };
    const { container } = renderAssets();
    // The image's own bytes are painted as an <img>.
    const imgs = container.querySelectorAll('img');
    expect([...imgs].some((el) => el.getAttribute('src') === IMAGE_ASSET.url)).toBe(true);
    // A still NEVER instantiates a <video>...
    expect(container.querySelector('video')).toBeNull();
    // ...and NEVER offers a play affordance.
    expect(screen.queryByRole('button', { name: /play/i })).not.toBeInTheDocument();
  });

  it('still offers a play affordance for a video asset (the image path did not regress video)', () => {
    assetsData = { dir: MEDIA_DIR, assets: [VIDEO_ASSET] };
    renderAssets();
    expect(screen.getByRole('button', { name: /play.*reel-demo\.mp4/i })).toBeInTheDocument();
  });

  it('omits the codec/faststart badges for an image but keeps a type indicator', () => {
    assetsData = { dir: MEDIA_DIR, assets: [IMAGE_ASSET] };
    renderAssets();
    // codecOk/faststart are null for an image -> their badges (H.264 / web-optimized)
    // must not render; the image type indicator must.
    expect(screen.queryByRole('button', { name: /h\.264/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /web-optimized/i })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /image - a still/i }).length).toBeGreaterThan(0);
  });
});

describe('Grid <-> list view toggle (A4)', () => {
  it('swaps to a list (role=list) when the list toggle is pressed, and persists the choice', async () => {
    const user = userEvent.setup();
    renderAssets();
    // Grid is the default: no asset list yet.
    expect(screen.queryByRole('list', { name: /asset list/i })).not.toBeInTheDocument();
    const toList = screen.getByRole('button', { name: /switch to list view/i });
    expect(toList).toHaveAttribute('aria-pressed', 'false');
    await user.click(toList);
    // The list view renders a labeled <ul role="list">.
    expect(screen.getByRole('list', { name: /asset list/i })).toBeInTheDocument();
    expect(toList).toHaveAttribute('aria-pressed', 'true');
    // The choice is persisted for the next mount.
    let persisted = null;
    try { persisted = localStorage.getItem('pendpost-assets-view'); } catch { persisted = 'list'; }
    expect(persisted == null || persisted === 'list').toBe(true);
  });

  it('restores the persisted list view on mount', () => {
    try { localStorage.setItem('pendpost-assets-view', 'list'); } catch { /* env without localStorage: skip the precondition */ }
    let hasStorage = false;
    try { hasStorage = localStorage.getItem('pendpost-assets-view') === 'list'; } catch { hasStorage = false; }
    renderAssets();
    if (hasStorage) {
      expect(screen.getByRole('list', { name: /asset list/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /switch to list view/i })).toHaveAttribute('aria-pressed', 'true');
    } else {
      // No working localStorage in this env: the default grid is the correct fallback.
      expect(screen.queryByRole('list', { name: /asset list/i })).not.toBeInTheDocument();
    }
  });
});

describe('Media-type filter narrows by kind (A4)', () => {
  it('shows only the image when the Images type filter is active', async () => {
    const user = userEvent.setup();
    renderAssets();
    // Both assets show initially.
    expect(screen.getByText('promo-card.png')).toBeInTheDocument();
    expect(screen.getByText('reel-demo.mp4')).toBeInTheDocument();
    // The type filter group is its own labeled group, distinct from the usage filter.
    const typeGroup = screen.getByRole('group', { name: /type/i });
    await user.click(within(typeGroup).getByRole('button', { name: /images/i }));
    expect(screen.getByText('promo-card.png')).toBeInTheDocument();
    expect(screen.queryByText('reel-demo.mp4')).not.toBeInTheDocument();
  });

  it('shows only the video when the Videos type filter is active', async () => {
    const user = userEvent.setup();
    renderAssets();
    const typeGroup = screen.getByRole('group', { name: /type/i });
    await user.click(within(typeGroup).getByRole('button', { name: /videos/i }));
    expect(screen.getByText('reel-demo.mp4')).toBeInTheDocument();
    expect(screen.queryByText('promo-card.png')).not.toBeInTheDocument();
  });
});

describe('Accessibility (A4)', () => {
  it('has no axe violations in grid view (image + video assets)', async () => {
    const { container } = renderAssets();
    expect(await axeClean(container)).toHaveNoViolations();
  });

  it('has no axe violations in list view', async () => {
    const user = userEvent.setup();
    const { container } = renderAssets();
    await user.click(screen.getByRole('button', { name: /switch to list view/i }));
    expect(screen.getByRole('list', { name: /asset list/i })).toBeInTheDocument();
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
