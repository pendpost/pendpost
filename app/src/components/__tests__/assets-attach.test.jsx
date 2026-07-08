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

describe('Asset "Attach to a post" CTA (B9)', () => {
  it('renders an Attach CTA per card with an accessible name referencing the file', () => {
    renderAssets({ onAttach: vi.fn() });
    expect(screen.getByRole('button', { name: /attach.*crm-demo\.mp4/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /attach.*plain\.mp4/i })).toBeInTheDocument();
  });

  it('clicking the CTA calls onAttach with { mediaPath } (canonical dir/file) and a type', async () => {
    const user = userEvent.setup();
    const onAttach = vi.fn();
    renderAssets({ onAttach });
    await user.click(screen.getByRole('button', { name: /attach.*crm-demo\.mp4/i }));
    expect(onAttach).toHaveBeenCalledTimes(1);
    const seed = onAttach.mock.calls[0][0];
    expect(seed.mediaPath).toBe('data/media/crm-demo.mp4');
    expect(seed.type).toBeTruthy();
  });

  it('has no axe violations on the grid', async () => {
    const { container } = renderAssets({ onAttach: vi.fn() });
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
