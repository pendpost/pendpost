import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Composer from '../Composer.jsx';
import { updatePost } from '../../lib/api.js';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Spec 10 (native poll): the Composer's poll block gates on rel.poll (type=poll, the
// shared field-relevance model in lib/format.js). It authors the options (add/remove)
// + a duration select; the caption above is the question, and the VideoPicker is hidden
// (a poll carries no media). Saving serializes the flat form state to a poll object.
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

function pollPost(platforms, extra = {}) {
  return {
    id: 'pl1',
    campaign: 'launch',
    type: 'poll',
    platforms,
    approval: 'draft',
    derivedState: 'scheduled',
    scheduledAt: '2026-07-01T10:00:00Z',
    caption: 'Best release day?',
    poll: { options: ['Yes', 'No'], durationMinutes: 1440 },
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

describe('Composer — native poll block (spec 10)', () => {
  it('renders the poll options + duration for a poll post and hides the media picker', () => {
    renderEditComposer(pollPost(['x', 'telegram']));
    expect(screen.getByLabelText('Option 1')).toHaveValue('Yes');
    expect(screen.getByLabelText('Option 2')).toHaveValue('No');
    expect(screen.getByLabelText('Duration')).toBeInTheDocument();
    // Media-less: the VideoPicker never renders for a poll.
    expect(screen.queryByRole('button', { name: /choose video/i })).not.toBeInTheDocument();
  });

  it('does NOT render the poll block for a non-poll post', () => {
    renderEditComposer(pollPost(['x'], { type: 'video', poll: null, media: { file: 'v.mp4', exists: true, url: null, cover: null, path: '/tmp/v.mp4' } }));
    expect(screen.queryByLabelText('Option 1')).not.toBeInTheDocument();
  });

  it('adds and removes an option, then saves the trimmed poll object', async () => {
    const user = userEvent.setup();
    renderEditComposer(pollPost(['x']));

    // Add a third option and fill it.
    await user.click(screen.getByRole('button', { name: 'Add option' }));
    expect(screen.getByLabelText('Option 3')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Option 3'), 'Maybe');

    // A fourth option, then remove it again (back to three).
    await user.click(screen.getByRole('button', { name: 'Add option' }));
    expect(screen.getByLabelText('Option 4')).toBeInTheDocument();
    const removeButtons = screen.getAllByRole('button', { name: 'Remove option' });
    await user.click(removeButtons[removeButtons.length - 1]);
    expect(screen.queryByLabelText('Option 4')).not.toBeInTheDocument();

    // Pick a 7-day duration.
    await user.selectOptions(screen.getByLabelText('Duration'), '10080');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(updatePost).toHaveBeenCalled();
    const fields = updatePost.mock.calls.at(-1)[3];
    expect(fields.poll).toEqual({ options: ['Yes', 'No', 'Maybe'], durationMinutes: 10080 });
  });

  it('renders a synthesized option for a non-preset (MCP-authored) duration and preserves it on save', async () => {
    const user = userEvent.setup();
    // 999 min is not one of the five presets - the select must show it (not silently
    // render "5 minutes") and round-trip it unchanged on save.
    renderEditComposer(pollPost(['x'], { poll: { options: ['Yes', 'No'], durationMinutes: 999 } }));
    const select = screen.getByLabelText('Duration');
    expect(select).toHaveValue('999');
    // The synthesized option is labelled via the shared "<n> min" fallback.
    expect(screen.getByRole('option', { name: '999 min' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const fields = updatePost.mock.calls.at(-1)[3];
    expect(fields.poll).toEqual({ options: ['Yes', 'No'], durationMinutes: 999 });
  });

  it('carries the multiple-choice flag only when checked', async () => {
    const user = userEvent.setup();
    renderEditComposer(pollPost(['mastodon']));
    await user.click(screen.getByLabelText('Multiple choice'));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const fields = updatePost.mock.calls.at(-1)[3];
    expect(fields.poll).toEqual({ options: ['Yes', 'No'], durationMinutes: 1440, multiple: true });
  });

  it('has no axe violations with the poll block rendered', async () => {
    const { container } = renderEditComposer(pollPost(['x', 'telegram']));
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
