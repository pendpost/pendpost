import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Composer, { TiktokFields } from '../Composer.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

// Spec 25: disclosure & interaction settings - TikTok interaction/disclosure
// post_info flags (TiktokFields, modeled on GbpFields), a Mastodon content-
// warning (spoilerText), and an X reply-audience enum (xReplySettings). Mirrors
// link-cta-fields.test.jsx: a direct sub-component test + a Composer-level
// gating test (rel.ttInteraction / rel.spoilerText / rel.xReplySettings).

vi.mock('../../lib/api.js', () => ({
  useActiveClient: () => ({ activeClient: null, activeClientId: null }),
  useAssets: () => ({ data: { assets: [], dir: '/tmp/assets' } }),
  useConfig: () => ({ data: { posting: { hashtagPresets: [] } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePinterestBoardSections: () => ({ data: undefined, isLoading: false }),
  createPost: vi.fn(() => Promise.resolve({ ok: true })),
  updatePost: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, findings: [] })),
}));

const EMPTY_INTERACTION = { disableComment: false, disableDuet: false, disableStitch: false, aiGenerated: false, brandedContent: false, brandOrganic: false, coverTimestampMs: '' };

function renderTiktokFields(props = {}) {
  const onChange = vi.fn();
  const utils = render(
    <TooltipProvider>
      <TiktokFields interaction={EMPTY_INTERACTION} onChange={onChange} {...props} />
    </TooltipProvider>,
  );
  return { ...utils, onChange };
}

describe('TiktokFields (spec 25 authoring)', () => {
  it('renders all six toggles unchecked + an empty cover-frame timestamp', () => {
    renderTiktokFields();
    expect(screen.getByRole('checkbox', { name: /disable comments/i })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /disable duet/i })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /disable stitch/i })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /ai-generated content/i })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /branded content/i })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /promotes my business/i })).not.toBeChecked();
    expect(screen.getByLabelText('Cover frame (ms)')).toHaveValue(null);
  });

  it('toggling the AI-label checkbox reports only that flag changed', async () => {
    const user = userEvent.setup();
    const { onChange } = renderTiktokFields();
    await user.click(screen.getByRole('checkbox', { name: /ai-generated content/i }));
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_INTERACTION, aiGenerated: true });
  });

  it('shows a seeded flag as checked and leaves the others untouched', () => {
    renderTiktokFields({ interaction: { ...EMPTY_INTERACTION, disableDuet: true, brandedContent: true } });
    expect(screen.getByRole('checkbox', { name: /disable duet/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /branded content/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /disable comments/i })).not.toBeChecked();
  });

  it('typing a cover-frame timestamp reports the raw value', async () => {
    const user = userEvent.setup();
    const { onChange } = renderTiktokFields();
    // Single keystroke: the input is controlled by the fixed EMPTY_INTERACTION
    // prop (no re-render loop in this test), so a multi-char type() would only
    // ever report the last keystroke against the unchanged '' value.
    await user.type(screen.getByLabelText('Cover frame (ms)'), '5');
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_INTERACTION, coverTimestampMs: '5' });
  });

  it('has no axe violations', async () => {
    const { container } = renderTiktokFields({ interaction: { ...EMPTY_INTERACTION, aiGenerated: true, coverTimestampMs: '1500' } });
    expect(await axeClean(container)).toHaveNoViolations();
  });
});

describe('Composer gates the sections on rel.ttInteraction / rel.spoilerText / rel.xReplySettings', () => {
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

  it('shows the TikTok settings section only when tiktok is targeted', async () => {
    const user = userEvent.setup();
    renderComposer();
    expect(screen.queryByText('TikTok settings')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /tiktok/i }));
    expect(screen.getByText('TikTok settings')).toBeInTheDocument();
  });

  it('shows the content-warning field only when mastodon is targeted', async () => {
    const user = userEvent.setup();
    renderComposer();
    expect(screen.queryByLabelText('Content warning (Mastodon)')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /mastodon/i }));
    expect(screen.getByLabelText('Content warning (Mastodon)')).toBeInTheDocument();
  });

  it('shows the reply-audience select only when x is targeted, defaulted to "Default (everyone)"', async () => {
    const user = userEvent.setup();
    renderComposer();
    expect(screen.queryByLabelText('Who can reply (X)')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'X' }));
    const select = screen.getByLabelText('Who can reply (X)');
    expect(select).toBeInTheDocument();
    expect(select).toHaveValue('');
    await user.selectOptions(select, 'following');
    expect(select).toHaveValue('following');
  });

  it('renders the editor without throwing for a saved post with all three fields set', () => {
    const post = {
      campaign: 'launch', id: 'p1', rev: 'r1', type: 'video',
      platforms: ['tiktok', 'mastodon', 'x'], caption: 'Hello',
      ttInteraction: { disableComment: true, aiGenerated: true, coverTimestampMs: 1500 },
      spoilerText: 'spoilers ahead', xReplySettings: 'following',
    };
    renderComposer({ mode: 'edit', post });
    expect(screen.getByText('TikTok settings')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /disable comments/i })).toBeChecked();
    expect(screen.getByLabelText('Cover frame (ms)')).toHaveValue(1500);
    expect(screen.getByLabelText('Content warning (Mastodon)')).toHaveValue('spoilers ahead');
    expect(screen.getByLabelText('Who can reply (X)')).toHaveValue('following');
  });
});
