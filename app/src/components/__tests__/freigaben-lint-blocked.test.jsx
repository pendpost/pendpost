import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Freigaben from '../Freigaben.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import { TAP_TARGET } from '../ui/recipes.js';
import { clearRefusals } from '../../lib/refusalMemo.js';

// #40: approve is refused (code lint_blocked) when the caption breaks a brand rule on a
// target platform. No confirm, no "approve anyway" (owner decision 2026-10-28): the alert
// names the platform and the fix. In a bulk approve each refused post is listed by post,
// next to the ones that did go through.
const approvePost = vi.fn();

vi.mock('../../lib/api.js', () => ({
  usePlatformValidate: () => ({ data: null }),
  approvePost: (...a) => approvePost(...a),
  rejectPost: vi.fn(() => Promise.resolve({ ok: true })),
  markPosted: vi.fn(() => Promise.resolve({ ok: true })),
  lintText: vi.fn(() => Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] })),
  usePendpostHealth: () => ({ data: null }),
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: null, isLoading: false, isError: false }),
}));

const base = {
  campaign: 'spring',
  caption: 'A caption body.',
  approval: 'pending',
  derivedState: 'draft',
  scheduledAt: '2026-07-01T10:00:00Z',
  type: 'text',
  image: null,
  media: { file: null, exists: false, bytes: null, url: null, cover: null, path: null },
};
const clean = { ...base, id: 'p1', title: 'Clean post', platforms: ['linkedin'] };
const dirty = { ...base, id: 'p2', title: 'Dirty post', platforms: ['linkedin', 'x'] };

const lintBlocked = () => Object.assign(new Error('caption fails brand lint on x'), {
  code: 'lint_blocked',
  findings: [{ platform: 'x', rule: 'banned-phrase', match: 'game-changer', hint: 'Say what it does instead.' }],
});

function renderFreigaben(posts, locale = 'en', { onEdit = vi.fn(), onNavigate = vi.fn() } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale={locale}>
        <TooltipProvider>
          <ConfirmProvider>
            <Freigaben campaigns={[{ id: 'spring', active: true, posts }]} onOpen={() => {}} onEdit={onEdit} onNavigate={onNavigate} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  clearRefusals(); approvePost.mockReset(); });

