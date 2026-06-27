// US-ASSET-13 follow-up (client half): the Composer VideoPicker (trigger + grid)
// and the Assets library AssetCard must NEVER show a bare Clapperboard icon for a
// cover-less video. They reuse CoverThumb, so a cover-less asset paints the
// video's own first frame (a <video>), exactly like the planner/preview lists.
// A covered asset still shows its cover <img>. Server auto-cover (the other half)
// makes this rare, but the client must degrade to a real preview, never an icon.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { axeClean } from '../test-utils/axe.js';
import { TooltipProvider } from '../components/ui/Tooltip.jsx';
import { AssetCard } from '../components/Assets.jsx';
import { VideoPicker } from '../components/Composer.jsx';

const noop = () => {};

// A cover-less video asset, as scanAssets() returns it when no <base>.jpg exists.
const coverless = {
  file: 'reel.mp4',
  url: '/media?p=data%2Fmedia%2Freel.mp4',
  cover: null,
  bytes: 2_400_000,
  modifiedAt: '2026-06-18T09:00:00.000Z',
  probe: { width: 1080, height: 1920, durationSec: 7 },
  checks: { resolution: 'story-9x16', codecOk: true, faststart: true },
  usedBy: [],
  captions: [],
};
const covered = {
  ...coverless,
  file: 'covered.mp4',
  url: '/media?p=data%2Fmedia%2Fcovered.mp4',
  cover: '/media?p=data%2Fmedia%2Fcovered.jpg',
};

const renderCard = (asset) => render(
  <TooltipProvider>
    <AssetCard asset={asset} dir="data/media" onAttach={noop} onDelete={noop} onRename={noop} />
  </TooltipProvider>,
);
const renderPicker = (value) => render(
  <TooltipProvider>
    <VideoPicker assets={[coverless]} assetsDir="data/media" value={value} onChange={noop} />
  </TooltipProvider>,
);
const clapperboard = (root) => root.querySelector('.lucide-clapperboard');

describe('Assets AssetCard cover-less fallback', () => {
  it('paints the video first frame, never a bare clapperboard', () => {
    const { container } = renderCard(coverless);
    expect(clapperboard(container)).toBeNull();
    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    expect(video.getAttribute('src')).toContain('reel.mp4');
  });

  it('still shows the cover image when a cover exists', () => {
    const { container } = renderCard(covered);
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toContain('covered.jpg');
  });

  it('has no accessibility violations for a cover-less card', async () => {
    const { container } = renderCard(coverless);
    expect(await axeClean(container)).toHaveNoViolations();
  });
});

describe('Composer VideoPicker cover-less fallback', () => {
  it('the trigger paints the first frame of a cover-less selection, never a clapperboard', () => {
    const { container } = renderPicker('data/media/reel.mp4');
    expect(clapperboard(container)).toBeNull();
    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    expect(video.getAttribute('src')).toContain('reel.mp4');
  });

  it('the grid cell paints the first frame of a cover-less asset, never a clapperboard', async () => {
    const user = userEvent.setup();
    renderPicker('');
    await user.click(screen.getByRole('button', { name: /choose video/i }));
    const grid = await screen.findByText('reel.mp4');
    const cell = grid.closest('button');
    expect(cell.querySelector('.lucide-clapperboard')).toBeNull();
    const video = cell.querySelector('video');
    expect(video).not.toBeNull();
    expect(video.getAttribute('src')).toContain('reel.mp4');
  });
});
