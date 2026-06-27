import { render as baseRender, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { PostPreview } from '../ui.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';

// PostPreview's video path renders MediaPlayer, whose icon controls are wrapped in
// <Tip> - so every render needs a TooltipProvider in scope (the app provides one at root).
const render = (ui, options) => baseRender(ui, { wrapper: TooltipProvider, ...options });

// FR3: stories reach reels-level preview parity. The three states must be honest:
//  - EMPTY (create mode, post.media == null): a neutral 9:16 placeholder, NOT an
//    error and NOT role="alert".
//  - LOADED (post.media.url present): the 9:16 <video>.
//  - ERROR (post.media exists but url missing): the red role="alert" panel, and
//    never the literal string "undefined".

describe('PostPreview (FR3 story/reel parity)', () => {
  it('shows a neutral placeholder, not an error, when media is null (create mode)', () => {
    render(<PostPreview post={{ type: 'story', platforms: ['instagram'], media: null }} />);
    expect(screen.getByText(/choose a video to preview/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('renders a 9:16 video when media.url is present', () => {
    const { container } = render(
      <PostPreview post={{ type: 'story', platforms: ['instagram'], media: { url: 'blob:abc', cover: null, file: 'st1.mp4' } }} />,
    );
    const video = container.querySelector('video');
    expect(video).toBeTruthy();
    expect(video.getAttribute('src')).toBe('blob:abc');
    expect(video.className).toContain('aspect-[9/16]');
  });

  it('reserves the red role="alert" error for a media-backed post with no resolvable url', () => {
    render(<PostPreview post={{ type: 'reel', platforms: ['instagram'], media: { file: 'clip-3.mp4', url: null } }} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Local media file not found: clip-3.mp4');
  });

  it('never renders the literal "undefined" when the file name is also missing', () => {
    render(<PostPreview post={{ type: 'reel', platforms: ['instagram'], media: { url: null } }} />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('No media selected');
    expect(alert.textContent).not.toMatch(/undefined/);
  });

  it('routes a text post to the LinkedIn card preview, not the media error', () => {
    render(<PostPreview post={{ type: 'text', platforms: ['linkedin'], title: 'Hello', link: 'https://example.com', image: '' }} />);
    expect(screen.getByText(/linkedin card preview/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
