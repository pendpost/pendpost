import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ApprovalBlockerLine, { COPY_CONFIRM_MS } from '../ApprovalBlockerLine.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// The approval card's ONE blocker line (Freigaben error UX, 2026-11-06): glyph buttons with the
// words on hover. fbDisabled offers "turn Facebook on" (that post's project) and "without
// Facebook" (hidden when Facebook is the post's only platform); the agent glyph only with an
// agent; the copy glyph always, turning into a check for 1.5 s.
const setPlatformEnabled = vi.fn(() => Promise.resolve({ ok: true }));
const updatePost = vi.fn(() => Promise.resolve({ ok: true }));
const agentFixPost = vi.fn(() => Promise.resolve({ ok: true }));
vi.mock('../../lib/api.js', () => ({
  setPlatformEnabled: (...a) => setPlatformEnabled(...a),
  updatePost: (...a) => updatePost(...a),
  agentFixPost: (...a) => agentFixPost(...a),
  usePendpostHealth: () => ({ data: null }),
  resumeLane: vi.fn(),
  recheckHealth: vi.fn(),
  markPosted: vi.fn(),
  deletePost: vi.fn(),
}));

const fbOff = { platform: 'facebook', code: 'validate.fbDisabled', params: { platform: 'facebook' }, fix: 'edit', text: 'facebook publishing is disabled by platform policy' };
const xLong = { platform: 'x', code: 'validate.xTooLong', params: {}, fix: 'edit', text: 'text is 412 chars - X caps at 280' };
const post = { id: 'r211-fb-launch', campaign: 'launch', rev: 'rev-1', clientId: 'acme', platforms: ['instagram', 'facebook'] };
const withAgent = { agent: { connected: true, validation: { state: 'ok' } } };

