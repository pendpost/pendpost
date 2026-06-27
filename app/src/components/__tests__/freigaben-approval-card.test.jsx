import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Freigaben from '../Freigaben.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// B2 part 1: the ApprovalCard must show the post's caption BODY (not just the
// single firstLine detail) AND reuse PostPreview so the reviewer sees the post's
// real shape inline (poster/cover for media-backed; LinkCardPreview for text).
// We mock the write/read layer; lintText returns a CLEAN envelope so the
// advisory brand-lint badge stays silent and does not interfere.
const approvePost = vi.fn(() => Promise.resolve({ ok: true }));
const rejectPost = vi.fn(() => Promise.resolve({ ok: true }));
const lintText = vi.fn(() =>
  Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] }),
);

vi.mock('../../lib/api.js', () => ({
  approvePost: (...a) => approvePost(...a),
  rejectPost: (...a) => rejectPost(...a),
  lintText: (...a) => lintText(...a),
}));

const CAPTION = 'Spring promo headline line\nThis is the full caption body that reviewers need to read before approving.';

const mediaPost = {
  id: 'p1',
  campaign: 'spring',
  title: 'Spring promo',
  caption: CAPTION,
  platforms: ['instagram'],
  approval: 'pending',
  derivedState: 'draft',
  scheduledAt: '2026-07-01T10:00:00Z',
  type: 'reel',
  image: null,
  media: { file: 'reel.mp4', exists: true, bytes: 1000, url: '/media?p=reel.mp4', cover: '/media?p=reel.jpg', path: 'reel.mp4' },
};

const textPost = {
  id: 'p2',
  campaign: 'spring',
  title: 'Article share',
  caption: 'An article worth a LinkedIn share with a meaty caption body line.',
  platforms: ['linkedin'],
  approval: 'pending',
  derivedState: 'draft',
  scheduledAt: '2026-07-02T10:00:00Z',
  type: 'text',
  link: 'https://example.com/blog/post',
  image: 'https://res.cloudinary.com/demo/hero.jpg',
  media: { file: null, exists: false, bytes: null, url: null, cover: null, path: null },
};

function renderFreigaben(posts) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const campaigns = [{ id: 'spring', active: true, posts }];
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <Freigaben campaigns={campaigns} onOpen={() => {}} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  approvePost.mockClear();
  rejectPost.mockClear();
  lintText.mockClear();
});

describe('Freigaben ApprovalCard caption body + inline PostPreview', () => {
  it('renders the full caption body, not just the single firstLine detail', () => {
    renderFreigaben([mediaPost]);
    expect(
      screen.getByText(/This is the full caption body that reviewers need to read/i),
    ).toBeInTheDocument();
  });

  it('renders an inline preview element (poster img / video) for a media-backed post', () => {
    const { container } = renderFreigaben([mediaPost]);
    // The poster/cover path renders an <img>; reserve full <video> for detail.
    const media = container.querySelector('img, video');
    expect(media).toBeTruthy();
  });

  it('renders the LinkCardPreview for a text-type post', () => {
    renderFreigaben([textPost]);
    expect(screen.getByText(/LinkedIn card preview/i)).toBeInTheDocument();
  });

  it('keeps the open-detail button free of nested interactive descendants (no interactive-in-interactive)', () => {
    renderFreigaben([mediaPost]);
    // The open-detail affordance is a button covering the cover + headline + meta.
    const openButtons = screen
      .getAllByRole('button')
      .filter((b) => b.querySelector('img, video') || /Spring promo/.test(b.textContent || ''));
    expect(openButtons.length).toBeGreaterThan(0);
    for (const btn of openButtons) {
      // No button/a/input/select/textarea nested inside the open-detail button.
      expect(within(btn).queryByRole('button')).toBeNull();
      expect(btn.querySelector('button, a, input, select, textarea')).toBeNull();
    }
  });

  it('has no axe violations with caption body + preview present', async () => {
    const { container } = renderFreigaben([mediaPost, textPost]);
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
