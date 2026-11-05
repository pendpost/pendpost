// planner-list-bulk.test.jsx - multi-select and bulk actions in the planner List (planner bulk,
// package P; contract rows S1-S7, S10). The List wears the SAME selection + bar as Approvals
// (lib/useSelection.js + BulkBar.jsx). api.js is mocked: package T builds the restore route in
// parallel, so restorePost is a mock here.
import { render, screen, within, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ListView, ListKeyboardShortcuts } from '../Planner.jsx';
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
const bar = () => screen.getByRole('group', { name: /selected/ });
const header = (container) => container.querySelector('[data-bulk-bar]');

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

// The glyphs are named by their verb and how many posts they act on ("Delete 2"); a disabled
// one by its verb alone.
const glyph = (id) => bar().querySelector(`[data-bulk-action="${id}"]`);
const toastBox = () => document.querySelector('[data-app-toast]');
const selectAll = (user) => user.click(screen.getByRole('checkbox', { name: 'Select all' }));

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

  it('idle the header is ONE plain line (no box, no ring, no hint, no glyphs) that scrolls away; picking turns the same line sticky', async () => {
    const user = userEvent.setup();
    const { container } = renderList([mk('a'), mk('b')]);
    const line = header(container);
    expect(line).not.toBeNull();
    expect(line.className).not.toMatch(/(^|\s)ring-/);
    expect(line.className).not.toMatch(/(^|\s)bg-/);
    expect(line.className).not.toContain('sticky');
    expect(line.textContent).toBe('Select all');
    expect(container.querySelector('[data-bulk-line]')).toBeNull();
    expect(container.textContent).not.toMatch(/Keys:/);
    expect(line.querySelector('[data-bulk-action]')).toBeNull();
    await user.click(boxOf('Post a'));
    expect(header(container)).toBe(line);
    expect(bar()).toBe(line);
    expect(line.className).toContain('sticky');
    // The glyphs appear beside the count, in the owner's order, the destructive one last.
    expect([...line.querySelectorAll('[data-bulk-action]')].map((b) => b.dataset.bulkAction)).toEqual(['approve', 'move', 'park', 'agent', 'delete']);
  });

  it('a checkbox has a 44px hit area: its label is the target', () => {
    renderList([mk('a')]);
    const label = boxOf('Post a').closest('label');
    expect(label).not.toBeNull();
    expect(label.className).toMatch(/after:min-w-11/);
    expect(label.className).toMatch(/after:h-11/);
  });

  it('shift-click selects the range; the header checkbox clears a partial selection; "Select all" takes every row; Esc clears', async () => {
    const user = userEvent.setup();
    renderList([mk('a'), mk('b'), mk('c'), mk('d')]);
    await user.click(boxOf('Post a'));
    await user.keyboard('{Shift>}');
    await user.click(boxOf('Post c'));
    await user.keyboard('{/Shift}');
    expect(bar()).toHaveAccessibleName('3 selected');
    await user.click(within(bar()).getByRole('checkbox', { name: 'Clear selection' }));
    expect(screen.queryByRole('group', { name: /selected/ })).not.toBeInTheDocument();
    expect(boxOf('Post a')).not.toBeChecked();
    await selectAll(user);
    expect(bar()).toHaveAccessibleName('4 selected');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: /selected/ })).not.toBeInTheDocument();
  });

  it('there is no separate clear button', async () => {
    const user = userEvent.setup();
    renderList([mk('a'), mk('b')]);
    await user.click(boxOf('Post a'));
    expect(screen.queryByRole('button', { name: /clear/i })).not.toBeInTheDocument();
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
    expect(screen.queryByRole('group', { name: /selected/ })).not.toBeInTheDocument();
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

  it('the day headings stick to the top of the page, under the header while it sticks', () => {
    renderList([mk('a')]);
    const heading = screen.getByRole('heading', { level: 3 });
    expect(heading.parentElement.className).toContain('sticky');
    expect(heading.parentElement.style.top).toBe('var(--pp-bulk-h, 0px)');
  });

  // An opaque fill in the flow reads as a band on the translucent glass panel, so a day heading
  // is filled only while pinned (lib/useStuck.js), each on its own.
  it('a day heading is clear in the flow and filled only while pinned', () => {
    // jsdom has no layout: give the pinned element a rect at the sticky line (window root, top 0)
    // and leave everything else without one, then scroll once.
    const original = Element.prototype.getBoundingClientRect;
    const originalRaf = window.requestAnimationFrame;
    window.requestAnimationFrame = (cb) => { cb(0); return 1; };
    const box = (top, height) => ({ top, bottom: top + height, height, width: height ? 300 : 0, left: 0, right: height ? 300 : 0, x: 0, y: top });
    let pinned = null;
    Element.prototype.getBoundingClientRect = function rect() {
      if (pinned && this === pinned) return box(0, 28);
      if (pinned && this === pinned.parentElement) return box(-100, 400);
      return box(0, 0);
    };
    try {
      renderList([mk('a'), mk('b'), mk('c'), mk('d')]); // two days
      const headings = [...document.querySelectorAll('[data-day-heading]')];
      expect(headings).toHaveLength(2);
      for (const h of headings) {
        const cls = h.className.split(/\s+/);
        expect(cls).toEqual(expect.arrayContaining(['data-[stuck]:bg-[#fdfefe]', 'dark:data-[stuck]:bg-[#121215]']));
        expect(cls.some((c) => /^(dark:)?bg-/.test(c))).toBe(false);
        expect(h).not.toHaveAttribute('data-stuck');
      }
      [pinned] = headings;
      act(() => { window.dispatchEvent(new Event('scroll')); });
      expect(headings[0]).toHaveAttribute('data-stuck', '');
      expect(headings[1]).not.toHaveAttribute('data-stuck');
    } finally {
      Element.prototype.getBoundingClientRect = original;
      window.requestAnimationFrame = originalRaf;
    }
  });

  // A phone wears the SAME line: no bar floating at the bottom of the screen, nothing portalled.
  describe('on a phone', () => {
    let original;
    beforeEach(() => {
      original = window.matchMedia;
      window.matchMedia = (q) => ({ matches: q.includes('max-width: 767px'), media: q, addEventListener() {}, removeEventListener() {} });
    });
    afterEach(() => { window.matchMedia = original; });

    it('selecting keeps the header inline at the top of the list', async () => {
      const user = userEvent.setup();
      const { container } = renderList([mk('a'), mk('b')]);
      await user.click(boxOf('Post a'));
      const line = bar();
      expect(container.contains(line)).toBe(true);
      expect(line.parentElement.firstElementChild).toBe(line);
      expect(line.className).not.toMatch(/(^|\s)fixed(\s|$)/);
      expect(within(line).getByRole('status').textContent).toContain('1');
      expect(line.querySelectorAll('[data-bulk-action]')).toHaveLength(5);
    });
  });
});

