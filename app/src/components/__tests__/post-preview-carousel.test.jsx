import { render as baseRender, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { PostPreview } from '../ui.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { axeClean } from '../../test-utils/axe.js';

// The headline bug. A carousel's DTO has media.url === null and media.file === null,
// because both derive from the single file/path an album never has. PostPreview had no
// carousel branch, so a complete, on-disk, publishable 7-slide album fell through to the
// red "No media selected" alert - and that was the SECOND time a per-type render
// stranded on that type-blind error state (text posts were the first).
const render = (ui, options) => baseRender(ui, { wrapper: TooltipProvider, ...options });

const slide = (n, { url = `/media?p=s${n}.png`, resolution = 'feed-4x5' } = {}) => ({
  file: `s${n}.png`, path: `/abs/s${n}.png`, exists: Boolean(url), url, bytes: 1024, resolution,
});
const album = (items, extra = {}) => ({
  type: 'carousel',
  platforms: ['instagram'],
  campaign: 'c',
  id: 'p',
  media: { file: null, url: null, cover: null, path: null, bytes: null, resolution: null, exists: true, items },
  ...extra,
});

describe('PostPreview for a healthy album', () => {
  const items = [slide(1), slide(2), slide(3), slide(4), slide(5), slide(6), slide(7)];

  it('does NOT render an error, and never says "No media selected"', () => {
    render(<PostPreview post={album(items)} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('No media selected')).not.toBeInTheDocument();
  });

  it('shows the slide count and the album\'s REAL measured ratio', () => {
    render(<PostPreview post={album(items)} />);
    expect(screen.getByText(/7 slides/)).toBeInTheDocument();
    // The slides are 4:5 on disk. The old label claimed 1:1.
    expect(screen.getByText(/4:5/)).toBeInTheDocument();
  });

  it('frames the album at the probed aspect, not a hardcoded square', () => {
    const { container } = render(<PostPreview post={album(items)} />);
    expect(container.querySelector('.aspect-\\[4\\/5\\]')).toBeTruthy();
    expect(container.querySelector('.aspect-square')).toBeNull();
  });

  it('paints slide 1 first and offers one navigation control per slide', () => {
    // Decorative images carry alt="" (role=presentation), so query the tag: the album's
    // meaning is the caption and the slide numbers, not an alt string per slide.
    const { container } = render(<PostPreview post={album(items)} />);
    expect(container.querySelector('img').getAttribute('src')).toBe('/media?p=s1.png');
    expect(screen.getByRole('button', { name: 'Show slide 1' })).toHaveAttribute('aria-current', 'true');
    expect(screen.getAllByRole('button', { name: /^Show slide \d+$/ })).toHaveLength(7);
  });

  it('moves the frame when another slide is chosen, without changing the frame height', () => {
    const { container } = render(<PostPreview post={album(items)} />);
    const track = container.querySelector('[style*="translateX"]');
    expect(track.getAttribute('style')).toContain('translateX(-0%)');
    fireEvent.click(screen.getByRole('button', { name: 'Show slide 5' }));
    expect(container.querySelector('[style*="translateX"]').getAttribute('style')).toContain('translateX(-400%)');
    expect(screen.getByRole('button', { name: 'Show slide 5' })).toHaveAttribute('aria-current', 'true');
    // The frame box is unchanged: only the track moved (a fixed layout, so the sticky
    // media column cannot reflow between slides).
    expect(container.querySelector('.aspect-\\[4\\/5\\]')).toBeTruthy();
  });

  it('announces the position for assistive tech', () => {
    render(<PostPreview post={album(items)} />);
    expect(screen.getByText('Slide 1 of 7')).toBeInTheDocument();
  });

  it('opens the full-screen viewer on the active slide and steps inside it', () => {
    render(<PostPreview post={album(items)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show slide 3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector('img').getAttribute('src')).toBe('/media?p=s3.png');
    fireEvent.click(screen.getByRole('button', { name: 'Next slide' }));
    expect(screen.getByRole('dialog').querySelector('img').getAttribute('src')).toBe('/media?p=s4.png');
  });

  it('offers no recovery control when there is nothing wrong', () => {
    render(<PostPreview post={album(items)} onEdit={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Open in editor' })).not.toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<PostPreview post={album(items)} />);
    expect(await axeClean(container)).toHaveNoViolations();
  });
});

describe('PostPreview album states that used to be dead ends', () => {
  it('an empty album is an empty state with a recovery control, not a red error', () => {
    const onEdit = vi.fn();
    render(<PostPreview post={album([])} onEdit={onEdit} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(/No slides yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open in editor' }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it('a one-slide album STILL SHOWS the real slide and says two are needed', () => {
    // Data honesty: never hide healthy data behind a warning. The slide is real.
    const { container } = render(<PostPreview post={album([slide(1)])} onEdit={vi.fn()} />);
    expect(container.querySelector('img').getAttribute('src')).toBe('/media?p=s1.png');
    expect(screen.getByText(/at least 2 to publish/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open in editor' })).toBeInTheDocument();
  });

  it('names the missing slide AND the album-level count when a file is gone', () => {
    const items = [slide(1), { ...slide(2), url: null, exists: false }, slide(3)];
    render(<PostPreview post={album(items)} onEdit={vi.fn()} />);
    expect(screen.getByText('Missing on disk: 1 of 3 slides.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show slide 2' }));
    expect(screen.getByText(/s2\.png/)).toBeInTheDocument();
  });

  it('says so when the slides disagree on shape instead of silently cropping', () => {
    const items = [slide(1, { resolution: 'feed-4x5' }), slide(2, { resolution: 'square-1x1' })];
    render(<PostPreview post={album(items)} />);
    expect(screen.getByText(/Mixed formats/)).toBeInTheDocument();
    // No blocker: a mixed album publishes, it just crops on IG.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('omits the recovery control on a post that is no longer editable', () => {
    render(<PostPreview post={album([])} />);
    expect(screen.queryByRole('button', { name: 'Open in editor' })).not.toBeInTheDocument();
    expect(screen.getByText(/No slides yet/)).toBeInTheDocument();
  });

  it('survives 20 slides (the structural save bound) without a horizontal scroller', () => {
    const items = Array.from({ length: 20 }, (_, n) => slide(n + 1));
    const { container } = render(<PostPreview post={album(items)} />);
    expect(screen.getAllByRole('button', { name: /^Show slide \d+$/ })).toHaveLength(20);
    // The strip WRAPS. An overflow-x container here would scroll the detail view
    // sideways, which the design canon rules out.
    expect(container.querySelector('.flex-wrap')).toBeTruthy();
    expect(container.querySelector('.overflow-x-auto')).toBeNull();
  });
});

describe('PostPreview keeps the red error for a genuinely broken single-media post', () => {
  it('still alerts when a media-backed non-carousel post cannot resolve its file', () => {
    render(<PostPreview post={{ type: 'reel', platforms: ['instagram'], media: { url: null, file: 'gone.mp4', items: [] } }} />);
    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(alert.textContent).toContain('gone.mp4');
  });

  it('still shows the create-mode placeholder when no asset is chosen yet', () => {
    render(<PostPreview post={{ type: 'reel', platforms: ['instagram'], media: null }} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
