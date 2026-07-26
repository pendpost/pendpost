import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Composer from '../Composer.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// B2 part 2 (Composer face): in EDIT mode, the saved post's platform_validate
// problems must surface read-only near the save action so the owner sees a bad
// post before publish. The hooks are mocked; create-before-save shows nothing
// (hooks gated off) but edit mode surfaces the saved post's blockers.
const platformValidateState = { data: undefined };
// CI-2: spy on the raw args useValidateMedia is called with (campaign, postId,
// enabled) so a test can assert the `enabled` gate without needing a real fetch.
const validateMediaCalls = [];

vi.mock('../../lib/api.js', () => ({
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  useAssets: () => ({ data: { assets: [], dir: '/tmp/assets' } }),
  useConfig: () => ({ data: { posting: { hashtagPresets: [] } } }),
  usePlatformValidate: () => platformValidateState,
  useValidateMedia: (...args) => { validateMediaCalls.push(args); return { data: undefined }; },
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePinterestBoardSections: () => ({ data: undefined, isLoading: false }),
  createPost: vi.fn(() => Promise.resolve({ ok: true })),
  updatePost: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, findings: [] })),
}));

const editPost = {
  id: 'p1',
  campaign: 'launch',
  type: 'reel',
  platforms: ['instagram'],
  approval: 'approved',
  derivedState: 'scheduled',
  scheduledAt: '2026-07-01T10:00:00Z',
  caption: 'A caption',
  rev: 3,
  media: { file: 'reel.mp4', exists: true, bytes: 1000, url: '/media?p=reel.mp4', cover: null, path: 'reel.mp4' },
};

function renderComposer(mode = 'edit', post = editPost) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <Composer
              mode={mode}
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

beforeEach(() => {
  platformValidateState.data = undefined;
  validateMediaCalls.length = 0;
});

describe('Composer edit-mode publish-readiness blockers (B2)', () => {
  it('surfaces platform_validate problems read-only on an edit-mode post', () => {
    platformValidateState.data = {
      ok: true,
      postId: 'p1',
      platforms: {
        instagram: {
          ready: false,
          problems: ['local media file is missing'],
          warnings: [],
        },
      },
    };
    renderComposer('edit');
    expect(screen.getByText('local media file is missing')).toBeInTheDocument();
  });

  it('renders no blocker rows when the saved post validates clean', () => {
    platformValidateState.data = {
      ok: true,
      postId: 'p1',
      platforms: { instagram: { ready: true, problems: [], warnings: [] } },
    };
    renderComposer('edit');
    expect(screen.queryByText('local media file is missing')).not.toBeInTheDocument();
  });

  it('does NOT enable the validate-media probe for a media-less edit-mode text post (CI-2)', () => {
    renderComposer('edit', { ...editPost, type: 'text', platforms: ['x'], media: null });
    expect(validateMediaCalls.at(-1)?.[2]).toBe(false);
  });

  it('DOES enable the validate-media probe for a media-backed edit-mode reel post (CI-2)', () => {
    renderComposer('edit'); // editPost is type:'reel'
    expect(validateMediaCalls.at(-1)?.[2]).toBe(true);
  });

  it('has no axe violations in the blocker rows region (read-only, not interactive-in-interactive)', async () => {
    // Scope axe to the blocker rows subtree: the Composer's VideoPicker uses a
    // Radix Popover-trigger-as-button pattern that trips nested-interactive
    // independently of B2; B2 only adds the non-interactive PlatformBlockers,
    // so we assert THAT region is clean rather than re-litigating the picker.
    platformValidateState.data = {
      ok: true,
      postId: 'p1',
      platforms: {
        instagram: { ready: false, problems: ['local media file is missing'], warnings: ['advisory note'] },
      },
    };
    renderComposer('edit');
    const region = screen.getByText('local media file is missing').closest('div');
    expect(await axeClean(region)).toHaveNoViolations();
  });
});
