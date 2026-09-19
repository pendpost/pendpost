import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { axeClean } from '../../test-utils/axe.js';
import NeedsYou from '../radar/NeedsYou.jsx';
import { I18nProvider, useT } from '../../lib/i18n.js';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { TAP_TARGET } from '../ui/recipes.js';

// The "Needs you" strip (spec 50 S3 + S4, P5a). What is on trial is the promise the whole
// feature rests on: the owner is left with three questions a week, each resolvable in one tap
// or one line, and NOTHING else on screen. So the cases here are mostly about restraint -
// the strip is absent when there is nothing open, it never shows more than five rows without
// being asked, each row carries exactly one primary and exactly one reason line, and a failed
// send never costs the owner the words they typed.

let asksData;
let loading = false;
let isError = false;
const refetchMock = vi.fn();
const answerMock = vi.fn(() => Promise.resolve({ ok: true, confirm: false }));
const confirmMock = vi.fn(() => Promise.resolve({ ok: true }));
const dismissMock = vi.fn(() => Promise.resolve({ ok: true }));
const probeMock = vi.fn(() => Promise.resolve({ ok: true, usable: true }));
const markCopyPostedMock = vi.fn(() => Promise.resolve({ ok: true }));

vi.mock('../../lib/api.js', () => ({
  useEngageAsks: () => ({ data: asksData, isLoading: loading, isError, refetch: refetchMock }),
  useActiveClient: () => ({ activeClient: { id: 'acme', displayName: 'Acme' }, activeClientId: 'acme' }),
  engageAnswer: (...a) => answerMock(...a),
  engageConfirmAsk: (...a) => confirmMock(...a),
  engageDismiss: (...a) => dismissMock(...a),
  engageProbe: (...a) => probeMock(...a),
  radarMarkCopyPosted: (...a) => markCopyPostedMock(...a),
  errText: (err, t, fallbackKey) => (err?.message || t(fallbackKey)),
}));

const ask = (over = {}) => ({
  id: 'ask-1',
  kind: 'question',
  status: 'open',
  lane: 'reddit',
  signalKey: 'reddit e1',
  actionId: null,
  question: 'Is the reviewer link included in Starter?',
  draft: 'Per client. Each brand has its own approval gate.',
  finalText: '',
  reasonLine: '',
  urgent: false,
  answer: '',
  createdAt: '2026-09-09T06:00:00.000Z',
  resolvedAt: null,
  signal: {
    source: 'reddit', externalId: 'e1', author: 'sam_builds', community: 'r/selfhosted',
    text: 'Does it do approval per client or only global?', url: 'https://example.test/e1', intentScore: 84,
  },
  ...over,
});

function Harness() {
  const t = useT();
  return <NeedsYou enabled t={t} />;
}
function renderStrip({ locale = 'en' } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale={locale}>
        <TooltipProvider>
          <Harness />
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  asksData = { ok: true, asks: [] };
  loading = false;
  isError = false;
  refetchMock.mockClear();
  answerMock.mockClear();
  answerMock.mockImplementation(() => Promise.resolve({ ok: true, confirm: false }));
  confirmMock.mockClear();
  dismissMock.mockClear();
  probeMock.mockClear();
  markCopyPostedMock.mockClear();
});

