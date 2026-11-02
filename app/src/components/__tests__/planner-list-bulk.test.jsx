// planner-list-bulk.test.jsx - multi-select and bulk actions in the planner List (planner bulk,
// package P; contract rows S1-S7, S10). The List wears the SAME selection + bar as Approvals
// (lib/useSelection.js + BulkBar.jsx). api.js is mocked: package T builds the restore route in
// parallel, so restorePost is a mock here.
import { render, screen, within, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ListView } from '../Planner.jsx';
import AppToast from '../AppToast.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';

const api = vi.hoisted(() => ({
  deletePost: vi.fn(),
  restorePost: vi.fn(),
  approvePost: vi.fn(),
  reschedulePost: vi.fn(),
  unschedulePost: vi.fn(),
  updatePost: vi.fn(),
  agentFixPost: vi.fn(),
  getAgentFixes: vi.fn(),
}));
vi.mock('../../lib/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, ...api };
});
vi.mock('../../lib/agentFix.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useAgentFixes: () => ({ data: undefined }) };
});

const setup = { platforms: [
  { platform: 'telegram', status: 'incomplete' },
  { platform: 'linkedin', status: 'connected', validation: { state: 'live' } },
  { platform: 'bluesky', status: 'connected', validation: { state: 'live' } },
] };
const NO_MEDIA = { file: null, exists: false, bytes: null, url: null, cover: null, path: null };
let seq = 0;
function mk(id, extra = {}) {
  seq += 1;
  return {
    id, campaign: 'launch', type: 'text', title: `Post ${id}`, caption: `Post ${id}`, platforms: ['linkedin'],
    scheduledAt: new Date(2099, 0, 2 + Math.floor((seq - 1) / 3), 9 + ((seq - 1) % 3)).toISOString(),
    approval: 'pending', derivedState: 'draft', executionMode: 'fully-scheduled', rev: `r-${id}`, image: null, media: NO_MEDIA,
    ...extra,
  };
}

function renderList(posts, props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['pendpost-health'], { setup });
  const onSelect = vi.fn();
  const onEdit = vi.fn();
  const utils = render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <ListView posts={posts} onSelect={onSelect} onEdit={onEdit} onNavigate={() => {}} loading={false} {...props} />
            <AppToast />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { ...utils, onSelect, onEdit };
}

const rowOf = (title) => screen.getByText(title, { selector: 'p' }).closest('li');
const boxOf = (title) => within(rowOf(title)).getByRole('checkbox', { name: `Select ${title}` });
const bar = () => screen.getByRole('region', { name: /selected/ });

beforeEach(() => {
  seq = 0;
  for (const fn of Object.values(api)) fn.mockReset();
  api.deletePost.mockResolvedValue({ ok: true, trashed: true });
  api.restorePost.mockResolvedValue({ ok: true });
  api.approvePost.mockResolvedValue({ ok: true });
  api.reschedulePost.mockResolvedValue({ ok: true });
  api.unschedulePost.mockResolvedValue({ ok: true });
  api.updatePost.mockResolvedValue({ ok: true });
});

const line = () => bar().querySelector('[data-bulk-line]');
const action = (name) => within(bar()).getByRole('button', { name });
const toastBox = () => document.querySelector('[data-app-toast]');

