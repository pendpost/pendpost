import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { axeClean } from '../../test-utils/axe.js';
import Composer from '../Composer.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// B1 (ux-audit dim-6 P1): six per-lane prose overrides the engines already
// publish (tgCaption/dcCaption/ttCaption/redditText/pinTitle/pinDescription)
// were writable via MCP but invisible in the app - an agent could ship text the
// approver never saw. The Composer now offers each as a per-lane override field
// following the existing xCaption/mastodonCaption pattern: shown only when the
// lane is targeted, single-lane-collapsed while empty, saved with the post.
vi.mock('../../lib/api.js', () => ({
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  useAssets: () => ({ data: { dir: '/tmp/assets', assets: [] } }),
  useConfig: () => ({ data: { posting: { hashtagPresets: [] } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePinterestBoardSections: () => ({ data: undefined, isLoading: false }),
  createPost: vi.fn(() => Promise.resolve({ ok: true })),
  updatePost: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, findings: [] })),
}));

import { updatePost } from '../../lib/api.js';

const LABEL = {
  tgCaption: 'Message text (Telegram)',
  dcCaption: 'Message text (Discord)',
  ttCaption: 'Caption (TikTok)',
  redditText: 'Post text (Reddit)',
  pinTitle: 'Pin title (Pinterest)',
  pinDescription: 'Pin description (Pinterest)',
};

function basePost(platforms, extra = {}) {
  return {
    id: 'p1',
    campaign: 'launch',
    type: 'video',
    platforms,
    approval: 'draft',
    derivedState: 'scheduled',
    scheduledAt: '2026-07-01T10:00:00Z',
    caption: 'a caption',
    rev: 1,
    media: { file: null, exists: false, url: null, cover: null, path: null },
    ...extra,
  };
}

function renderEditComposer(post, locale = 'en') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale={locale}>
        <TooltipProvider>
          <ConfirmProvider>
            <Composer
              mode="edit"
              post={post}
              campaigns={[{ id: 'launch', active: true, posts: [post] }]}
              onClose={vi.fn()}
              onSaved={vi.fn()}
            />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('Composer — B1 per-lane prose overrides', () => {
  it.each([
    ['telegram', 'tgCaption'],
    ['discord', 'dcCaption'],
    ['tiktok', 'ttCaption'],
    ['reddit', 'redditText'],
  ])('%s: a saved %s renders its override field with the value', (platform, field) => {
    renderEditComposer(basePost([platform], { [field]: 'agent-written text' }));
    expect(screen.getByLabelText(LABEL[field])).toHaveValue('agent-written text');
  });

  it('single-lane collapse: a telegram-only post with an EMPTY override hides tgCaption (one text, one field)', () => {
    renderEditComposer(basePost(['telegram']));
    expect(screen.queryByLabelText(LABEL.tgCaption)).not.toBeInTheDocument();
  });

  it('a multi-lane telegram + discord post offers BOTH overrides even while empty', () => {
    renderEditComposer(basePost(['telegram', 'discord']));
    expect(screen.getByLabelText(LABEL.tgCaption)).toBeInTheDocument();
    expect(screen.getByLabelText(LABEL.dcCaption)).toBeInTheDocument();
  });

  it('pinterest: pinTitle always shows (it shadows the title), pinDescription collapses while empty', () => {
    renderEditComposer(basePost(['pinterest']));
    expect(screen.getByLabelText(LABEL.pinTitle)).toBeInTheDocument();
    expect(screen.queryByLabelText(LABEL.pinDescription)).not.toBeInTheDocument();
  });

  it('pinterest: a saved pinDescription renders', () => {
    renderEditComposer(basePost(['pinterest'], { pinTitle: 'Headline', pinDescription: 'pin copy' }));
    expect(screen.getByLabelText(LABEL.pinTitle)).toHaveValue('Headline');
    expect(screen.getByLabelText(LABEL.pinDescription)).toHaveValue('pin copy');
  });

  it('none of the six fields leak onto an instagram-only post (cognitive-load gating)', () => {
    renderEditComposer(basePost(['instagram']));
    for (const label of Object.values(LABEL)) {
      expect(screen.queryByLabelText(label), label).not.toBeInTheDocument();
    }
  });

  it('save round-trips an edited tgCaption through updatePost', async () => {
    const user = userEvent.setup();
    renderEditComposer(basePost(['telegram', 'discord'], { tgCaption: 'old' }));
    const field = screen.getByLabelText(LABEL.tgCaption);
    await user.clear(field);
    await user.type(field, 'new telegram text');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(updatePost).toHaveBeenCalledWith('launch', 'p1', 1, expect.objectContaining({ tgCaption: 'new telegram text' }));
  });

  it('has no axe violations with the override fields rendered', async () => {
    const { container } = renderEditComposer(basePost(['telegram', 'discord', 'tiktok', 'reddit', 'pinterest'], {
      tgCaption: 't', dcCaption: 'd', ttCaption: 'tt', redditText: 'r', pinTitle: 'pt', pinDescription: 'pd',
    }));
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
