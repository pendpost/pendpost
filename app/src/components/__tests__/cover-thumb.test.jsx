import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { CoverThumb } from '../ui.jsx';

// US-ASSET-13: a media item must always show a real preview - the cover JPEG when
// present, otherwise the video's own first frame - never a bare lucide icon.
describe('CoverThumb preview fidelity (US-ASSET-13)', () => {
  it('renders the video first frame (not a bare icon) when a video has no cover', () => {
    const { container } = render(<CoverThumb media={{ url: '/media?p=clip.mp4', cover: null }} className="h-10 w-10" />);
    expect(container.querySelector('video')).toBeTruthy();
    expect(container.querySelector('.lucide-clapperboard')).toBeNull();
  });

  it('renders the cover image when one is present', () => {
    const { container } = render(<CoverThumb media={{ cover: '/media?p=clip.jpg', url: '/media?p=clip.mp4' }} className="h-10 w-10" />);
    expect(container.querySelector('img')).toBeTruthy();
    expect(container.querySelector('video')).toBeNull();
  });

  it('renders a neutral tile (no icon) when there is no media at all', () => {
    const { container } = render(<CoverThumb media={null} image={null} className="h-10 w-10" />);
    expect(container.querySelector('.lucide-clapperboard')).toBeNull();
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  // The cover-less <video> seeks to the 20% frame once metadata loads, so the
  // painted preview shows real content past blank intros - matching the server
  // auto-cover default. jsdom has no real media engine, so we stub duration and
  // capture the seek the handler performs on currentTime.
  const fireLoadedMetadata = (duration) => {
    const { container } = render(<CoverThumb media={{ url: '/media?p=clip.mp4', cover: null }} className="h-10 w-10" />);
    const video = container.querySelector('video');
    let seeked = 0;
    Object.defineProperty(video, 'duration', { configurable: true, value: duration });
    Object.defineProperty(video, 'currentTime', { configurable: true, get: () => seeked, set: (v) => { seeked = v; } });
    video.dispatchEvent(new Event('loadedmetadata'));
    return seeked;
  };

  it('seeks a cover-less preview to 20% of the clip duration', () => {
    expect(fireLoadedMetadata(10)).toBe(2);
  });

  it('falls back to a 0.1s nudge when the duration is unknown', () => {
    expect(fireLoadedMetadata(NaN)).toBe(0.1);
  });
});