describe('selecting in the List', () => {
  it('every row has a checkbox slot; it shows on hover/focus until something is selected, then on every row', async () => {
    const user = userEvent.setup();
    renderList([mk('a'), mk('b')]);
    const slot = boxOf('Post a').closest('[data-pick]');
    expect(slot.className).toContain('opacity-0');
    expect(slot.className).toContain('group-hover:opacity-100');
    expect(slot.className).toContain('group-focus-within:opacity-100');
    await user.click(boxOf('Post a'));
    expect(boxOf('Post b').closest('[data-pick]').className).not.toContain('opacity-0');
    expect(bar()).toHaveAccessibleName('1 selected');
  });

  it('the bar\'s slot is there before anything is selected, so picking never pushes the rows (no jump)', async () => {
    const user = userEvent.setup();
    const { container } = renderList([mk('a'), mk('b')]);
    const slot = container.querySelector('[data-bulk-slot]');
    expect(slot).not.toBeNull();
    expect(slot.querySelector('[data-bulk-line]')).not.toBeNull();
    expect(screen.queryByRole('region', { name: /selected/ })).not.toBeInTheDocument();
    await user.click(boxOf('Post a'));
    // The same element became the bar: nothing was inserted above the rows.
    expect(container.querySelector('[data-bulk-slot]')).toBe(slot);
    expect(bar()).toBe(slot);
  });

  it('a checkbox has a 44px hit area: its label is the target', () => {
    renderList([mk('a')]);
    const label = boxOf('Post a').closest('label');
    expect(label).not.toBeNull();
    expect(label.className).toMatch(/after:min-w-11/);
    expect(label.className).toMatch(/after:h-11/);
  });

  it('shift-click selects the range; the bar offers "Select all N in this view"; Esc clears', async () => {
    const user = userEvent.setup();
    renderList([mk('a'), mk('b'), mk('c'), mk('d')]);
    await user.click(boxOf('Post a'));
    await user.keyboard('{Shift>}');
    await user.click(boxOf('Post c'));
    await user.keyboard('{/Shift}');
    expect(bar()).toHaveAccessibleName('3 selected');
    await user.click(within(bar()).getByRole('button', { name: 'Select all 4 in this view' }));
    expect(bar()).toHaveAccessibleName('4 selected');
    expect(within(bar()).queryByRole('button', { name: /Select all/ })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: /selected/ })).not.toBeInTheDocument();
  });

  it('a day heading\'s checkbox selects that day, and clears it again', async () => {
    const user = userEvent.setup();
    renderList([mk('a'), mk('b'), mk('c'), mk('d')]); // a, b, c on day 1; d on day 2
    const dayBoxes = screen.getAllByRole('checkbox', { name: /^Select every post on/ });
    expect(dayBoxes).toHaveLength(2);
    await user.click(dayBoxes[0]);
    expect(bar()).toHaveAccessibleName('3 selected');
    expect(boxOf('Post d')).not.toBeChecked();
    await user.click(dayBoxes[0]);
    expect(screen.queryByRole('region', { name: /selected/ })).not.toBeInTheDocument();
  });

  it('selecting one tweet of an X thread selects the whole chain (S7)', async () => {
    const user = userEvent.setup();
    const t1 = mk('t1', { platforms: ['x'] });
    const t2 = mk('t2', { platforms: ['x'], xReplyTo: 't1' });
    const t3 = mk('t3', { platforms: ['x'], xReplyTo: 't2' });
    renderList([t1, t2, t3, mk('other')]);
    await user.click(boxOf('Post t2'));
    expect(bar()).toHaveAccessibleName('3 selected');
    expect(boxOf('Post other')).not.toBeChecked();
  });

  it('the day headings stick to the top of the page', () => {
    renderList([mk('a')]);
    const heading = screen.getByRole('heading', { level: 3 });
    expect(heading.parentElement.className).toContain('sticky');
  });
});

describe('the fixed action set', () => {
  it('shows every action; one that applies to none of the selection is disabled with its reason', async () => {
    const user = userEvent.setup();
    const published = mk('pub', { title: 'Launch day', caption: 'Launch day', approval: 'approved', derivedState: 'posted', status: 'posted' });
    renderList([published, mk('a')]);
    await user.click(boxOf('Launch day'));
    for (const name of ['Delete', 'Approve', 'Move', 'Park', 'Fix with agent']) expect(action(name)).toBeInTheDocument();
    const del = action('Delete');
    expect(del).toHaveAttribute('aria-disabled', 'true');
    expect(del).toHaveAccessibleDescription('Published posts stay, nothing to delete');
    expect(action('Approve')).toHaveAttribute('aria-disabled', 'true');
    expect(action('Fix with agent')).toHaveAccessibleDescription('No agent connected. Connect one in Setup.');
    await user.click(del);
    expect(api.deletePost).not.toHaveBeenCalled();
  });

  it('Approve is never the enabled action that will be refused: all offline means disabled, naming the lane', async () => {
    const user = userEvent.setup();
    renderList([mk('tg', { platforms: ['telegram'] })]);
    await user.click(boxOf('Post tg'));
    expect(action('Approve')).toHaveAttribute('aria-disabled', 'true');
    expect(action('Approve')).toHaveAccessibleDescription('Telegram not connected');
  });
});

