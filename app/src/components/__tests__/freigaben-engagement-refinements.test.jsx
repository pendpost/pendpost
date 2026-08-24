import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Freigaben from '../Freigaben.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// Canon refinements on the Radar engagement build (fresh-eyes findings 8/9/11):
//   - Bulk-approve honesty: a selection containing offline/copy-lane posts states,
//     inline in the bulk bar, how many posts bulk approve will skip ("n posts need
//     manual posting") - quiet text, never a dialog, never silent; the note stands
//     BEFORE the press and persists after it (skipped posts stay selected).
//   - Wrong-link repair: a hand-marked posted card carries a quiet "Fix link" that
//     re-opens the shared capture row prefilled, and saves through markPosted's
//     legal re-entry.
//   - The capture row's input has a VISIBLE persistent label, not placeholder-only.
const approvePost = vi.fn(() => Promise.resolve({ ok: true }));
const rejectPost = vi.fn(() => Promise.resolve({ ok: true }));
const markPosted = vi.fn(() => Promise.resolve({ ok: true }));
const lintText = vi.fn(() => Promise.resolve({ ok: true, clean: true, errors: 0, warnings: 0, findings: [] }));

// mastodon is INCOMPLETE (offline lane -> the hand-off / bulk-skip path);
// reddit carries no row, so it counts as connected.
const SETUP = { platforms: [{ platform: 'mastodon', status: 'incomplete' }] };

vi.mock('../../lib/api.js', () => ({
  approvePost: (...a) => approvePost(...a),
  rejectPost: (...a) => rejectPost(...a),
  markPosted: (...a) => markPosted(...a),
  lintText: (...a) => lintText(...a),
  usePendpostHealth: () => ({ data: { setup: SETUP } }),
  useConfig: () => ({ data: null }),
  useAccounts: () => ({ data: null, isLoading: false, isError: false }),
}));

const base = { campaign: 'c1', approval: 'pending', derivedState: 'draft', scheduledAt: '2026-07-01T10:00:00Z', type: 'text', media: { file: null, exists: false } };
const offlinePost = { ...base, id: 'off1', platforms: ['mastodon'], title: 'Offline lane post', caption: 'Offline lane post body' };
const connectedPost = { ...base, id: 'con1', platforms: ['reddit'], title: 'Connected lane post', caption: 'Connected lane post body' };
// A card as App.jsx's all-clients merge stamps it (issue 6): clientId/clientName/
// accent riding on the post, never present on a plain single-client post above.
const crossClientPost = { ...base, id: 'x1', clientId: 'globex', clientName: 'Globex', accent: '#7c3aed', platforms: ['reddit'], title: 'Cross-client post', caption: 'Cross-client post body' };

function renderFreigaben(posts) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <Freigaben campaigns={[{ id: 'c1', active: true, posts }]} onOpen={() => {}} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  approvePost.mockClear();
  rejectPost.mockClear();
  markPosted.mockClear();
});

describe('bulk-approve skip honesty (S3 bulk-skip feedback)', () => {
  it('states inline how many selected posts bulk approve will skip, approves only the connected ones, and keeps the note after the press', async () => {
    const user = userEvent.setup();
    renderFreigaben([offlinePost, connectedPost]);
    await user.click(screen.getByRole('checkbox', { name: /select all/i }));

    // The quiet note is there BEFORE anything is pressed - one offline post in scope.
    const bar = await screen.findByRole('region', { name: /2 selected/i });
    expect(within(bar).getByText('1 post needs manual posting')).toBeInTheDocument();

    await user.click(within(bar).getByRole('button', { name: /^approve$/i }));
    // Only the connected post was approved; the offline one was skipped, stays
    // selected, and the standing note keeps stating the skip - never silent.
    await waitFor(() => expect(approvePost).toHaveBeenCalledTimes(1));
    expect(approvePost).toHaveBeenCalledWith('c1', 'con1');
    const barAfter = screen.getByRole('region', { name: /1 selected/i });
    expect(within(barAfter).getByText('1 post needs manual posting')).toBeInTheDocument();
  });

  it('renders no note when every selected post is publishable', async () => {
    const user = userEvent.setup();
    renderFreigaben([connectedPost]);
    await user.click(screen.getByRole('checkbox', { name: /select all/i }));
    const bar = await screen.findByRole('region', { name: /1 selected/i });
    expect(within(bar).queryByText(/manual posting/i)).toBeNull();
  });
});

