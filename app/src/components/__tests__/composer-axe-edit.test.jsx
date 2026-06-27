import { render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Composer from '../Composer.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Edit-mode a11y regression: a saved post carries a media path, so the VideoPicker
// mounts with a *selected* value and renders its inline clear ("remove selected")
// affordance. That affordance used to be a focusable element nested inside the
// Radix Popover trigger <button>, which axe flags as nested-interactive. The
// create-mode composer-lint axe pass cannot catch this (no selected media there,
// so only the non-focusable chevron renders). This asserts the WHOLE composer is
// clean once a media value is present.
vi.mock('../../lib/api.js', () => ({
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  useAssets: () => ({
    data: {
      dir: '/tmp/assets',
      assets: [{ file: 'reel.mp4', url: '/media?p=reel.mp4', cover: null, usedBy: [], checks: {}, probe: {} }],
    },
  }),
  useConfig: () => ({ data: { posting: { hashtagPresets: [] } } }),
  usePlatformValidate: () => ({ data: undefined }),
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
  media: { file: 'reel.mp4', exists: true, bytes: 1000, url: '/media?p=reel.mp4', cover: null, path: '/tmp/assets/reel.mp4' },
};

function renderEditComposer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <Composer
              mode="edit"
              post={editPost}
              campaigns={[{ id: 'launch', active: true, posts: [editPost] }]}
              onClose={vi.fn()}
              onSaved={vi.fn()}
            />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('Composer edit-mode accessibility (VideoPicker clear affordance)', () => {
  it('has no axe violations when the VideoPicker shows a selected media value', async () => {
    const { container } = renderEditComposer();
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
