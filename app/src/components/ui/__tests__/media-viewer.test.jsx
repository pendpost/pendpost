import { render as baseRender, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MediaPlayer } from '../MediaPlayer.jsx';
import { MediaLightbox } from '../MediaLightbox.jsx';
import { TooltipProvider } from '../Tooltip.jsx';
import { PostPreview } from '../../ui.jsx';

// The custom player replaces native <video controls> so the controls can auto-hide
// for frame inspection; the lightbox gives video AND images a full-viewport view.
// useT falls back to the English baseline without a provider, so aria-labels assert
// against the real strings. The player's icon controls are wrapped in <Tip>, which
// needs a TooltipProvider in scope (the real app provides one at the root), so every
// render here is wrapped - the `wrapper` option carries through to rerender too.
const render = (ui, options) => baseRender(ui, { wrapper: TooltipProvider, ...options });

describe('MediaPlayer (custom auto-hiding controls)', () => {
  it('renders a real <video> with the src and custom controls (no native controls attr)', () => {
    const { container } = render(<MediaPlayer src="blob:vid" aspect="aspect-[9/16]" />);
    const video = container.querySelector('video');
    expect(video).toBeTruthy();
    expect(video.getAttribute('src')).toBe('blob:vid');
    expect(video.hasAttribute('controls')).toBe(false);
    expect(video.className).toContain('aspect-[9/16]');
    expect(screen.getByRole('button', { name: 'Play' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Seek' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mute' })).toBeInTheDocument();
  });

  it('shows the expand affordance only when onExpand is provided, and fires it', () => {
    const onExpand = vi.fn();
    const { rerender } = render(<MediaPlayer src="blob:vid" />);
    expect(screen.queryByRole('button', { name: 'Full screen' })).not.toBeInTheDocument();
    rerender(<MediaPlayer src="blob:vid" onExpand={onExpand} />);
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });
});

describe('MediaLightbox (full-viewport viewer)', () => {
  it('renders a full-size image and a close control for an image', () => {
    const onClose = vi.fn();
    render(<MediaLightbox kind="image" src="blob:img" onClose={onClose} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toBeInTheDocument();
    expect(dialog.querySelector('img').getAttribute('src')).toBe('blob:img');
    fireEvent.click(screen.getByRole('button', { name: 'Exit full screen' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape without letting it bubble to an underlying panel', () => {
    const onClose = vi.fn();
    render(<MediaLightbox kind="image" src="blob:img" onClose={onClose} />);
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    const stop = vi.spyOn(event, 'stopPropagation');
    screen.getByRole('dialog').querySelector('[tabindex="-1"]').dispatchEvent(event);
    expect(onClose).toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
  });
});

// Spec 05: an album is reviewed slide by slide, and the slides are often text-bearing
// information cards, so reading them at full size IS the review job. Without stepping
// that costs one open/close cycle per slide. The viewer stays STATELESS - the caller
// owns the index - so there is only ever one source of truth for "which slide".
describe('MediaLightbox as an album viewer', () => {
  const gallery = (extra = {}) => (
    <MediaLightbox kind="image" src="blob:s3" count={7} index={2} onIndex={extra.onIndex} onClose={extra.onClose || (() => {})} />
  );

  it('stays byte-identical for a single-source caller (no stepper, no readout)', () => {
    render(<MediaLightbox kind="image" src="blob:img" onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Next slide' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Previous slide' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Slide \d+ of \d+/)).not.toBeInTheDocument();
  });

  it('shows a stepper and the position only when the caller passes a count and a handler', () => {
    const onIndex = vi.fn();
    render(gallery({ onIndex }));
    expect(screen.getByRole('button', { name: 'Previous slide' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next slide' })).toBeInTheDocument();
    expect(screen.getByText('Slide 3 of 7')).toBeInTheDocument();
  });

  it('reports the next and previous index to the caller rather than moving itself', () => {
    const onIndex = vi.fn();
    render(gallery({ onIndex }));
    fireEvent.click(screen.getByRole('button', { name: 'Next slide' }));
    expect(onIndex).toHaveBeenCalledWith(3);
    fireEvent.click(screen.getByRole('button', { name: 'Previous slide' }));
    expect(onIndex).toHaveBeenCalledWith(1);
  });

  it('wraps at both ends, so a reviewer is never stuck on the last slide', () => {
    const onIndex = vi.fn();
    const { rerender } = render(<MediaLightbox kind="image" src="s" count={3} index={2} onIndex={onIndex} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Next slide' }));
    expect(onIndex).toHaveBeenCalledWith(0);
    rerender(<MediaLightbox kind="image" src="s" count={3} index={0} onIndex={onIndex} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Previous slide' }));
    expect(onIndex).toHaveBeenCalledWith(2);
  });

  it('steps on the arrow keys and stops them bubbling to the panel underneath', () => {
    const onIndex = vi.fn();
    render(gallery({ onIndex }));
    const panel = screen.getByRole('dialog').querySelector('[tabindex="-1"]');
    for (const [key, expected] of [['ArrowRight', 3], ['ArrowLeft', 1]]) {
      const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      const stop = vi.spyOn(event, 'stopPropagation');
      panel.dispatchEvent(event);
      expect(onIndex).toHaveBeenCalledWith(expected);
      expect(stop).toHaveBeenCalled();
    }
  });

  it('ignores the arrow keys for a single-source caller (no accidental capture)', () => {
    const onClose = vi.fn();
    render(<MediaLightbox kind="image" src="blob:img" onClose={onClose} />);
    const panel = screen.getByRole('dialog').querySelector('[tabindex="-1"]');
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('still closes on Escape while in album mode', () => {
    const onClose = vi.fn();
    render(gallery({ onIndex: vi.fn(), onClose }));
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    screen.getByRole('dialog').querySelector('[tabindex="-1"]').dispatchEvent(event);
    expect(onClose).toHaveBeenCalled();
  });
});

describe('PostPreview integration', () => {
  it('opens the fullscreen viewer when the inline player is expanded', () => {
    render(<PostPreview post={{ type: 'reel', platforms: ['instagram'], media: { url: 'blob:abc', cover: null, file: 'r.mp4' } }} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('renders an image (not a <video>) with an expand affordance for an image asset', () => {
    const { container } = render(<PostPreview post={{ type: 'video', platforms: ['instagram'], media: { url: 'photo.jpg', kind: 'image', file: 'photo.jpg' } }} />);
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('img').getAttribute('src')).toBe('photo.jpg');
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
