import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import { CompactPostCard } from '../Planner.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import { TooltipProvider } from '../ui/Tooltip.jsx';

// Phase 3 D4: the dense Month chip shows only a glyph, so its status WORD appears on hover
// and on keyboard focus through the shared Tip (never PinTip: that one preventDefaults the
// click to pin its bubble, and the chip's click must open the post). The word is the same
// one the chip's accessible name already speaks (postStatusWord). The chip carries ONE
// tooltip: the inline time chip inside it no longer opens a second bubble with a
// different word.
const post = {
  id: 'p1', campaign: 'c', type: 'text', platforms: ['linkedin'], caption: 'Fresh sourdough every Saturday.',
  title: 'Sourdough', scheduledAt: '2026-09-20T10:00:00Z', approval: 'pending', derivedState: 'pending',
};

function renderChip(onSelect, p = post) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <CompactPostCard post={p} onSelect={onSelect} dayLabel="Sun 20" />
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('Month chip status word (D4)', () => {
  it('keyboard focus shows the status word as a tooltip', async () => {
    const user = userEvent.setup();
    renderChip(vi.fn());
    await user.tab();
    const chip = screen.getByRole('button', { name: /Sourdough, Awaiting approval/ });
    expect(chip).toHaveFocus();
    const tips = await screen.findAllByRole('tooltip');
    expect(tips).toHaveLength(1);
    expect(tips[0]).toHaveTextContent('Awaiting approval');
  });

  it('hover shows the same one word, even over the inner time chip', async () => {
    const user = userEvent.setup();
    renderChip(vi.fn());
    const chip = screen.getByRole('button', { name: /Sourdough, Awaiting approval/ });
    await user.hover(chip.querySelector('[role="img"]') || chip);
    const tips = await screen.findAllByRole('tooltip');
    expect(tips).toHaveLength(1);
    expect(tips[0]).toHaveTextContent('Awaiting approval');
  });

  it('a click still opens the post', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    renderChip(onSelect);
    await user.click(screen.getByRole('button', { name: /Sourdough, Awaiting approval/ }));
    expect(onSelect).toHaveBeenCalledWith(post);
  });
});

// Tap target (orchestrator decision): the browser flow measured the Month chip at 23px tall,
// under both the house 44px rule and WCAG 2.5.8's 24px minimum. On a coarse pointer (touch)
// the chip is at least 44px tall; on a fine pointer at least 24px (WCAG AA). Tailwind 3.4 has
// no pointer-coarse variant, so the coarse rule is an arbitrary media variant. Nothing else
// about the chip changes.
describe('Month chip tap target', () => {
  it('is at least 24px on a fine pointer and 44px on a coarse pointer', () => {
    renderChip(vi.fn());
    const tokens = screen.getByRole('button', { name: /Sourdough, Awaiting approval/ }).className.split(/\s+/);
    expect(tokens).toContain('min-h-6');
    expect(tokens).toContain('[@media(pointer:coarse)]:min-h-11');
    // The layout the chip had keeps: one centred row, same padding.
    expect(tokens).toEqual(expect.arrayContaining(['flex', 'items-center', 'px-1.5', 'py-0.5']));
  });
});

// Owner pick 2026-11-04: a published chip's tip carries the way to the live post. Only a
// provable link (resolveLivePermalink) ever shows; an unpublished chip keeps the bare word.
describe('Published chip tip: View live link', () => {
  const pub = { ...post, approval: 'approved', derivedState: 'posted', status: 'posted', permalinks: { linkedin: 'https://www.linkedin.com/feed/update/urn:li:share:1' } };

  it('a published post shows one "View live" link to its permalink', async () => {
    const user = userEvent.setup();
    renderChip(vi.fn(), pub);
    await user.hover(screen.getByRole('button', { name: /Sourdough, Published/ }));
    const tip = (await screen.findAllByRole('tooltip'))[0];
    expect(tip).toHaveTextContent('Published');
    const links = document.querySelectorAll('[data-live-link="linkedin"]');
    expect(links.length).toBeGreaterThan(0);
    expect(links[0].getAttribute('href')).toBe(pub.permalinks.linkedin);
    expect(links[0].getAttribute('target')).toBe('_blank');
    expect(links[0]).toHaveTextContent('View live');
  });

  it('several published lanes get one link each, named by platform', async () => {
    const user = userEvent.setup();
    renderChip(vi.fn(), { ...pub, platforms: ['linkedin', 'x'], permalinks: { ...pub.permalinks, x: 'https://x.com/i/status/1' } });
    await user.hover(screen.getByRole('button', { name: /Sourdough, Published/ }));
    await screen.findAllByRole('tooltip');
    expect(document.querySelector('[data-live-link="x"]')).not.toBeNull();
    expect(document.querySelector('[data-live-link="linkedin"]')).toHaveTextContent('LinkedIn');
  });

  it('a published post with no provable link, and an unpublished one, show no link', async () => {
    const user = userEvent.setup();
    const { unmount } = renderChip(vi.fn(), { ...pub, permalinks: {} });
    await user.hover(screen.getByRole('button', { name: /Sourdough, Published/ }));
    await screen.findAllByRole('tooltip');
    expect(document.querySelector('[data-live-link]')).toBeNull();
    unmount();
    renderChip(vi.fn(), { ...post, permalinks: pub.permalinks });
    await user.hover(screen.getByRole('button', { name: /Sourdough, Awaiting approval/ }));
    await screen.findAllByRole('tooltip');
    expect(document.querySelector('[data-live-link]')).toBeNull();
  });
});