describe('keyboard (S10)', () => {
  it('j / k move between rows, x selects, Enter opens, e edits, Esc clears', async () => {
    const { onSelect, onEdit } = renderList([mk('a'), mk('b'), mk('c')]);
    fireEvent.keyDown(window, { key: 'j' });
    expect(document.activeElement).toBe(rowOf('Post a'));
    fireEvent.keyDown(window, { key: 'j' });
    expect(document.activeElement).toBe(rowOf('Post b'));
    fireEvent.keyDown(window, { key: 'k' });
    expect(document.activeElement).toBe(rowOf('Post a'));
    fireEvent.keyDown(window, { key: 'x' });
    expect(bar()).toHaveAccessibleName('1 selected');
    expect(boxOf('Post a')).toBeChecked();
    fireEvent.keyDown(window, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), expect.any(Array));
    fireEvent.keyDown(window, { key: 'e' });
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: /selected/ })).not.toBeInTheDocument();
  });

  it('e on a post the composer cannot edit (a Bluesky Radar reply) opens its detail, never an empty editor (S10)', () => {
    const reply = mk('bs', { platforms: ['bluesky'], radarReplyTo: { url: 'https://bsky.app/x', source: 'bluesky' } });
    const { onSelect, onEdit } = renderList([reply]);
    fireEvent.keyDown(window, { key: 'j' });
    fireEvent.keyDown(window, { key: 'e' });
    expect(onEdit).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'bs' }), expect.any(Array));
  });

  it('never takes a key the owner types into a field', () => {
    renderList([mk('a')]);
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: 'j' });
    expect(document.activeElement).toBe(input);
    input.remove();
  });
});

describe('bulk delete (S1, S1e, S1u)', () => {
  it('says what a press leaves out, deletes with no dialog, keeps the verb, and ONE line names the published post', async () => {
    const user = userEvent.setup();
    const published = mk('pub', { title: 'Launch day', caption: 'Launch day', approval: 'approved', derivedState: 'posted', status: 'posted' });
    renderList([mk('a'), mk('b'), published]);
    await user.click(boxOf('Post a'));
    await user.click(within(bar()).getByRole('button', { name: 'Select all 3 in this view' }));
    expect(line()).toHaveTextContent('1 will not be deleted: published');
    await user.click(action('Delete'));
    await waitFor(() => expect(api.deletePost).toHaveBeenCalledTimes(2));
    expect(api.deletePost.mock.calls.map((c) => [c[1], c[2]])).toEqual([['a', false], ['b', false]]);
    expect(await screen.findByText('2 posts deleted')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // The rows that went through left the selection; the one left says why, and the verb stays.
    expect(bar()).toHaveAccessibleName('1 selected');
    expect(line()).toHaveTextContent('1 not deleted: Launch day is published');
    expect(action('Delete')).toHaveAccessibleName('Delete');
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(api.restorePost).toHaveBeenCalledTimes(2));
    expect(api.restorePost.mock.calls.map((c) => c[1])).toEqual(['a', 'b']);
    expect(await screen.findByText('2 posts restored')).toBeInTheDocument();
  });

  it('Undo clears the "1 not deleted" line (judge round 2, item 5)', async () => {
    const user = userEvent.setup();
    const published = mk('pub', { title: 'Launch day', caption: 'Launch day', approval: 'approved', derivedState: 'posted', status: 'posted' });
    renderList([mk('a'), published]);
    await user.click(boxOf('Post a'));
    await user.click(boxOf('Launch day'));
    await user.click(action('Delete'));
    await waitFor(() => expect(line()).toHaveTextContent('1 not deleted: Launch day is published'));
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(api.restorePost).toHaveBeenCalledTimes(1));
    await screen.findByText('1 post restored');
    expect(line()).not.toHaveTextContent('not deleted');
  });

  it('the result line goes when the selection changes', async () => {
    const user = userEvent.setup();
    const published = mk('pub', { title: 'Launch day', caption: 'Launch day', approval: 'approved', derivedState: 'posted', status: 'posted' });
    renderList([mk('a'), published, mk('c')]);
    await user.click(boxOf('Post a'));
    await user.click(boxOf('Launch day'));
    await user.click(action('Delete'));
    await waitFor(() => expect(line()).toHaveTextContent('1 not deleted'));
    await user.click(boxOf('Post c'));
    expect(line()).not.toHaveTextContent('not deleted');
  });

  it('in All projects every delete targets the post\'s own project', async () => {
    const user = userEvent.setup();
    renderList([mk('a', { clientId: 'acme' }), mk('b', { clientId: 'zeta' })]);
    await user.click(boxOf('Post a'));
    await user.click(boxOf('Post b'));
    await user.click(action('Delete'));
    await waitFor(() => expect(api.deletePost).toHaveBeenCalledTimes(2));
    expect(api.deletePost.mock.calls.map((c) => c[3])).toEqual(['acme', 'zeta']);
  });

  it('a partial failure keeps the failed post selected and names it in one line (S6)', async () => {
    const user = userEvent.setup();
    api.deletePost.mockImplementation((_c, id) => (id === 'b' ? Promise.reject(new Error('disk full')) : Promise.resolve({ ok: true })));
    renderList([mk('a'), mk('b')]);
    await user.click(boxOf('Post a'));
    await user.click(boxOf('Post b'));
    await user.click(action('Delete'));
    const alert = await within(bar()).findByRole('alert');
    expect(alert.textContent).toMatch(/^1 not deleted: Post b \(/);
    expect(alert.textContent).not.toMatch(/disk full/);
    expect(within(bar()).getByRole('button', { name: /more about this/i })).toHaveAccessibleDescription('Post b: disk full');
    expect(bar()).toHaveAccessibleName('1 selected');
  });
});