describe('the fixed action set', () => {
  it('shows every glyph; one that applies to none of the selection is disabled with its reason', async () => {
    const user = userEvent.setup();
    const published = mk('pub', { title: 'Launch day', caption: 'Launch day', approval: 'approved', derivedState: 'posted', status: 'posted' });
    renderList([published, mk('a')]);
    await user.click(boxOf('Launch day'));
    for (const id of ['approve', 'move', 'park', 'agent', 'delete']) expect(glyph(id).textContent).toBe('');
    const del = glyph('delete');
    expect(del).toHaveAccessibleName('Delete');
    expect(del).toHaveAttribute('aria-disabled', 'true');
    expect(del).toHaveAccessibleDescription('Published posts stay, nothing to delete');
    expect(glyph('approve')).toHaveAttribute('aria-disabled', 'true');
    expect(glyph('agent')).toHaveAccessibleDescription('No agent connected. Connect one in Setup.');
    await user.click(del);
    expect(api.deletePost).not.toHaveBeenCalled();
  });

  it('each glyph is named by its verb and how many posts it acts on', async () => {
    const user = userEvent.setup();
    renderList([mk('a'), mk('b')]);
    await user.click(boxOf('Post a'));
    await user.click(boxOf('Post b'));
    expect(glyph('approve')).toHaveAccessibleName('Approve 2');
    expect(glyph('move')).toHaveAccessibleName('Move 2');
    expect(glyph('park')).toHaveAccessibleName('Park 2');
    expect(glyph('delete')).toHaveAccessibleName('Delete 2');
  });

  it('Approve is never the enabled action that will be refused: all offline means disabled, naming the lane', async () => {
    const user = userEvent.setup();
    renderList([mk('tg', { platforms: ['telegram'] })]);
    await user.click(boxOf('Post tg'));
    expect(glyph('approve')).toHaveAttribute('aria-disabled', 'true');
    expect(glyph('approve')).toHaveAccessibleDescription('Telegram not connected');
  });

  it('a click on a disabled glyph says its reason in the toast (touch has no tooltip)', async () => {
    const user = userEvent.setup();
    const published = mk('pub', { title: 'Launch day', caption: 'Launch day', approval: 'approved', derivedState: 'posted', status: 'posted' });
    renderList([published]);
    await user.click(boxOf('Launch day'));
    await user.click(glyph('delete'));
    expect(api.deletePost).not.toHaveBeenCalled();
    expect(within(toastBox()).getByRole('alert')).toHaveTextContent('Published posts stay, nothing to delete');
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
    expect(screen.queryByRole('group', { name: /selected/ })).not.toBeInTheDocument();
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

  it('the shortcuts are listed for the "?" popover, not as a hint on the page', () => {
    render(<I18nProvider locale="en"><ListKeyboardShortcuts /></I18nProvider>);
    expect([...document.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['j', 'k', 'x', 'Enter', 'e', 'Esc']);
    for (const text of ['Move between posts', 'Select the post', 'Open the post', 'Edit the post', 'Clear selection']) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
  });
});

describe('bulk delete (S1, S1e, S1u)', () => {
  it('the tooltip says what a press leaves out; deletes with no dialog; ONE toast says what it did and left out, with Undo', async () => {
    const user = userEvent.setup();
    const published = mk('pub', { title: 'Launch day', caption: 'Launch day', approval: 'approved', derivedState: 'posted', status: 'posted' });
    const { container } = renderList([mk('a'), mk('b'), published]);
    await selectAll(user);
    expect(glyph('delete')).toHaveAccessibleName('Delete 2');
    expect(glyph('delete')).toHaveAccessibleDescription('1 will not be deleted: published');
    await user.click(glyph('delete'));
    await waitFor(() => expect(api.deletePost).toHaveBeenCalledTimes(2));
    expect(api.deletePost.mock.calls.map((c) => [c[1], c[2]])).toEqual([['a', false], ['b', false]]);
    expect(await screen.findByText('2 posts deleted. 1 not deleted: Launch day is published')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // The rows that went through left the selection; nothing is reserved or added under the header.
    expect(bar()).toHaveAccessibleName('1 selected');
    expect(container.querySelector('[data-bulk-line], [data-bulk-result]')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(api.restorePost).toHaveBeenCalledTimes(2));
    expect(api.restorePost.mock.calls.map((c) => c[1])).toEqual(['a', 'b']);
    expect(await screen.findByText('2 posts restored')).toBeInTheDocument();
  });

  it('in All projects every delete targets the post\'s own project', async () => {
    const user = userEvent.setup();
    renderList([mk('a', { clientId: 'acme' }), mk('b', { clientId: 'zeta' })]);
    await user.click(boxOf('Post a'));
    await user.click(boxOf('Post b'));
    await user.click(glyph('delete'));
    await waitFor(() => expect(api.deletePost).toHaveBeenCalledTimes(2));
    expect(api.deletePost.mock.calls.map((c) => c[3])).toEqual(['acme', 'zeta']);
  });

  it('a partial failure keeps the failed post selected and names it in the toast, the raw line behind its "?" (S6)', async () => {
    const user = userEvent.setup();
    api.deletePost.mockImplementation((_c, id) => (id === 'b' ? Promise.reject(new Error('disk full')) : Promise.resolve({ ok: true })));
    renderList([mk('a'), mk('b')]);
    await user.click(boxOf('Post a'));
    await user.click(boxOf('Post b'));
    await user.click(glyph('delete'));
    const alert = await within(await waitFor(() => { const box = toastBox(); expect(box).not.toBeNull(); return box; })).findByRole('alert');
    expect(alert.textContent).toMatch(/^1 post deleted\. 1 not deleted: Post b \(/);
    expect(alert.textContent).not.toMatch(/disk full/);
    expect(within(toastBox()).getByRole('button', { name: /more about this/i })).toHaveAccessibleDescription('Post b: disk full');
    expect(within(toastBox()).getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(bar()).toHaveAccessibleName('1 selected');
  });
});

describe('bulk approve (S2, S2e)', () => {
  it('the tooltip says before the press how many will not be approved and why; approves the rest; the toast names the rest', async () => {
    const user = userEvent.setup();
    renderList([mk('a'), mk('tg', { platforms: ['telegram'] }), mk('c')]);
    await selectAll(user);
    expect(glyph('approve')).toHaveAccessibleName('Approve 2');
    expect(glyph('approve')).toHaveAccessibleDescription('1 will not be approved: Telegram not connected');
    await user.click(glyph('approve'));
    await waitFor(() => expect(api.approvePost).toHaveBeenCalledTimes(2));
    expect(api.approvePost.mock.calls.map((c) => c[1])).toEqual(['a', 'c']);
    expect(await screen.findByText('2 posts approved. 1 not approved: Telegram not connected')).toBeInTheDocument();
  });

  it('every row Approve leaves selected is explained: offline, already approved, published (judge round 2, item 5)', async () => {
    const user = userEvent.setup();
    const published = mk('pub', { title: 'Launch day', caption: 'Launch day', approval: 'approved', derivedState: 'posted', status: 'posted' });
    const approved = mk('ok', { title: 'Old news', caption: 'Old news', approval: 'approved', derivedState: 'scheduled' });
    renderList([mk('a'), mk('tg', { platforms: ['telegram'] }), approved, published]);
    await selectAll(user);
    expect(glyph('approve')).toHaveAccessibleDescription('3 will not be approved: Telegram not connected, published, already approved');
    await user.click(glyph('approve'));
    await waitFor(() => expect(api.approvePost).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('1 post approved. 3 not approved: Telegram not connected; Launch day is published; Old news is already approved')).toBeInTheDocument();
    expect(bar()).toHaveAccessibleName('3 selected');
  });

  it('a Radar reply past its time is approved and the toast says it goes 5 minutes after the approval', async () => {
    const user = userEvent.setup();
    const reply = mk('r1', { title: 'Reply one', caption: 'Reply one', radarReplyTo: { url: 'u' }, scheduledAt: new Date(Date.now() - 60_000).toISOString() });
    renderList([reply]);
    await user.click(boxOf('Reply one'));
    await user.click(glyph('approve'));
    expect(await screen.findByText('1 post approved. The time had passed, so 5 minutes after the approval: Reply one')).toBeInTheDocument();
  });

  it('the engine\'s own approve note rides the same one toast', async () => {
    const user = userEvent.setup();
    api.approvePost.mockResolvedValue({ ok: true, mediaPending: [{ platform: 'linkedin', url: 'https://x/y.png' }] });
    renderList([mk('a')]);
    await user.click(boxOf('Post a'));
    await user.click(glyph('approve'));
    expect(await screen.findByText("Approved. The image isn't online yet; pendpost checks it again right before posting.")).toBeInTheDocument();
    expect(document.querySelectorAll('[data-app-toast]')).toHaveLength(1);
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
    expect(glyph('move')).toHaveAccessibleName('Move 2');
    await user.click(glyph('move'));
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

  it('an unconfirmed Facebook publish asks per post; a declined one is named in the toast', async () => {
    const user = userEvent.setup();
    const held = Object.assign(new Error('needs confirm'), { code: 'needs_confirm', error: 'publish_unconfirmed' });
    api.reschedulePost.mockImplementation((_c, id, _iso, confirm) => (id === 'b' && !confirm ? Promise.reject(held) : Promise.resolve({ ok: true })));
    renderList([mk('a'), mk('b')]);
    await user.click(boxOf('Post a'));
    await user.click(boxOf('Post b'));
    await user.click(glyph('move'));
    await user.click(await screen.findByRole('button', { name: 'Move 2 posts' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toMatch(/Facebook never confirmed/);
    await user.click(within(dialog).getByRole('button', { name: /cancel/i }));
    expect(await screen.findByText('1 post moved. 1 not moved: Post b not confirmed')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    expect(api.reschedulePost).toHaveBeenCalledTimes(2); // a, then b's first try only
  });
});

describe('bulk park / resume (S4)', () => {
  it('Park unschedules; a parked selection offers Resume, which resets executionMode', async () => {
    const user = userEvent.setup();
    const parked = mk('k', { approval: 'approved', derivedState: 'parked', executionMode: 'parked' });
    renderList([mk('a'), parked]);
    await user.click(boxOf('Post a'));
    expect(glyph('park')).toHaveAccessibleName('Park 1');
    await user.click(glyph('park'));
    await waitFor(() => expect(api.unschedulePost).toHaveBeenCalledWith('launch', 'a', false, undefined));
    expect(await screen.findByText('1 post parked')).toBeInTheDocument();
    await user.click(boxOf('Post k'));
    expect(glyph('park')).toBeNull();
    expect(glyph('resume')).toHaveAccessibleName('Resume 1');
    await user.click(glyph('resume'));
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
    expect(glyph('agent')).toHaveAttribute('aria-disabled', 'true');
  });

  it('runs the content-blocked posts one at a time and names the connection-blocked one in the toast', async () => {
    const user = userEvent.setup();
    const withAgent = { ...setup, agent: { connected: true, validation: { state: 'live' } } };
    api.agentFixPost.mockResolvedValue({ ok: true, state: 'running' });
    api.getAgentFixes.mockImplementation(() => Promise.resolve({
      running: false,
      fixes: api.agentFixPost.mock.calls.map(([campaign, postId]) => ({ campaign, postId, state: 'done' })),
    }));
    renderList([tooLong('f1'), tooLong('f2'), mk('tg', { platforms: ['telegram'] })], { setupFor: () => withAgent });
    await selectAll(user);
    expect(glyph('agent')).toHaveAccessibleName('Fix 2 with agent');
    expect(glyph('agent')).toHaveAccessibleDescription('1 will not be handed to the agent: nothing for the agent');
    await user.click(glyph('agent'));
    await waitFor(() => expect(api.agentFixPost).toHaveBeenCalledTimes(2));
    expect(api.agentFixPost.mock.calls.map((c) => c[1])).toEqual(['f1', 'f2']);
    expect(await screen.findByText('2 posts handed to the agent. 1 not handed to the agent: the agent cannot fix Post tg')).toBeInTheDocument();
  });
});

describe('undo after the engine answers', () => {
  it('a delete that could not go to the trash gets no Undo and the toast says so', async () => {
    const user = userEvent.setup();
    api.deletePost.mockResolvedValue({ ok: true, trashed: false });
    renderList([mk('a')]);
    await user.click(boxOf('Post a'));
    await user.click(glyph('delete'));
    expect(await screen.findByText('1 post deleted. Cannot be undone: Post a')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('a post the trash no longer holds is named in the undo toast', async () => {
    const user = userEvent.setup();
    api.restorePost.mockRejectedValue(Object.assign(new Error('not in trash'), { code: 'not_in_trash' }));
    renderList([mk('a')]);
    await user.click(boxOf('Post a'));
    await user.click(glyph('delete'));
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(await screen.findByText('Not restored: Post a (no longer in the trash)')).toBeInTheDocument();
    expect(api.restorePost).toHaveBeenCalledWith('launch', 'a', undefined);
  });

  it('while a toast shows, the list keeps room for it at the bottom', async () => {
    const user = userEvent.setup();
    const { container } = renderList([mk('a'), mk('b')]);
    await user.click(boxOf('Post a'));
    await user.click(glyph('delete'));
    await screen.findByText('1 post deleted');
    expect(toastBox()).not.toBeNull();
    const root = header(container).parentElement;
    expect(root.style.paddingBottom).toContain('--pp-toast-h');
  });
});