describe('Freigaben approve refused by the brand-lint gate (#40)', () => {
  it('a single approve says which platform, which rule and how to fix it; no engine line anywhere', async () => {
    approvePost.mockRejectedValue(lintBlocked());
    const user = userEvent.setup();
    renderFreigaben([dirty]);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The caption breaks a brand rule on X (Banned phrase). Edit the caption for X or remove X from the post.');
    // The engine's English finding is never shown, not even behind the "?".
    expect(screen.queryByRole('button', { name: /more about this/i })).toBeNull();
    // Refused once, never retried behind the owner's back.
    expect(approvePost).toHaveBeenCalledTimes(1);
  });

  it('the German surface says it in German', async () => {
    approvePost.mockRejectedValue(lintBlocked());
    const user = userEvent.setup();
    renderFreigaben([dirty], 'de-CH');
    await user.click(screen.getByRole('button', { name: 'Freigeben' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Der Text verstösst auf X gegen eine Markenregel (Banned phrase). Passe den Text für X an oder entferne X aus dem Beitrag.');
  });

  it('a bulk approve lists the refused post by post with its reason, and approves the rest', async () => {
    approvePost.mockImplementation((campaign, id) => (id === 'p2' ? Promise.reject(lintBlocked()) : Promise.resolve({ ok: true })));
    const user = userEvent.setup();
    renderFreigaben([clean, dirty]);
    for (const box of screen.getAllByRole('checkbox', { name: /select post/i })) await user.click(box);
    const bar = (await screen.findByText(/2 selected/i)).parentElement;
    await user.click(within(bar).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(within(bar).getByRole('alert')).toHaveTextContent(
      '1 approved, 1 failed: p2 (The caption breaks a brand rule on X (Banned phrase). Edit the caption for X or remove X from the post.)',
    ));
    expect(approvePost).toHaveBeenCalledTimes(2);
  });
});

// No dead ends: a refusal with a recovery carries its ONE action next to the sentence. A content
// fault (dead image link, brand-rule break) opens the editor on that post; a platform that is not
// set up opens Setup on that platform.
describe('Freigaben approve refusal offers its recovery inline', () => {
  it('a dead image link names the host and the Edit action opens the editor on that post', async () => {
    approvePost.mockRejectedValue(Object.assign(new Error('https://brand.example/media/a.jpg returned 404'), {
      code: 'media_url_dead', action: 'approve', url: 'https://brand.example/media/a.jpg', platform: 'instagram',
    }));
    const onEdit = vi.fn();
    const user = userEvent.setup();
    renderFreigaben([dirty], 'de-CH', { onEdit });
    await user.click(screen.getByRole('button', { name: 'Freigeben' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Der Bildlink für Instagram lädt nicht (brand.example), deshalb kann Instagram das Bild nicht abrufen. Ersetze das Bild im Editor und gib den Beitrag danach frei.');
    const edit = screen.getByRole('button', { name: 'Bearbeiten' });
    // The small inline action carries the shared 44px hit box (TAP_TARGET), painted size unchanged.
    for (const cls of TAP_TARGET.split(/\s+/)) expect(edit).toHaveClass(cls);
    await user.click(edit);
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: 'p2' }));
  });

  it('a platform that is not set up offers Setup on that platform', async () => {
    approvePost.mockRejectedValue(Object.assign(new Error('Reddit is not set up'), { code: 'not_configured', platform: 'reddit', action: 'approve' }));
    const onNavigate = vi.fn();
    const user = userEvent.setup();
    renderFreigaben([dirty], 'en', { onNavigate });
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByRole('alert');
    await user.click(screen.getByRole('button', { name: 'Setup' }));
    expect(onNavigate).toHaveBeenCalledWith('setup', 'reddit');
  });

  it('an unpublished own-site image names the publish step and offers no Edit', async () => {
    approvePost.mockRejectedValue(Object.assign(new Error('render not mirrored'), {
      code: 'media_url_dead', action: 'approve', url: 'https://pendpost.com/media/a.jpg', platform: 'instagram', fix: 'publish-media',
    }));
    const user = userEvent.setup();
    renderFreigaben([dirty], 'en', { onEdit: vi.fn() });
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("The image file isn't published to your site yet. Publish the media first, then approve the post.");
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

  it('a refusal with no recovery offers no action (never a dead button)', async () => {
    approvePost.mockRejectedValue(Object.assign(new Error('unknown post p2'), { code: 'unknown_post', action: 'approve' }));
    const user = userEvent.setup();
    renderFreigaben([dirty]);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This post no longer exists. It was deleted or moved in the meantime. Reload the list.');
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  });

});

// After a refusal the primary stays an action: it keeps reading Approve (never a red "Error"),
// disabled while the refusal names a blocker (pressing again cannot work), enabled otherwise.
describe('Freigaben Approve after a refusal', () => {
  it('a blocker refusal keeps the verb and disables Approve; the alert carries error + recovery', async () => {
    approvePost.mockRejectedValue(lintBlocked());
    const user = userEvent.setup();
    renderFreigaben([dirty], 'de-CH', { onEdit: vi.fn() });
    await user.click(screen.getByRole('button', { name: 'Freigeben' }));
    await screen.findByRole('alert');
    const approve = screen.getByRole('button', { name: 'Freigeben' });
    expect(approve).toBeDisabled();
    expect(approve).not.toHaveClass('bg-red-500/15');
    expect(screen.queryByRole('button', { name: 'Fehler' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Bearbeiten' })).toBeInTheDocument();
  });

  it('a non-blocking refusal keeps Approve enabled for another try', async () => {
    approvePost.mockRejectedValue(Object.assign(new Error('boom'), { code: 'engine_failure', action: 'approve' }));
    const user = userEvent.setup();
    renderFreigaben([dirty]);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Error' })).toBeNull();
  });
});

// The judge's row 5: after a queue refresh the refusal used to vanish and Approve turned green
// again. A blocking refusal stays until the post's content changes.
describe('Freigaben keeps a refusal until the post changes', () => {
  const withPosts = (posts) => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <Freigaben campaigns={[{ id: 'spring', active: true, posts }]} onOpen={() => {}} onEdit={vi.fn()} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
  const SENTENCE = 'The caption breaks a brand rule on X (Banned phrase). Edit the caption for X or remove X from the post.';

  it('a refresh (new rev, same content) and a remount keep the refusal and the disabled Approve', async () => {
    approvePost.mockRejectedValue(lintBlocked());
    const user = userEvent.setup();
    const post = { ...dirty, id: 'keep1', rev: 'r1' };
    const { rerender, unmount } = render(withPosts([post]));
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(SENTENCE);
    rerender(withPosts([{ ...post, rev: 'r2', verify: { at: 'now' } }]));
    expect(screen.getByRole('alert')).toHaveTextContent(SENTENCE);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    unmount();
    render(withPosts([{ ...post, rev: 'r3' }]));
    expect(screen.getByRole('alert')).toHaveTextContent(SENTENCE);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });

  it('editing the post clears the refusal: the next Approve is a fresh try', async () => {
    approvePost.mockRejectedValue(lintBlocked());
    const user = userEvent.setup();
    const post = { ...dirty, id: 'keep2', rev: 'r1' };
    const { rerender } = render(withPosts([post]));
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByRole('alert');
    rerender(withPosts([{ ...post, rev: 'r2', caption: 'A fixed caption.' }]));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });
});