describe('bulk approve (S2, S2e)', () => {
  it('says before the press how many will not be approved and why, with Connect; approves the rest', async () => {
    const user = userEvent.setup();
    renderList([mk('a'), mk('tg', { platforms: ['telegram'] }), mk('c')]);
    await user.click(boxOf('Post a'));
    await user.click(within(bar()).getByRole('button', { name: 'Select all 3 in this view' }));
    expect(line()).toHaveTextContent('1 will not be approved: Telegram not connected');
    expect(within(line()).getByRole('button', { name: /Connect Telegram/ })).toBeInTheDocument();
    await user.click(action('Approve'));
    await waitFor(() => expect(api.approvePost).toHaveBeenCalledTimes(2));
    expect(api.approvePost.mock.calls.map((c) => c[1])).toEqual(['a', 'c']);
    expect(await screen.findByText('2 posts approved')).toBeInTheDocument();
    expect(line()).toHaveTextContent('1 not approved: Telegram not connected');
  });

  it('every row Approve leaves selected is explained: offline, already approved, published (judge round 2, item 5)', async () => {
    const user = userEvent.setup();
    const published = mk('pub', { title: 'Launch day', caption: 'Launch day', approval: 'approved', derivedState: 'posted', status: 'posted' });
    const approved = mk('ok', { title: 'Old news', caption: 'Old news', approval: 'approved', derivedState: 'scheduled' });
    renderList([mk('a'), mk('tg', { platforms: ['telegram'] }), approved, published]);
    await user.click(boxOf('Post a'));
    await user.click(within(bar()).getByRole('button', { name: 'Select all 4 in this view' }));
    expect(line()).toHaveTextContent('3 will not be approved: Telegram not connected, published, already approved');
    await user.click(action('Approve'));
    await waitFor(() => expect(api.approvePost).toHaveBeenCalledTimes(1));
    await screen.findByText('1 post approved');
    expect(bar()).toHaveAccessibleName('3 selected');
    expect(line()).toHaveTextContent('3 not approved: Telegram not connected; Launch day is published; Old news is already approved');
  });

  it('a click on a disabled action writes its reason into the line (touch has no tooltip; item 2)', async () => {
    const user = userEvent.setup();
    const published = mk('pub', { title: 'Launch day', caption: 'Launch day', approval: 'approved', derivedState: 'posted', status: 'posted' });
    renderList([published]);
    await user.click(boxOf('Launch day'));
    await user.click(action('Delete'));
    expect(api.deletePost).not.toHaveBeenCalled();
    expect(within(line()).getByRole('status')).toHaveTextContent('Published posts stay, nothing to delete');
  });

  it('a Radar reply past its time is approved and the toast says it goes 5 minutes after the approval', async () => {
    const user = userEvent.setup();
    const reply = mk('r1', { title: 'Reply one', caption: 'Reply one', radarReplyTo: { url: 'u' }, scheduledAt: new Date(Date.now() - 60_000).toISOString() });
    renderList([reply]);
    await user.click(boxOf('Reply one'));
    await user.click(action('Approve'));
    expect(await screen.findByText('1 post approved. The time had passed, so 5 minutes after the approval: Reply one')).toBeInTheDocument();
  });

  it('never shows the Approve note while a move is being set up', async () => {
    const user = userEvent.setup();
    renderList([mk('a'), mk('tg', { platforms: ['telegram'] })]);
    await user.click(boxOf('Post a'));
    await user.click(boxOf('Post tg'));
    expect(line()).toHaveTextContent('will not be approved');
    await user.click(action('Move'));
    await screen.findByRole('spinbutton', { name: 'Number of days' });
    expect(line()).not.toHaveTextContent('will not be approved');
  });
});

