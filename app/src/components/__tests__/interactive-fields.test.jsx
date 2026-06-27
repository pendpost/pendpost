import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Composer, { InteractiveFields } from '../Composer.jsx';
import { PostPreview } from '../ui.jsx';
import { StoryStickerLayer } from '../ui/StoryStickerLayer.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// B10 Part A: the Composer must wire the InteractiveFields globalHashtags prop
// from the active client's config (config.posting.hashtagPresets) instead of the
// hardcoded [] - so the global-mode panel shows the real presets, not the empty
// fallback. We mock the api layer (including useConfig) and assert the joined
// presets render once an IG-story draft is composed.
vi.mock('../../lib/api.js', () => ({
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  useAssets: () => ({ data: { assets: [], dir: '/tmp/assets' } }),
  useConfig: () => ({ data: { posting: { hashtagPresets: ['#brand', '#launch'] } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  createPost: vi.fn(() => Promise.resolve({ ok: true })),
  updatePost: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, findings: [] })),
}));

// FR4: interactive-story authoring (Composer InteractiveFields) + the preview
// overlay (StoryStickerLayer in PostPreview). Honest per-platform applicability:
// mention is API-supported on IG; every other sticker is preview-only.

function renderPanel(props = {}) {
  const onStickersChange = vi.fn();
  const onHashtagsModeChange = vi.fn();
  const onHashtagsChange = vi.fn();
  const utils = render(
    <TooltipProvider>
      <InteractiveFields
        stickers={[]}
        onStickersChange={onStickersChange}
        hashtagsMode="global"
        onHashtagsModeChange={onHashtagsModeChange}
        hashtags=""
        onHashtagsChange={onHashtagsChange}
        globalHashtags={['#brand', '#launch']}
        {...props}
      />
    </TooltipProvider>,
  );
  return { ...utils, onStickersChange, onHashtagsModeChange, onHashtagsChange };
}

describe('InteractiveFields (FR4 authoring)', () => {
  it('renders the Add sticker menu and adds a poll with its fields', async () => {
    const user = userEvent.setup();
    const { onStickersChange } = renderPanel();
    await user.click(screen.getByRole('button', { name: /add sticker/i }));
    await user.click(screen.getByRole('button', { name: 'Poll' }));
    expect(onStickersChange).toHaveBeenCalledWith([
      { kind: 'poll', question: '', options: ['', ''] },
    ]);
  });

  it('shows the poll fields (question + two options) for an existing poll sticker', () => {
    renderPanel({ stickers: [{ kind: 'poll', question: 'Yes/No?', options: ['Yes', 'No'] }] });
    expect(screen.getByLabelText('Poll question')).toHaveValue('Yes/No?');
    expect(screen.getByLabelText('Poll option 1')).toHaveValue('Yes');
    expect(screen.getByLabelText('Poll option 2')).toHaveValue('No');
  });

  it('labels mention as API-supported and a poll as preview-only (honest applicability)', () => {
    renderPanel({ stickers: [{ kind: 'mention', handle: '@acme' }] });
    expect(screen.getByText('API: supported')).toBeInTheDocument();
    expect(screen.queryByText(/preview-only/i)).not.toBeInTheDocument();

    renderPanel({ stickers: [{ kind: 'link', url: '', label: '' }] });
    expect(screen.getByText(/preview-only/i)).toBeInTheDocument();
  });

  it('shows the inherited global presets read-only in global mode', () => {
    renderPanel({ hashtagsMode: 'global', globalHashtags: ['#brand', '#launch'] });
    expect(screen.getByText('#brand #launch')).toBeInTheDocument();
    expect(screen.queryByLabelText('Per-post hashtags')).not.toBeInTheDocument();
  });

  it('reveals the custom per-post hashtags field in custom mode', () => {
    renderPanel({ hashtagsMode: 'custom', hashtags: '#a #b' });
    expect(screen.getByLabelText('Per-post hashtags')).toHaveValue('#a #b');
  });

  it('toggles from global to custom via the checkbox', async () => {
    const user = userEvent.setup();
    const { onHashtagsModeChange } = renderPanel({ hashtagsMode: 'global' });
    await user.click(screen.getByRole('checkbox', { name: /use global hashtag presets/i }));
    expect(onHashtagsModeChange).toHaveBeenCalledWith('custom');
  });

  it('has no axe violations', async () => {
    const { container } = renderPanel({ stickers: [{ kind: 'poll', question: 'Q', options: ['Y', 'N'] }] });
    expect(await axeClean(container)).toHaveNoViolations();
  });
});

describe('Composer wires globalHashtags from config (B10 Part A)', () => {
  function renderComposer(props = {}) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <ConfirmProvider>
            <Composer
              mode="create"
              post={null}
              campaigns={[{ id: 'launch', active: true, posts: [] }]}
              onClose={vi.fn()}
              onSaved={vi.fn()}
              {...props}
            />
          </ConfirmProvider>
        </TooltipProvider>
      </QueryClientProvider>,
    );
  }

  it('shows config.posting.hashtagPresets joined in the global-mode panel', async () => {
    const user = userEvent.setup();
    renderComposer();
    // Default IG is selected; switch the type to story so InteractiveFields shows.
    await user.selectOptions(screen.getByLabelText('Format'), 'story');
    // Global mode is the default; the panel must show the real presets, not the
    // composer.hashtags.noGlobal fallback (which Composer.jsx hardcoded [] today).
    expect(await screen.findByText('#brand #launch')).toBeInTheDocument();
    expect(screen.queryByText(/No global presets configured/i)).not.toBeInTheDocument();
  });
});

describe('StoryStickerLayer + PostPreview overlay (FR4 preview)', () => {
  it('renders an aria-hidden overlay with the honest manual-add caption', () => {
    const { container } = render(
      <StoryStickerLayer interactiveStory={{ stickers: [{ kind: 'poll', question: 'Q', options: ['Y', 'N'] }] }} />,
    );
    expect(screen.getByText(/add stickers manually in instagram/i)).toBeInTheDocument();
    expect(container.querySelector('[aria-hidden="true"]')).toBeTruthy();
  });

  it('renders nothing without stickers', () => {
    const { container } = render(<StoryStickerLayer interactiveStory={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('overlays stickers on the story preview video', () => {
    render(
      <TooltipProvider>
        <PostPreview
          post={{
            type: 'story',
            platforms: ['instagram'],
            media: { url: 'blob:abc', cover: null, file: 'st1.mp4' },
            interactiveStory: { stickers: [{ kind: 'link', url: 'https://x.com', label: 'Shop' }] },
          }}
        />
      </TooltipProvider>,
    );
    expect(screen.getByText('Shop')).toBeInTheDocument();
  });

  it('does not overlay stickers on a non-story type', () => {
    render(
      <TooltipProvider>
        <PostPreview
          post={{
            type: 'reel',
            platforms: ['instagram'],
            media: { url: 'blob:abc', cover: null, file: 'r1.mp4' },
            interactiveStory: { stickers: [{ kind: 'link', url: 'https://x.com', label: 'Shop' }] },
          }}
        />
      </TooltipProvider>,
    );
    expect(screen.queryByText('Shop')).not.toBeInTheDocument();
  });
});