let qc;
function renderLine(props) {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(qc, 'invalidateQueries');
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <ApprovalBlockerLine post={post} blockers={[fbOff]} {...props} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

let writeText;
beforeEach(() => {
  setPlatformEnabled.mockReset().mockResolvedValue({ ok: true });
  updatePost.mockReset().mockResolvedValue({ ok: true });
  writeText = vi.fn(() => Promise.resolve());
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, running: false, fixes: [] }) })));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ApprovalBlockerLine', () => {
  it('reads one short cause, the full sentence behind the ?, and glyph buttons with names', () => {
    const { container } = renderLine();
    expect(container.querySelector('[data-blocker-short]').textContent).toBe('Facebook is off for this project');
    // The full sentence is the "?"'s description (hover, tap or focus opens it).
    expect(screen.getByRole('button', { name: /more about this/i })).toHaveAccessibleDescription(/^Facebook publishing is turned off for this project/);
    for (const name of ['Copy a brief for an agent', 'Turn on Facebook for this project', 'Remove Facebook from this post']) {
      const b = screen.getByRole('button', { name });
      expect(b.textContent).toBe('');
      expect(b.className).toMatch(/h-10 w-10/);
      expect(b.className).toMatch(/focus-visible:ring-2/);
    }
  });

  // Live walks (2026-11-06): "Facebook is o..." in the grid and "F" at 375px, then a nowrap
  // cause running past the card edge at 375px. jsdom has no layout, so the contract is the
  // classes: the cause never truncates or clips, its words WRAP inside the card, it claims a
  // 12rem basis so narrow rows push the glyph buttons below it.
  it('the cause never truncates: its words wrap inside the card, the buttons wrap below', () => {
    const { container } = renderLine();
    const short = container.querySelector('[data-blocker-short]');
    expect(short.className).not.toMatch(/(^|\s)(truncate|line-clamp-\d|overflow-hidden|whitespace-nowrap)(\s|$)/);
    expect(short.className).toMatch(/(^|\s)break-words(\s|$)/);
    const unit = short.parentElement;
    expect(unit.querySelector('[data-platform="facebook"]')).not.toBeNull();
    expect(unit.className).not.toMatch(/(^|\s)(truncate|overflow-hidden|whitespace-nowrap)(\s|$)/);
    expect(unit.parentElement.className).toMatch(/flex-\[1_1_12rem\]/);
    let el = unit.parentElement;
    while (el && el !== container) {
      expect(el.className, el.outerHTML.slice(0, 80)).not.toMatch(/(^|\s)(truncate|overflow-hidden)(\s|$)/);
      if (el.hasAttribute('data-blocker-line')) break;
      el = el.parentElement;
    }
    // The row wraps: the buttons go to the next line when the cause and they do not fit.
    const row = container.querySelector('[data-blocker-row]');
    expect(row.className).toMatch(/(^|\s)flex-wrap(\s|$)/);
    const buttons = container.querySelector('[data-blocker-actions]');
    expect(buttons.className).toMatch(/(^|\s)ml-auto(\s|$)/);
    expect(buttons.className).toMatch(/(^|\s)flex-wrap(\s|$)/);
  });

  it('turn on Facebook wears a toggle glyph (ToggleRight), never a power symbol', () => {
    renderLine();
    const on = screen.getByRole('button', { name: 'Turn on Facebook for this project' });
    const cls = on.querySelector('svg').getAttribute('class');
    expect(cls).toMatch(/lucide-toggle-right/);
    expect(cls).not.toMatch(/lucide-power/);
  });

  it('hides "without Facebook" when Facebook is the post\'s only platform', () => {
    renderLine({ post: { ...post, platforms: ['facebook'] } });
    expect(screen.queryByRole('button', { name: 'Remove Facebook from this post' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Turn on Facebook for this project' })).toBeInTheDocument();
  });

  it('hides "turn on" when an ops lock holds Facebook off', () => {
    renderLine({ blockers: [{ ...fbOff, params: { platform: 'facebook', locked: true } }] });
    expect(screen.queryByRole('button', { name: 'Turn on Facebook for this project' })).toBeNull();
  });

  it('turn on writes posting.platforms for THIS post\'s project and refreshes the verdicts', async () => {
    renderLine();
    fireEvent.click(screen.getByRole('button', { name: 'Turn on Facebook for this project' }));
    await waitFor(() => expect(setPlatformEnabled).toHaveBeenCalledWith('facebook', true, 'acme'));
    await waitFor(() => expect(qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['platform-validate'] }));
    for (const key of ['config', 'pendpost-health', 'plans']) expect(qc.invalidateQueries).toHaveBeenCalledWith({ queryKey: [key] });
  });

  it('without Facebook removes it from the post (its rev, its project)', async () => {
    renderLine();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Facebook from this post' }));
    await waitFor(() => expect(updatePost).toHaveBeenCalledWith('launch', 'r211-fb-launch', 'rev-1', { platforms: ['instagram'] }, 'acme'));
  });

  it('a failed write says so in one line with a retry', async () => {
    updatePost.mockRejectedValueOnce(new Error('HTTP 500'));
    renderLine();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Facebook from this post' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(updatePost).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('copy puts a self-contained brief on the clipboard and shows a check for 1.5 s', async () => {
    renderLine({ blockers: [fbOff, xLong] });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy a brief for an agent' })); });
    expect(writeText).toHaveBeenCalledTimes(1);
    const brief = writeText.mock.calls[0][0];
    expect(brief).toMatch(/clientId\): "acme"/);
    expect(brief).toMatch(/postId: "r211-fb-launch"/);
    expect(brief).toMatch(/validate\.fbDisabled/);
    expect(brief).toMatch(/validate\.xTooLong/);
    expect(brief).toMatch(/plan_get[\s\S]*platform_validate[\s\S]*plan_update_post/);
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy a brief for an agent' })).toBeInTheDocument(), { timeout: COPY_CONFIRM_MS + 1000 });
  });

  it('two causes: the first leads, "+1" carries the rest', () => {
    renderLine({ blockers: [fbOff, xLong] });
    expect(screen.getByLabelText(/^1 more reasons?: /)).toHaveTextContent('+1');
  });

  it('no agent: no agent glyph, the copy glyph stays', () => {
    renderLine({ setup: null });
    expect(screen.queryByRole('button', { name: 'Fix with agent' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy a brief for an agent' })).toBeInTheDocument();
  });

  it('an agent for this project: the agent glyph runs the existing agent fix for this post', async () => {
    renderLine({ setup: withAgent });
    const agent = screen.getByRole('button', { name: 'Fix with agent' });
    expect(agent.textContent).toBe('');
    fireEvent.click(agent);
    await waitFor(() => expect(agentFixPost).toHaveBeenCalledWith('launch', 'r211-fb-launch', 'acme'));
  });

  it('Facebook as the only platform: no agent glyph (it could only fail); copy and turn on stay', () => {
    renderLine({ setup: withAgent, post: { ...post, platforms: ['facebook'] } });
    expect(screen.queryByRole('button', { name: 'Fix with agent' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Copy a brief for an agent' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Turn on Facebook for this project' })).toBeInTheDocument();
  });

  it('Facebook only plus a text problem: the agent glyph targets the text problem', async () => {
    renderLine({ setup: withAgent, post: { ...post, platforms: ['facebook'] }, blockers: [fbOff, { ...xLong, platform: 'facebook', code: 'validate.captionTooLong' }] });
    expect(screen.getByRole('button', { name: 'Fix with agent' })).toBeInTheDocument();
  });

  it('a connection-only cause offers no agent glyph', () => {
    renderLine({ setup: withAgent, blockers: [{ platform: 'telegram', code: 'validate.telegramChannelMissing', params: {}, fix: 'setup', text: 'no channel' }] });
    expect(screen.queryByRole('button', { name: 'Fix with agent' })).toBeNull();
  });
});