describe('bulk move (S3, S3e)', () => {
  it('moves by +2 days keeping each post\'s time; Undo puts the old times back', async () => {
    const user = userEvent.setup();
    const a = mk('a');
    const b = mk('b');
    renderList([a, b]);
    await user.click(boxOf('Post a'));
    await user.click(boxOf('Post b'));
    await user.click(action('Move'));
    const days = await screen.findByRole('spinbutton', { name: 'Number of days' });
    await user.clear(days);
    await user.type(days, '2');
    await user.click(screen.getByRole('button', { name: 'Move 2 posts' }));
    await waitFor(() => expect(api.reschedulePost).toHaveBeenCalledTimes(2));
    const [, , iso] = api.reschedulePost.mock.calls[0];
    const from = new Date(a.scheduledAt);
    const to = new Date(iso);
    expect(to.getDate()).toBe(new Date(from.getFullYear(), from.getMonth(), from.getDate() + 2).getDate());
    expect([to.getHours(), to.getMinutes()]).toEqual([from.getHours(), from.getMinutes()]);
    expect(await screen.findByText('2 posts moved')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(api.reschedulePost).toHaveBeenCalledTimes(4));
    expect(api.reschedulePost.mock.calls.slice(2).map((c) => [c[1], c[2]])).toEqual([['a', a.scheduledAt], ['b', b.scheduledAt]]);
    expect(await screen.findByText('2 posts moved back')).toBeInTheDocument();
  });

  it('an unconfirmed Facebook publish asks per post; a declined one is named in the line', async () => {
    const user = userEvent.setup();
    const held = Object.assign(new Error('needs confirm'), { code: 'needs_confirm', error: 'publish_unconfirmed' });
    api.reschedulePost.mockImplementation((_c, id, _iso, confirm) => (id === 'b' && !confirm ? Promise.reject(held) : Promise.resolve({ ok: true })));
    renderList([mk('a'), mk('b')]);
    await user.click(boxOf('Post a'));
    await user.click(boxOf('Post b'));
    await user.click(action('Move'));
    await user.click(await screen.findByRole('button', { name: 'Move 2 posts' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/Facebook never confirmed/);
    await user.click(within(dialog).getByRole('button', { name: /cancel/i }));
    expect(await screen.findByText('1 post moved')).toBeInTheDocument();
    expect(line()).toHaveTextContent('1 not moved: Post b not confirmed');
    expect(api.reschedulePost).toHaveBeenCalledTimes(2); // a, then b's first try only
  });
});

describe('bulk park / resume (S4)', () => {
  it('Park unschedules; a parked selection offers Resume, which resets executionMode', async () => {
    const user = userEvent.setup();
    const parked = mk('k', { approval: 'approved', derivedState: 'parked', executionMode: 'parked' });
    renderList([mk('a'), parked]);
    await user.click(boxOf('Post a'));
    await user.click(action('Park'));
    await waitFor(() => expect(api.unschedulePost).toHaveBeenCalledWith('launch', 'a', false, undefined));
    expect(await screen.findByText('1 post parked')).toBeInTheDocument();
    await user.click(boxOf('Post k'));
    expect(within(bar()).queryByRole('button', { name: 'Park' })).not.toBeInTheDocument();
    await user.click(action('Resume'));
    await waitFor(() => expect(api.updatePost).toHaveBeenCalledWith('launch', 'k', 'r-k', { executionMode: 'fully-scheduled' }, undefined));
    expect(await screen.findByText('1 post resumed')).toBeInTheDocument();
  });

  it('a parked post wears the Parked pill', () => {
    renderList([mk('k', { approval: 'draft', derivedState: 'parked', executionMode: 'parked' })]);
    expect(within(rowOf('Post k')).getByText('Parked')).toBeInTheDocument();
  });
});

describe('fix with agent (S5, S5e)', () => {
  const tooLong = (id) => mk(id, {
    approval: 'approved', derivedState: 'publish-failed',
    lastFailure: { lane: 'linkedin', code: 'too_long', recovery: 'edit', message: 'text too long', at: '2099-01-01T00:00:00Z' },
  });

  it('is disabled with its reason while no selected post is one for the agent', async () => {
    const user = userEvent.setup();
    renderList([mk('a'), mk('tg', { platforms: ['telegram'] })]);
    await user.click(boxOf('Post tg'));
    await act(async () => {});
    expect(action('Fix with agent')).toHaveAttribute('aria-disabled', 'true');
  });

  it('runs the content-blocked posts one at a time and names the connection-blocked one in the line', async () => {
    const user = userEvent.setup();
    const withAgent = { ...setup, agent: { connected: true, validation: { state: 'live' } } };
    api.agentFixPost.mockResolvedValue({ ok: true, state: 'running' });
    api.getAgentFixes.mockImplementation(() => Promise.resolve({
      running: false,
      fixes: api.agentFixPost.mock.calls.map(([campaign, postId]) => ({ campaign, postId, state: 'done' })),
    }));
    renderList([tooLong('f1'), tooLong('f2'), mk('tg', { platforms: ['telegram'] })], { setupFor: () => withAgent });
    await user.click(boxOf('Post f1'));
    await user.click(within(bar()).getByRole('button', { name: 'Select all 3 in this view' }));
    // An action's own note shows while the pointer or focus is on it.
    await user.hover(action('Fix with agent'));
    expect(line()).toHaveTextContent('1 will not be handed to the agent: nothing for the agent');
    await user.click(action('Fix with agent'));
    await waitFor(() => expect(api.agentFixPost).toHaveBeenCalledTimes(2));
    expect(api.agentFixPost.mock.calls.map((c) => c[1])).toEqual(['f1', 'f2']);
    expect(await screen.findByText('2 posts handed to the agent')).toBeInTheDocument();
    expect(line()).toHaveTextContent('1 not handed to the agent: the agent cannot fix Post tg');
  });
});

describe('undo after the engine answers', () => {
  it('a delete that could not go to the trash gets no Undo and the toast says so', async () => {
    const user = userEvent.setup();
    api.deletePost.mockResolvedValue({ ok: true, trashed: false });
    renderList([mk('a')]);
    await user.click(boxOf('Post a'));
    await user.click(action('Delete'));
    expect(await screen.findByText('1 post deleted. Cannot be undone: Post a')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('a post the trash no longer holds is named in the undo toast', async () => {
    const user = userEvent.setup();
    api.restorePost.mockRejectedValue(Object.assign(new Error('not in trash'), { code: 'not_in_trash' }));
    renderList([mk('a')]);
    await user.click(boxOf('Post a'));
    await user.click(action('Delete'));
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Not restored: Post a (no longer in the trash)')).toBeInTheDocument();
    expect(api.restorePost).toHaveBeenCalledWith('launch', 'a', undefined);
  });

  it('while a toast shows, the list keeps room for it at the bottom', async () => {
    const user = userEvent.setup();
    const { container } = renderList([mk('a'), mk('b')]);
    await user.click(boxOf('Post a'));
    await user.click(action('Delete'));
    await screen.findByText('1 post deleted');
    expect(toastBox()).not.toBeNull();
    const root = container.querySelector('[data-bulk-slot]').parentElement;
    expect(root.style.paddingBottom).toContain('--pp-toast-h');
  });
});