describe('Needs you strip (spec 50 S3)', () => {
  it('renders NOTHING when nothing is open - no "all clear" card to learn to ignore', () => {
    const { container } = renderStrip();
    expect(container.textContent).toBe('');
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('shows three skeleton rows while it loads, and never a zero count', () => {
    loading = true;
    asksData = undefined;
    renderStrip();
    expect(screen.queryByText(/Needs you/)).toBeNull();
  });

  it('says so, with a Retry, when the read fails', async () => {
    isError = true;
    asksData = undefined;
    renderStrip();
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load what needs you.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetchMock).toHaveBeenCalled();
  });

  it('caps at five rows and expands the rest IN PLACE (row 8e3)', async () => {
    asksData = { ok: true, asks: Array.from({ length: 8 }, (_, i) => ask({ id: `ask-${i}`, signalKey: `reddit e${i}`, signal: { ...ask().signal, externalId: `e${i}`, author: `person_${i}` } })) };
    renderStrip();
    expect(screen.getByRole('heading', { name: 'Needs you (8)' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(5);
    const more = screen.getByRole('button', { name: 'and 3 more' });
    await userEvent.click(more);
    expect(screen.getAllByRole('listitem')).toHaveLength(8);
    // In place: the strip is still the same one region, no navigation happened.
    expect(screen.getAllByRole('region')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /more/ })).toBeNull();
  });

  it('leads with the urgent row (the engine decided that, not the row)', () => {
    asksData = { ok: true, asks: [
      ask({ id: 'calm', signal: { ...ask().signal, author: 'calm_person' } }),
      ask({ id: 'urgent', urgent: true, signal: { ...ask().signal, author: 'press_person' } }),
    ] };
    renderStrip();
    // The strip renders in the order the ENGINE handed it - it never re-sorts, so a row
    // marked urgent by the server is the one that carries the badge.
    expect(within(screen.getAllByRole('listitem')[1]).getByText('Urgent')).toBeInTheDocument();
  });
});

describe('Ask row (spec 50 S4)', () => {
  it('gives a question ONE primary (Send), disabled until there is an answer', async () => {
    asksData = { ok: true, asks: [ask()] };
    renderStrip();
    const row = screen.getByRole('listitem');
    expect(within(row).getByText('Question: Is the reviewer link included in Starter?')).toBeInTheDocument();
    const send = within(row).getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    await userEvent.type(within(row).getByLabelText('Your answer'), 'yes, in every tier');
    expect(send).toBeEnabled();
    await userEvent.click(send);
    expect(answerMock).toHaveBeenCalledWith('ask-1', 'yes, in every tier');
    // Resolved: the row collapses to one confirmation line instead of vanishing.
    await waitFor(() => expect(screen.getByText('Sent')).toBeInTheDocument());
  });

  it('keeps the typed answer when the send fails, and offers Retry', async () => {
    asksData = { ok: true, asks: [ask()] };
    answerMock.mockImplementation(() => Promise.reject(new Error('the daemon is not running')));
    renderStrip();
    const row = screen.getByRole('listitem');
    const box = within(row).getByLabelText('Your answer');
    await userEvent.type(box, 'the reviewer link is in Starter');
    await userEvent.click(within(row).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(within(row).getByRole('alert')).toHaveTextContent('Could not send. the daemon is not running'));
    // THE property: the words are still there. Losing them would be the one unforgivable bug.
    expect(box).toHaveValue('the reviewer link is in Starter');
    expect(within(row).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('gives a confirm the Post primary and its own reason line', async () => {
    asksData = { ok: true, asks: [ask({ id: 'c1', kind: 'confirm', question: '', draft: '', finalText: 'The Agency tier is 129 a month.', reasonLine: 'this touches pricing' })] };
    renderStrip();
    const row = screen.getByRole('listitem');
    expect(within(row).getByText('Checked before posting: this touches pricing')).toBeInTheDocument();
    expect(within(row).getByText('The Agency tier is 129 a month.')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Send' })).toBeNull();
    await userEvent.click(within(row).getByRole('button', { name: 'Post' }));
    // No edit was made, so nothing overrides the text the owner just read.
    expect(confirmMock).toHaveBeenCalledWith('c1', null);
  });

  it('gives a hand-off the Posted primary, a link field and Copy draft in the overflow', async () => {
    asksData = { ok: true, asks: [ask({ id: 'h1', kind: 'handoff', lane: 'linkedin', question: '', reasonLine: 'the post box was not found', signal: { ...ask().signal, source: 'linkedin', externalId: 'h1' } })] };
    renderStrip();
    const row = screen.getByRole('listitem');
    expect(within(row).getByText('Could not post on LinkedIn: the post box was not found')).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: /More|Mehr|options/i }));
    expect(within(row).getByRole('menuitem', { name: 'Copy draft' })).toBeInTheDocument();
    expect(within(row).queryByRole('menuitem', { name: 'Edit' })).toBeNull();
    await userEvent.keyboard('{Escape}');
    await userEvent.click(within(row).getByRole('button', { name: 'Posted' }));
    expect(markCopyPostedMock).toHaveBeenCalledWith('linkedin', 'h1', undefined);
  });

  it('gives the row overflow a 44px hit area without growing the row (canon Tier 2)', () => {
    // The strip reuses the Radar feed's RowMenu, so the tap-target floor is inherited rather
    // than re-implemented. The glyph stays 16px: a finger gets a bigger target, the eye does
    // not get a bigger button. See components/__tests__/tap-target.test.jsx for the token.
    asksData = { ok: true, asks: [ask()] };
    renderStrip();
    const trigger = within(screen.getByRole('listitem')).getByRole('button', { name: /More|Mehr|options/i });
    for (const cls of TAP_TARGET.split(/\s+/)) expect(trigger).toHaveClass(cls);
    expect(trigger.querySelector('svg')).toHaveAttribute('width', '16');
    expect(trigger.className.split(/\s+/).filter((c) => /^(h|w|min-h|min-w|size)-/.test(c))).toEqual([]);
  });

  it('gives a login ask Check again, and says so when the platform is still logged out', async () => {
    asksData = { ok: true, asks: [ask({ id: 'l1', kind: 'login', lane: 'linkedin', question: '', draft: '', signal: null })] };
    probeMock.mockImplementation(() => Promise.resolve({ ok: true, usable: false, reason: 'not_logged_in' }));
    renderStrip();
    const row = screen.getByRole('listitem');
    // Word for word the ledger's own state line (autonomy.engage.lane.notLoggedIn): the strip
    // that interrupts you must not say less than the surface you go looking for.
    expect(within(row).getByText('Not logged in · Log in to LinkedIn in Chrome, then')).toBeInTheDocument();
    await userEvent.click(within(row).getByRole('button', { name: 'Check again' }));
    expect(probeMock).toHaveBeenCalledWith('linkedin');
    await waitFor(() => expect(within(row).getByRole('alert')).toHaveTextContent('Still not logged in.'));
    // A check that failed again leaves the row exactly where it was - it never fakes a resolve.
    expect(screen.queryByText('Sent')).toBeNull();
  });

  it('names the other account AND the fix on a switchAccount ask, in the ledger\'s words', () => {
    asksData = { ok: true, asks: [ask({ id: 's1', kind: 'switchAccount', lane: 'x', question: '', draft: '', reasonLine: 'other_brand', signal: null })] };
    renderStrip();
    expect(screen.getByText('Logged in as @other_brand · Switch X to the Acme account in Chrome, then')).toBeInTheDocument();
  });

  it('puts Skip in the overflow, never beside the primary', async () => {
    asksData = { ok: true, asks: [ask()] };
    renderStrip();
    const row = screen.getByRole('listitem');
    expect(within(row).queryByRole('button', { name: 'Skip' })).toBeNull();
    await userEvent.click(within(row).getByRole('button', { name: /More|Mehr|options/i }));
    await userEvent.click(within(row).getByRole('menuitem', { name: 'Skip' }));
    expect(dismissMock).toHaveBeenCalledWith('ask-1');
  });

  it('an answer the agent judged sensitive does not claim it was sent', async () => {
    asksData = { ok: true, asks: [ask()] };
    answerMock.mockImplementation(() => Promise.resolve({ ok: true, confirm: true }));
    renderStrip();
    const row = screen.getByRole('listitem');
    await userEvent.type(within(row).getByLabelText('Your answer'), 'Agency is 129');
    await userEvent.click(within(row).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(answerMock).toHaveBeenCalled());
    expect(screen.queryByText('Sent')).toBeNull();
  });

  it('is accessible and reads the same in German', async () => {
    asksData = { ok: true, asks: [ask(), ask({ id: 'c1', kind: 'confirm', question: '', finalText: 'text', reasonLine: 'Preise' })] };
    const { container, unmount } = renderStrip();
    await axeClean(container);
    unmount();
    renderStrip({ locale: 'de-CH' });
    expect(screen.getByRole('heading', { name: 'Braucht dich (2)' })).toBeInTheDocument();
    expect(screen.getByText('Vor dem Posten geprüft: Preise')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Senden' })).toHaveLength(1);
  });
});
