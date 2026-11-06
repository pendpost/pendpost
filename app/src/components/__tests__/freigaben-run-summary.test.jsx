import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Freigaben from '../Freigaben.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider, makeT } from '../../lib/i18n.js';

// Freigaben error UX (2026-11-06). The owner's screenshot: after a bulk approve, a red paragraph
// repeated "r211-fb-launch (Auf Facebook würde ...)" for four posts, with no button. Now:
//   - the bulk approve never SENDS a post whose own Approve is disabled (a hard blocker) or
//     whose lane is not connected; a skip glyph says how many before the press;
//   - what was left out is ONE quiet toolbar line, grouped by cause (a chip per cause), with
//     "show only these" and dismiss; never a post id;
//   - "N approved" in it counts this run's real successes only.
const approvePost = vi.fn(() => Promise.resolve({ ok: true }));
const verdicts = {};
vi.mock('../../lib/api.js', () => ({
  usePlatformValidate: (campaign, postId) => ({ data: verdicts[postId] || null }),
  approvePost: (...a) => approvePost(...a),
  rejectPost: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] })),
  usePendpostHealth: () => ({ data: null }),
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: null, isLoading: false, isError: false }),
}));

const t = makeT('en');
const post = (id, platforms = ['instagram', 'facebook']) => ({
  id, campaign: 'launch', title: `Post ${id}`, caption: `Caption ${id}`,
  platforms, approval: 'pending', derivedState: 'draft',
  scheduledAt: '2026-11-20T10:00:00Z', type: 'text', image: null,
  media: { file: null, exists: false, bytes: null, url: null, cover: null, path: null },
});
const fbOff = {
  ok: true,
  platforms: {
    instagram: { ready: true, problems: [], warnings: [] },
    facebook: { ready: false, needsSetup: false, problems: ['facebook publishing is disabled by platform policy'], problemCodes: [{ code: 'validate.fbDisabled', params: { platform: 'facebook' }, fix: 'edit' }], warnings: [] },
  },
};
const clean = { ok: true, platforms: { instagram: { ready: true, problems: [], warnings: [] } } };

function renderFreigaben(list) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <Freigaben campaigns={[{ id: 'launch', active: true, posts: list }]} onOpen={() => {}} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  approvePost.mockReset().mockResolvedValue({ ok: true });
  for (const k of Object.keys(verdicts)) delete verdicts[k];
});

