import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Assets from '../Assets.jsx';
import Composer, { srtToText } from '../Composer.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';

// B9: an "Attach to a post" CTA on each asset card pre-seeds the create-mode
// Composer with the asset's media path (and, best-effort, the voiceover SRT cue
// text as a draft caption). The CTA only pre-fills - the sole write stays the
// existing gated createPost path; nothing auto-approves or publishes.

const MEDIA_DIR = 'data/media';
const ASSET = {
  file: 'crm-demo.mp4',
  bytes: 1024,
  url: '/media?p=crm-demo.mp4',
  cover: null,
  probe: { durationSec: 12 },
  checks: { resolution: 'story-9x16', codecOk: true, faststart: true },
  usedBy: [],
  captions: [{ feature: 'crm', file: 'crm-vo-en.srt', variant: null, lang: 'en', srtPath: '/abs/crm-vo-en.srt', srtUrl: '/media?p=crm-vo-en.srt' }],
};
const ASSET_NO_CAPTION = { ...ASSET, file: 'plain.mp4', url: '/media?p=plain.mp4', captions: [] };

let assetsData;

// Assets reads useAssets + uploadAssetFile; Composer additionally reads useConfig,
// createPost, updatePost, lintText. One shared mock module covers both component
// trees so a single render harness works for either.
vi.mock('../../lib/api.js', () => ({
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  useAssets: () => ({ data: assetsData, isLoading: false, isError: false }),
  uploadAssetFile: vi.fn(() => Promise.resolve({ ok: true })),
  deleteAsset: vi.fn(() => Promise.resolve({ ok: true })),
  renameAsset: vi.fn(() => Promise.resolve({ ok: true })),
  useConfig: () => ({ data: { posting: { hashtagPresets: [] } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePinterestBoardSections: () => ({ data: undefined, isLoading: false }),
  createPost: vi.fn(() => Promise.resolve({ ok: true })),
  updatePost: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, findings: [] })),
}));

// Composer pulls useConfirm from ./ui/confirm.jsx; a pass-through provider keeps
// the tree mounting without the real ConfirmProvider plumbing.
vi.mock('../ui/confirm.jsx', async (orig) => {
  const actual = await orig();
  return { ...actual, ConfirmProvider: ({ children }) => children, useConfirm: () => vi.fn(() => Promise.resolve(true)), usePrompt: () => vi.fn(() => Promise.resolve(null)) };
});

