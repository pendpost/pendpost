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