describe('Freigaben bulk approve with hard-blocked posts', () => {
  it('never sends a hard-blocked post, says the skip before the press, and leaves one grouped line without ids', async () => {
    verdicts['ok-1'] = clean;
    verdicts['ok-2'] = clean;
    verdicts['r211-fb-launch'] = fbOff;
    verdicts['r212-fb-launch'] = fbOff;
    const posts = [post('ok-1', ['instagram']), post('ok-2', ['instagram']), post('r211-fb-launch'), post('r212-fb-launch')];
    const user = userEvent.setup();
    const { container } = renderFreigaben(posts);
    await user.click(screen.getByRole('checkbox', { name: /select all/i }));

    // Before the press: Approve counts what it will send; the skip glyph says 2, with the cause.
    const approve = await screen.findByRole('button', { name: t('approvals.bulk.approveN', { n: 2 }) });
    // Something to send: the filled emerald primary.
    expect(approve.className).toMatch(/bg-emerald-700/);
    const skip = container.querySelector('[data-bulk-skip]');
    expect(skip.textContent).toBe('2');
    // The glyph is "not allowed" (Ban), never a media "next"; tinted amber, AA in both themes.
    const glyph = skip.querySelector('svg');
    expect(glyph.getAttribute('class')).toMatch(/lucide-ban/);
    expect(glyph.getAttribute('class')).not.toMatch(/skip-forward/);
    expect(glyph.getAttribute('class')).toMatch(/(^|\s)text-amber-700(\s|$)/);
    expect(glyph.getAttribute('class')).toMatch(/(^|\s)dark:text-amber-400(\s|$)/);
    expect(skip.getAttribute('aria-label')).toBe('2 will not be approved: Facebook is off for this project');

    await user.click(approve);
    await waitFor(() => expect(approvePost).toHaveBeenCalledTimes(2));
    // The server never received the hard-blocked posts.
    const sent = approvePost.mock.calls.map((c) => c[1]);
    expect(sent).toEqual(['ok-1', 'ok-2']);

    // ONE quiet line: the count, one chip for the one cause, never an id, no red alert.
    await screen.findByText(t('approvals.result.notApproved', { n: 2 }));
    const line = container.querySelector('[data-run-summary]');
    expect(line.textContent).not.toMatch(/r21\d|ok-\d/);
    expect(screen.queryByRole('alert')).toBeNull();
    const chips = line.querySelectorAll('[data-cause]');
    expect(chips).toHaveLength(1);
    expect(chips[0].getAttribute('aria-label')).toBe('Facebook is off for this project: 2 posts');
    // The success count is this run's own.
    expect(within(line).getByLabelText('2 approved, 2 not approved')).toBeInTheDocument();
    // The posts that went through are deselected; the skipped ones stay selected.
    expect(screen.getByRole('checkbox', { name: t('approvals.bulk.selected', { n: 2 }) })).toBeInTheDocument();
  });

  it('"show only these" narrows the list to the posts the line names, and back', async () => {
    verdicts['ok-1'] = clean;
    verdicts['r211-fb-launch'] = fbOff;
    const posts = [post('ok-1', ['instagram']), post('r211-fb-launch'), post('other', ['instagram'])];
    verdicts.other = clean;
    approvePost.mockImplementation((_c, id) => (id === 'other' ? Promise.reject(new Error('boom')) : Promise.resolve({ ok: true })));
    const user = userEvent.setup();
    renderFreigaben(posts);
    for (const id of ['ok-1', 'r211-fb-launch', 'other']) {
      const row = screen.getAllByRole('listitem').find((li) => li.textContent.includes(`Caption ${id}`));
      await user.click(within(row).getByRole('checkbox', { name: /select post/i })); // eslint-disable-line no-await-in-loop
    }
    await user.click(await screen.findByRole('button', { name: t('approvals.bulk.approveN', { n: 2 }) }));
    await screen.findByText(t('approvals.result.notApproved', { n: 2 }));
    await user.click(screen.getByRole('button', { name: t('approvals.result.show') }));
    // ok-1 was approved (and leaves the queue in a real refetch); here it stays pending, so the
    // filter is what hides it.
    const shown = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(shown.some((s) => s.includes('Caption ok-1'))).toBe(false);
    expect(shown.some((s) => s.includes('Caption r211-fb-launch'))).toBe(true);
    expect(shown.some((s) => s.includes('Caption other'))).toBe(true);
    await user.click(screen.getByRole('button', { name: t('approvals.result.showAll') }));
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('nothing to send: Approve is disabled and nothing reaches the server', async () => {
    verdicts['r211-fb-launch'] = fbOff;
    const user = userEvent.setup();
    renderFreigaben([post('r211-fb-launch')]);
    await user.click(screen.getByRole('checkbox', { name: /select post/i }));
    const approve = await screen.findByRole('button', { name: t('approvals.bulk.approveN', { n: 0 }) });
    expect(approve).toBeDisabled();
    // Disabled must LOOK disabled: a grey outline, never the filled emerald of a live Approve.
    expect(approve.className).not.toMatch(/bg-emerald-700|dark:bg-emerald-400/);
    expect(approve.className).toMatch(/(^|\s)ring-1(\s|$)/);
    expect(approve.className).toMatch(/text-zinc-500/);
    expect(approvePost).not.toHaveBeenCalled();
  });
});

// The skip glyph's amber pair, measured like src/__tests__/contrast.test.js against the real
// body backgrounds (index.css: bg-slate-50 / dark:bg-zinc-950).
const lum = (h) => h.replace('#', '').match(/../g).map((x) => parseInt(x, 16) / 255)
  .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  .reduce((acc, c, i) => acc + c * [0.2126, 0.7152, 0.0722][i], 0);
const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
describe('the skip glyph tint clears AA', () => {
  it('amber-700 on the light body and amber-400 on the dark body are both >= 4.5:1', () => {
    expect(ratio('#b45309', '#f8fafc')).toBeGreaterThanOrEqual(4.5);
    expect(ratio('#fbbf24', '#09090b')).toBeGreaterThanOrEqual(4.5);
  });
});
