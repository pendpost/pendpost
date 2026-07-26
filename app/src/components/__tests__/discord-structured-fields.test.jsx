import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import Composer, { DiscordEmbedFields } from '../Composer.jsx';
import { updatePost, createPost } from '../../lib/api.js';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Spec 26 (Discord forum/thread targeting + scheduled events): the thread
// fields (dcThreadName/dcThreadId) and the guild-event group (dcEvent) are
// discord-only (rel.dcEmbed-gated) and MERGE INTO the SAME Composer subsection
// spec 14 built for dcEmbed - never a competing/second discord block. Mirrors
// link-cta-fields.test.jsx (the spec-14 sibling) + composer-poll.test.jsx (the
// save-payload assertion pattern).
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

function discordPost(extra = {}) {
  return {
    id: 'd1',
    campaign: 'launch',
    type: 'text',
    platforms: ['discord'],
    approval: 'draft',
    derivedState: 'scheduled',
    scheduledAt: '2026-07-01T10:00:00Z',
    caption: 'Hello Discord',
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

function renderCreateComposer() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <Composer
              mode="create"
              post={null}
              campaigns={[{ id: 'launch', active: true, posts: [] }]}
              onClose={vi.fn()}
              onSaved={vi.fn()}
            />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('DiscordEmbedFields — merged thread/event props (spec 26 authoring)', () => {
  it('renders no thread/event UI when only embed props are passed (standalone spec-14 usage stays byte-identical)', () => {
    const onChange = vi.fn();
    render(<DiscordEmbedFields embed={{ title: '', description: '', url: '', color: '' }} onChange={onChange} />);
    expect(screen.getByText('Discord embed')).toBeInTheDocument();
    expect(screen.queryByLabelText('Forum thread name')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Guild event')).not.toBeInTheDocument();
  });
});

describe('Composer — Discord thread targeting + guild event (spec 26)', () => {
  it('shows the thread inputs + event group only for discord, inside the SAME "Discord embed" subsection', () => {
    renderEditComposer(discordPost());
    const heading = screen.getByText('Discord embed');
    // The merged subsection is ONE container: the thread inputs + the "Guild
    // event" heading live inside the SAME ancestor as the "Discord embed" h3 -
    // never a second, competing discord block elsewhere in the Composer.
    const section = heading.closest('section');
    expect(section).toBeTruthy();
    expect(within(section).getByLabelText('Forum thread name')).toBeInTheDocument();
    expect(within(section).getByLabelText('Existing thread id')).toBeInTheDocument();
    expect(within(section).getByText('Guild event')).toBeInTheDocument();
    expect(within(section).getByLabelText('Event name')).toBeInTheDocument();
  });

  it('hides the thread inputs + event group for a non-discord post', () => {
    renderEditComposer(discordPost({ platforms: ['x'] }));
    expect(screen.queryByLabelText('Forum thread name')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Existing thread id')).not.toBeInTheDocument();
    expect(screen.queryByText('Guild event')).not.toBeInTheDocument();
  });

  it('seeds the thread inputs from the saved post and saves edits under dcThreadName/dcThreadId', async () => {
    const user = userEvent.setup();
    renderEditComposer(discordPost({ dcThreadName: 'Old name', dcThreadId: '' }));
    expect(screen.getByLabelText('Forum thread name')).toHaveValue('Old name');
    await user.clear(screen.getByLabelText('Forum thread name'));
    await user.type(screen.getByLabelText('Forum thread name'), 'Release notes');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(updatePost).toHaveBeenCalled();
    const fields = updatePost.mock.calls.at(-1)[3];
    expect(fields.dcThreadName).toBe('Release notes');
    expect(fields.dcThreadId).toBe(null);
  });

  it('saves an existing thread id under dcThreadId', async () => {
    const user = userEvent.setup();
    renderEditComposer(discordPost());
    await user.type(screen.getByLabelText('Existing thread id'), '123456789012345678');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const fields = updatePost.mock.calls.at(-1)[3];
    expect(fields.dcThreadId).toBe('123456789012345678');
    expect(fields.dcThreadName).toBe(null);
  });

  it('shows the mutually-exclusive hint (advisory, never a hard block on either field)', () => {
    renderEditComposer(discordPost());
    expect(screen.getByText(/mutually exclusive/i)).toBeInTheDocument();
    // Both fields stay independently editable - no disabled attribute on either.
    expect(screen.getByLabelText('Forum thread name')).not.toBeDisabled();
    expect(screen.getByLabelText('Existing thread id')).not.toBeDisabled();
  });

  it('dcEvent is null when no event name is authored (the byte-identical empty scenario)', async () => {
    const user = userEvent.setup();
    renderEditComposer(discordPost());
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const fields = updatePost.mock.calls.at(-1)[3];
    expect(fields.dcEvent).toBe(null);
  });

  it('saves a fully-authored dcEvent intent, converting the zone-less datetime-local values to full ISO-8601 (spec 26 review, MAJOR-2)', async () => {
    const user = userEvent.setup();
    renderEditComposer(discordPost());
    await user.type(screen.getByLabelText('Event name'), 'Launch party');
    // datetime-local inputs accept a plain "YYYY-MM-DDTHH:mm" string via fireEvent-style typing.
    const start = screen.getByLabelText('Start');
    await user.click(start);
    await user.paste('2027-01-01T18:00');
    const end = screen.getByLabelText('End');
    await user.click(end);
    await user.paste('2027-01-01T20:00');
    await user.type(screen.getByLabelText('Location'), 'https://example.com/stream');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const fields = updatePost.mock.calls.at(-1)[3];
    // The wire value is a FULL ISO-8601 string (never the raw zone-less input -
    // that's what created a live guild event 1-2h off). Computed the same way
    // the browser's own Date would, so this is environment-timezone-agnostic.
    expect(fields.dcEvent).toEqual({
      name: 'Launch party',
      startTime: new Date('2027-01-01T18:00').toISOString(),
      endTime: new Date('2027-01-01T20:00').toISOString(),
      location: 'https://example.com/stream',
    });
  });

  it('renders an agent-authored full-ISO startTime back into the datetime-local input instead of blank (round-trip, spec 26 review MAJOR-2/MINOR-4)', () => {
    const iso = '2027-03-15T18:30:00.000Z';
    renderEditComposer(discordPost({
      dcEvent: { name: 'Ops sync', startTime: iso, endTime: '2027-03-15T20:00:00.000Z', location: 'Discord stage' },
    }));
    const start = screen.getByLabelText('Start');
    expect(start.value).not.toBe('');
    // Round-trips to the SAME instant regardless of the timezone the test
    // happens to run in - a raw Z-suffixed ISO string does not match the
    // <input type="datetime-local"> value shape and previously rendered blank.
    expect(new Date(start.value).getTime()).toBe(new Date(iso).getTime());
  });

  it('omits the dcEvent group when only a name is authored - typing a name must never block save (spec 26 review, MINOR-5)', async () => {
    const user = userEvent.setup();
    renderEditComposer(discordPost());
    await user.type(screen.getByLabelText('Event name'), 'Just a name');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(updatePost).toHaveBeenCalled();
    const fields = updatePost.mock.calls.at(-1)[3];
    expect(fields.dcEvent).toBe(null);
  });

  it('omits the dcEvent group when an external event is missing its required end time / location (spec 26 review, MINOR-5)', async () => {
    const user = userEvent.setup();
    renderEditComposer(discordPost());
    await user.type(screen.getByLabelText('Event name'), 'Launch party');
    const start = screen.getByLabelText('Start');
    await user.click(start);
    await user.paste('2027-01-01T18:00');
    // No end time, no location authored - lib/writes.mjs would now reject this
    // (MAJOR-1), so the Composer must never send it in the first place.
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(updatePost).toHaveBeenCalled();
    const fields = updatePost.mock.calls.at(-1)[3];
    expect(fields.dcEvent).toBe(null);
  });

  it('preserves an agent-authored voice event (entityType/channelId/description) through an unrelated Composer save (spec 26 review, MINOR-4)', async () => {
    const user = userEvent.setup();
    renderEditComposer(discordPost({
      dcEvent: {
        name: 'Town hall', startTime: '2027-04-01T18:00:00.000Z',
        entityType: 'voice', channelId: '999888777', description: 'Monthly sync',
      },
    }));
    // An unrelated tweak - the caption, not the event group - must not drop the
    // voice event's entityType/channelId/description down to a broken default
    // external event.
    await user.type(screen.getByLabelText('Post text'), '!');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const fields = updatePost.mock.calls.at(-1)[3];
    expect(fields.dcEvent).toMatchObject({
      name: 'Town hall',
      entityType: 'voice',
      channelId: '999888777',
      description: 'Monthly sync',
    });
  });

  it('create mode omits dcThreadName/dcThreadId/dcEvent when unset (undefined, not null)', async () => {
    const user = userEvent.setup();
    renderCreateComposer();
    await user.type(screen.getByLabelText('Post ID'), 'newpost1');
    await user.click(screen.getByRole('button', { name: /discord/i }));
    await user.type(screen.getByLabelText('Post text'), 'Hi');
    // A Termin is now mandatory to save - pick today from the schedule picker.
    await user.click(screen.getByRole('button', { name: 'Pick a date' }));
    await user.click(document.querySelector('button[aria-current="date"]'));
    await user.click(screen.getByRole('button', { name: 'Create draft' }));
    expect(createPost).toHaveBeenCalled();
    const fields = createPost.mock.calls.at(-1)[1];
    expect(fields.dcThreadName).toBeUndefined();
    expect(fields.dcThreadId).toBeUndefined();
    expect(fields.dcEvent).toBeUndefined();
  });

  it('has no axe violations with the merged discord subsection rendered', async () => {
    const { container } = renderEditComposer(discordPost());
    expect(await axeClean(container)).toHaveNoViolations();
  });
});
