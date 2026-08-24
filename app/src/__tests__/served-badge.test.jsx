// Post-publish quality badge: ServedBadge surfaces the rendition Instagram
// ACTUALLY served (measured from media_url, see lib/verify.mjs). A thin master
// gets transcoded to 720p (RCA 13.08.2026); the amber pill proves it after the
// fact, the green pill confirms HD. Self-hides when unmeasured. Display-only.
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { TooltipProvider } from '../components/ui/Tooltip.jsx';
import { ServedBadge } from '../components/ui/ServedBadge.jsx';

const renderBadge = (served) => render(
  <TooltipProvider>
    <ServedBadge served={served} />
  </TooltipProvider>,
);

describe('ServedBadge', () => {
  it('shows an amber 720p pill when IG downscaled a vertical reel', () => {
    // The live bondigoo reel: 720x1280 @ ~0.49 Mbps (shorter side 720 -> below HD).
    renderBadge({ width: 720, height: 1280, bitrate: 494884, probedAt: '2026-08-13T18:35:01.403Z' });
    expect(screen.getByText('720p')).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: /likely downscaled/i });
    // amber = "needs attention" in the IconBadge tone palette.
    expect(btn.querySelector('span')).toHaveClass('text-amber-700');
    // measured bitrate is surfaced in the tooltip label.
    expect(btn).toHaveAccessibleName(/0\.5 Mbps/);
  });

  it('shows a green HD pill when IG served full resolution', () => {
    renderBadge({ width: 1080, height: 1920, bitrate: 12_000_000, probedAt: '2026-08-13T18:35:01.403Z' });
    expect(screen.getByText('1080p')).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: /HD confirmed/i });
    expect(btn.querySelector('span')).toHaveClass('text-emerald-700');
  });

  it('self-hides when the rendition was not measured', () => {
    const { container: a } = renderBadge(null);
    expect(a).toBeEmptyDOMElement();
    const { container: b } = renderBadge({ bitrate: 494884 }); // no width/height
    expect(b).toBeEmptyDOMElement();
  });
});
