import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import PostDetail from '../PostDetail.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Discord guild scheduled events (spec 26): the "Create Discord event" ⋯ menu
// action is offered on any discord post that carries a dcEvent intent (authored
// in the Composer), REGARDLESS of publish state (an event announcement is not
// gated on the post itself having published yet). Clicking it opens a confirm,
// then creates the REAL guild event. Once dcEventId is set, the label reads
// "Event created" and re-running it is an idempotent no-op (never a second
// discordScheduleEvent call) - mirrors PostDetail.editPublished.test.jsx.

const discordScheduleEventMock = vi.fn(() => Promise.resolve({ ok: true, event: { id: 'evt777' } }));

vi.mock('../../lib/api.js', () => ({
  useInsights: () => ({ data: undefined }),
  useActiveClient: () => ({ activeClient: { id: 'acme', displayName: 'Acme Retail', accent: '#22566d' }, activeClientId: 'acme' }),
  usePendpostHealth: () => ({ data: { setup: { platforms: [] } } }),
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: { meta: { paused: false } } }),
  usePlatformValidate: () => ({ data: undefined }),
  useRedditFlairs: () => ({ data: undefined, isLoading: false }),
  usePresubmitCheck: () => ({ data: undefined }),
  useValidateMedia: () => ({ data: undefined }),
  useAssets: () => ({ data: { dir: 'data/media', assets: [] } }),
  approvePost: vi.fn(),
  rejectPost: vi.fn(),
  deletePost: vi.fn(),
  unschedulePost: vi.fn(),
  reschedulePost: vi.fn(),
  markPosted: vi.fn(),
  verifyPost: vi.fn(),
  setCoverFrame: vi.fn(),
  uploadCover: vi.fn(),
  clearCover: vi.fn(),
  updatePost: vi.fn(),
  editPublished: vi.fn(),
  discordScheduleEvent: (...a) => discordScheduleEventMock(...a),
}));

const dcEventIntent = { name: 'Launch party', startTime: '2027-01-01T18:00:00Z', endTime: '2027-01-01T20:00:00Z', location: 'https://example.com/stream' };

const basePost = {
  id: 'd1',
  campaign: 'launch',
  caption: 'Party time',
  platforms: ['discord'],
  approval: 'approved',
  derivedState: 'scheduled',
  status: 'planned',
  scheduledAt: '2026-06-01T10:00:00Z',
  postedAt: null,
  type: 'text',
  rev: 1,
  executionMode: 'fully-scheduled',
  image: null,
  dcEvent: dcEventIntent,
  ids: { dcEventId: null },
  cover: null,
  publishedVia: null,
  externalUrl: null,
  verify: null,
  media: { file: null, exists: false, bytes: 0, url: null, cover: null, path: null },
};

const withEventPost = basePost;
const noEventPost = { ...basePost, id: 'd2', dcEvent: null };
const nonDiscordPost = { ...basePost, id: 'd3', platforms: ['telegram'] };
const createdEventPost = { ...basePost, id: 'd4', ids: { dcEventId: 'evt777' } };

function renderDetail(post) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <I18nProvider locale="en">
          <TooltipProvider>
            <ConfirmProvider>
              <PostDetail post={post} onClose={() => {}} onEdit={() => {}} />
            </ConfirmProvider>
          </TooltipProvider>
        </I18nProvider>
      </QueryClientProvider>,
    ),
  };
}

const openMenu = async (user) => user.click(screen.getByRole('button', { name: /more actions/i }));

beforeEach(() => {
  discordScheduleEventMock.mockClear();
  discordScheduleEventMock.mockResolvedValue({ ok: true, event: { id: 'evt777' } });
});

describe('PostDetail "Create Discord event" action (spec 26)', () => {
  it('shows the action for a discord post carrying a dcEvent intent', async () => {
    const user = userEvent.setup();
    renderDetail(withEventPost);
    await openMenu(user);
    expect(screen.getByText('Create Discord event')).toBeInTheDocument();
  });

  it('hides the action when the post carries no dcEvent intent', async () => {
    const user = userEvent.setup();
    renderDetail(noEventPost);
    await openMenu(user);
    expect(screen.queryByText('Create Discord event')).not.toBeInTheDocument();
  });

  it('hides the action for a non-discord post', async () => {
    const user = userEvent.setup();
    renderDetail(nonDiscordPost);
    await openMenu(user);
    expect(screen.queryByText('Create Discord event')).not.toBeInTheDocument();
  });

  it('reads "Event created" once dcEventId is set (idempotent no-op)', async () => {
    const user = userEvent.setup();
    renderDetail(createdEventPost);
    await openMenu(user);
    expect(screen.getByText('Event created')).toBeInTheDocument();
    expect(screen.queryByText('Create Discord event')).not.toBeInTheDocument();
    await user.click(screen.getByText('Event created'));
    expect(discordScheduleEventMock).not.toHaveBeenCalled();
  });

  it('runs the confirm dialog, then creates the event and refreshes', async () => {
    const user = userEvent.setup();
    const { qc } = renderDetail(withEventPost);
    const spy = vi.spyOn(qc, 'invalidateQueries');
    await openMenu(user);
    await user.click(screen.getByText('Create Discord event'));

    expect(screen.getByText('Create a real Discord event?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create event' }));

    await waitFor(() => expect(discordScheduleEventMock).toHaveBeenCalledTimes(1));
    expect(discordScheduleEventMock).toHaveBeenCalledWith('launch', 'd1');
    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ['plans'] }));
  });

  it('cancelling the confirm dialog never calls discordScheduleEvent', async () => {
    const user = userEvent.setup();
    renderDetail(withEventPost);
    await openMenu(user);
    await user.click(screen.getByText('Create Discord event'));
    expect(screen.getByText('Create a real Discord event?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(discordScheduleEventMock).not.toHaveBeenCalled();
  });

  it('surfaces an engine failure as the error line', async () => {
    discordScheduleEventMock.mockRejectedValueOnce(new Error('add a Discord bot token with MANAGE_EVENTS to create guild events'));
    const user = userEvent.setup();
    renderDetail(withEventPost);
    await openMenu(user);
    await user.click(screen.getByText('Create Discord event'));
    await user.click(screen.getByRole('button', { name: 'Create event' }));
    await waitFor(() => expect(screen.getByText('add a Discord bot token with MANAGE_EVENTS to create guild events')).toBeInTheDocument());
  });

  it('is accessible with the confirm dialog open (axe clean)', async () => {
    const user = userEvent.setup();
    const { container } = renderDetail(withEventPost);
    await openMenu(user);
    await user.click(screen.getByText('Create Discord event'));
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
