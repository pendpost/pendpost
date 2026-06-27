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

vi.mock('../../lib/api.js', () => ({
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  useAssets: () => ({ data: { assets: [], dir: '/tmp/assets' } }),
  useConfig: () => ({ data: { posting: { hashtagPresets: [] } } }),
  usePlatformValidate: () => platformValidateState,
  useValidateMedia: () => ({ data: undefined }),
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