function renderAssets(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <Assets {...props} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function renderComposer(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <Composer
          mode="create"
          post={null}
          campaigns={[{ id: 'launch', active: true, posts: [] }]}
          onClose={vi.fn()}
          onSaved={vi.fn()}
          {...props}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  assetsData = { dir: MEDIA_DIR, assets: [ASSET, ASSET_NO_CAPTION] };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('srtToText helper', () => {
  it('strips cue numbers and timecodes to plain text', () => {
    const srt = [
      '1',
      '00:00:00,000 --> 00:00:02,500',
      'Welcome to the CRM demo.',
      '',
      '2',
      '00:00:02,500 --> 00:00:05,000',
      'It saves you hours.',
      '',
    ].join('\n');
    expect(srtToText(srt)).toBe('Welcome to the CRM demo. It saves you hours.');
  });

  it('returns empty string for empty / non-string input', () => {
    expect(srtToText('')).toBe('');
    expect(srtToText(null)).toBe('');
    expect(srtToText(undefined)).toBe('');
  });
});

// U. Building a 7-slide album meant picking each slide from a dropdown inside the
// Composer, one at a time. The library already accepted a ten-file DROP but its attach
// action was single-asset, so the fast way in stopped at the upload.
//
// Multi-select attach REPLACES the one-at-a-time attach; it does not sit beside it. The
// per-card attach CTA is gone, which is why this block's old "renders an Attach CTA per
// card" assertions were rewritten rather than kept: they described the flow being
// replaced.
//
// The selection idiom is Freigaben's, lifted rather than reinvented, including its
// hard-won rule that a bulk action never trusts the raw Set but intersects it with what
// is actually visible and actionable.
describe('Assets multi-select attach (U)', () => {
  it('no longer renders a per-card attach CTA: the selection replaces it', () => {
    renderAssets({ onAttach: vi.fn() });
    expect(screen.queryByRole('button', { name: /attach.*crm-demo\.mp4/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /attach.*plain\.mp4/i })).not.toBeInTheDocument();
  });

  it('shows a selection checkbox per card and no action bar until something is selected', () => {
    renderAssets({ onAttach: vi.fn() });
    expect(screen.getAllByRole('checkbox').length).toBeGreaterThanOrEqual(2);
    // The bar is transient, like the existing drag overlay: at rest the page is quieter.
    expect(screen.queryByRole('button', { name: /attach 1|attach 2|as one post|as an album/i })).not.toBeInTheDocument();
  });

  it('selecting ONE asset attaches it as a single post (the flow being replaced)', async () => {
    const user = userEvent.setup();
    const onAttach = vi.fn();
    renderAssets({ onAttach });
    await user.click(screen.getByRole('checkbox', { name: /crm-demo\.mp4/i }));
    await user.click(screen.getByRole('button', { name: /attach/i }));
    expect(onAttach).toHaveBeenCalledTimes(1);
    const seed = onAttach.mock.calls[0][0];
    expect(seed.mediaPath).toBe('data/media/crm-demo.mp4');
    expect(seed.mediaItems).toBeUndefined();
    expect(seed.type).toBeTruthy();
  });

  it('selecting TWO or more attaches them as ONE album, in selection order', async () => {
    const user = userEvent.setup();
    const onAttach = vi.fn();
    renderAssets({ onAttach });
    // Click plain.mp4 FIRST: the click sequence is the intent, so it must lead.
    await user.click(screen.getByRole('checkbox', { name: /plain\.mp4/i }));
    await user.click(screen.getByRole('checkbox', { name: /crm-demo\.mp4/i }));
    await user.click(screen.getByRole('button', { name: /attach/i }));
    const seed = onAttach.mock.calls[0][0];
    expect(seed.type).toBe('carousel');
    expect(seed.mediaItems).toEqual(['data/media/plain.mp4', 'data/media/crm-demo.mp4']);
  });

  it('shows each selected asset its position in the selection, which is also the order affordance', async () => {
    const user = userEvent.setup();
    renderAssets({ onAttach: vi.fn() });
    await user.click(screen.getByRole('checkbox', { name: /plain\.mp4/i }));
    await user.click(screen.getByRole('checkbox', { name: /crm-demo\.mp4/i }));
    // Two non-colour signals: the checkbox and the position number. Scope to the badges
    // rather than the whole page - "1" also appears in the selection count copy.
    const badges = screen.getAllByText(/^[12]$/).filter((el) => el.className.includes('rounded-full'));
    expect(badges.map((el) => el.textContent).sort()).toEqual(['1', '2']);
  });

  it('a still image seeds as an image, never as a reel or video', async () => {
    const user = userEvent.setup();
    const onAttach = vi.fn();
    assetsData = { dir: MEDIA_DIR, assets: [{ ...ASSET, file: 'still.jpg', kind: 'image', url: '/media?p=still.jpg', captions: [], probe: {}, checks: { resolution: 'feed-4x5' } }] };
    renderAssets({ onAttach });
    await user.click(screen.getByRole('checkbox', { name: /still\.jpg/i }));
    await user.click(screen.getByRole('button', { name: /attach/i }));
    expect(onAttach.mock.calls[0][0].type).toBe('image');
  });

  it('has no axe violations with a selection active', async () => {
    const user = userEvent.setup();
    const { container } = renderAssets({ onAttach: vi.fn() });
    await user.click(screen.getByRole('checkbox', { name: /crm-demo\.mp4/i }));
    expect(await axeClean(container)).toHaveNoViolations();
  });
});

describe('Composer accepts a seed (B9)', () => {
  it('pre-selects the seeded media path in VideoPicker (shows the file)', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve('') })));
    renderComposer({ seed: { mediaPath: 'data/media/crm-demo.mp4' } });
    expect(await screen.findByText('crm-demo.mp4')).toBeInTheDocument();
  });

  it('seeds the caption from the voiceover SRT when the asset has captions[]', async () => {
    const srt = '1\n00:00:00,000 --> 00:00:02,000\nHello from the demo.\n';
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve(srt) })));
    renderComposer({ seed: { mediaPath: 'data/media/crm-demo.mp4' } });
    const caption = await screen.findByLabelText(/post text/i);
    await waitFor(() => expect(caption).toHaveValue('Hello from the demo.'));
  });

  it('leaves the caption empty when the asset has no SRT sidecar', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve('') })));
    renderComposer({ seed: { mediaPath: 'data/media/plain.mp4' } });
    const caption = await screen.findByLabelText(/post text/i);
    expect(caption).toHaveValue('');
  });

  it('leaves the caption empty (never blocks) when the SRT fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network'))));
    renderComposer({ seed: { mediaPath: 'data/media/crm-demo.mp4' } });
    const caption = await screen.findByLabelText(/post text/i);
    // The picker still shows the file even though the SRT fetch threw.
    expect(await screen.findByText('crm-demo.mp4')).toBeInTheDocument();
    expect(caption).toHaveValue('');
  });
});