describe('wrong-pasted-link repair on the posted card (S4 posted state)', () => {
  const postedManual = {
    ...base,
    id: 'pm1',
    platforms: ['mastodon'],
    title: 'Hand-posted reply',
    caption: 'Hand-posted reply body',
    approval: 'approved',
    derivedState: 'posted',
    publishedVia: 'manual',
    externalUrl: 'https://wrong.example/mistake',
    radarReplyTo: { url: 'https://mastodon.example/@asker/1', source: 'mastodon', externalId: 'm1' },
  };

  it('offers Fix link on a hand-marked posted card, prefills the capture row (with its VISIBLE label), and overwrites via markPosted', async () => {
    const user = userEvent.setup();
    renderFreigaben([postedManual]);
    // Posted cards live on the "All posts" tab.
    await user.click(screen.getByRole('button', { name: /all posts/i }));

    // The live link renders from the (wrong) captured URL; beside it, the repair door.
    expect(screen.getByRole('link', { name: /view on mastodon/i })).toHaveAttribute('href', 'https://wrong.example/mistake');
    await user.click(screen.getByRole('button', { name: /fix link/i }));

    // The shared capture row: VISIBLE persistent label (canon Tier 2 forms rule),
    // input prefilled with the saved link so a correction edits, not retypes.
    expect(screen.getByText('Link to the published post')).toBeInTheDocument();
    const input = screen.getByLabelText('Link to the published post');
    expect(input).toHaveValue('https://wrong.example/mistake');

    await user.clear(input);
    await user.type(input, 'https://right.example/answer');
    await user.click(screen.getByRole('button', { name: /^posted$/i }));
    await waitFor(() => expect(markPosted).toHaveBeenCalledWith('c1', 'pm1', 'https://right.example/answer'));
  });

  // F3: a pasted link that is not an absolute http(s) URL is refused CLIENT-side with
  // the localized message BEFORE the send - the raw English engine string never leads -
  // and the typed value survives, resubmittable.
  it('refuses a non-absolute pasted link with the localized message and never calls the server', async () => {
    const user = userEvent.setup();
    renderFreigaben([postedManual]);
    await user.click(screen.getByRole('button', { name: /all posts/i }));
    await user.click(screen.getByRole('button', { name: /fix link/i }));
    const input = screen.getByLabelText('Link to the published post');
    await user.clear(input);
    await user.type(input, 'right.example/answer');
    await user.click(screen.getByRole('button', { name: /^posted$/i }));
    expect(screen.getByText('Invalid link. Please paste the address of the published post.')).toBeInTheDocument();
    expect(markPosted).not.toHaveBeenCalled();
    expect(input).toHaveValue('right.example/answer');
  });

  it('offers NO repair door on an engine-published card (its link is evidence, not a claim)', async () => {
    const user = userEvent.setup();
    renderFreigaben([{ ...postedManual, id: 'ep1', publishedVia: undefined, externalUrl: undefined, permalinks: { mastodon: 'https://mastodon.example/@us/9' } }]);
    await user.click(screen.getByRole('button', { name: /all posts/i }));
    expect(screen.getByRole('link', { name: /view on mastodon/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /fix link/i })).toBeNull();
  });
});

// UX issue 6 (cross-client Freigaben "All projects" mode). Freigaben itself is
// mode-agnostic - it only ever reacts to whether a POST carries clientId/
// clientName, which App.jsx's merge stamps on in the mode and never sets when
// it is off. So the card chip and the clientId-threaded write are both provable
// straight off a post fixture, without mounting the mode's App-level plumbing.
describe('cross-client card chip + clientId-threaded writes (issue 6)', () => {
  it('shows a client chip (name) on a card that carries clientName; a plain post carries none', () => {
    renderFreigaben([crossClientPost, connectedPost]);
    // Exactly one 'Globex' text node - the chip on the stamped card. The plain
    // connectedPost (no clientName) contributes none.
    expect(screen.getAllByText('Globex')).toHaveLength(1);
  });

  it('threads post.clientId into approvePost when the card carries one', async () => {
    const user = userEvent.setup();
    renderFreigaben([crossClientPost]);
    await user.click(screen.getByRole('button', { name: /^approve$/i }));
    await waitFor(() => expect(approvePost).toHaveBeenCalledTimes(1));
    expect(approvePost).toHaveBeenCalledWith('c1', 'x1', undefined, 'globex');
  });

  it('never adds a clientId argument when the card carries none (single-client mode call shape is untouched)', async () => {
    const user = userEvent.setup();
    renderFreigaben([connectedPost]);
    await user.click(screen.getByRole('button', { name: /^approve$/i }));
    await waitFor(() => expect(approvePost).toHaveBeenCalledTimes(1));
    expect(approvePost).toHaveBeenCalledWith('c1', 'con1');
  });

  it('threads post.clientId into rejectPost when the card carries one', async () => {
    const user = userEvent.setup();
    renderFreigaben([crossClientPost]);
    await user.click(screen.getByRole('button', { name: /^reject$/i }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox'), 'needs work');
    await user.click(within(dialog).getByRole('button', { name: /confirm/i }));
    await waitFor(() => expect(rejectPost).toHaveBeenCalledTimes(1));
    expect(rejectPost).toHaveBeenCalledWith('c1', 'x1', 'needs work', 'globex');
  });
});
