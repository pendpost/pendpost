// destination-strip.test.jsx - "which account do these posts go to", stated once.
//
// On 2026-07-25 a second client's post published onto the pendpost Instagram account. The
// operator approved it with nothing on screen naming the destination: the cards carry a
// platform GLYPH, which says instagram, not WHICH instagram. These tests pin the three
// things that make the strip worth trusting - it names the account, it never invents or
// hides one, and a lane with no account is an ACTION rather than a dead end.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import DestinationStrip, { destinationFor, shortId } from '../ui/DestinationStrip.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { ConfirmProvider } from '../ui/confirm.jsx';
import { I18nProvider, makeT } from '../../lib/i18n.js';

const t = makeT('en');

// Node's experimental localStorage has no methods under vitest, so the collapse
// preference must run against a real stub (repo gotcha, stubbed per file).
let store;
beforeEach(() => {
  store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  });
});
afterEach(() => vi.unstubAllGlobals());

// The real shape lib/accounts.mjs returns, with the two-client split (client B vs pendpost) that
// caused the incident: an Instagram account with a handle, one without.
const withHandle = {
  meta: { igHandle: 'northwind', igUserId: '17840000000000001', pageId: '100000000000001' },
  linkedin: { orgUrn: 'urn:li:organization:10000001' },
  youtube: { channelId: 'UC0000000000000000000001', handle: '' },
  x: { handle: 'northwind_x' },
};
const noHandle = {
  meta: { igHandle: '', igUserId: '17840000000000001', pageId: '100000000000001' },
  linkedin: { orgUrn: '' },
  youtube: { channelId: '', handle: '' },
  x: { handle: '' },
};
// Lanes the strip once falsely rendered amber "no account" over: every one of these
// is CONNECTED (lib/accounts.mjs payload shape), some with an identifier, some with
// only a credential.
const connectedLanes = {
  telegram: { authenticated: true, channelId: '-1001234567890123' },
  reddit: { authenticated: true, subreddit: 'pendpost' },
  discord: { authenticated: true },
  tiktok: { authenticated: true },
  pinterest: { authenticated: true, boardId: '912345678901234567' },
  wordpress: { authenticated: true, siteUrl: 'https://blog.example.com' },
  ghost: { authenticated: true, siteUrl: 'https://news.example.com/' },
  nostr: { authenticated: true, npub: 'npub1qqqsyqcyq5rqwzqfqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq' },
  gbp: { authenticated: true, locationId: 'locations/1234567890' },
};

function renderStrip(props, { expanded = true } = {}) {
  // Most tests pin the chip strip, which lives behind the disclosure: pre-seed the
  // preference so it renders expanded. Collapse tests pass { expanded: false }.
  if (expanded) store.set('pendpost-destination-collapsed', '0');
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider locale="en">
        <TooltipProvider>
          <ConfirmProvider>
            <DestinationStrip {...props} />
          </ConfirmProvider>
        </TooltipProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('destinationFor', () => {
  it('prefers a human handle over the machine id', () => {
    expect(destinationFor('instagram', withHandle)).toEqual({ handle: '@northwind', id: '17840000000000001' });
    expect(destinationFor('x', withHandle)).toEqual({ handle: '@northwind_x', id: null });
  });

  it('falls back to the id when there is no handle, never to nothing', () => {
    expect(destinationFor('instagram', noHandle)).toEqual({ handle: null, id: '17840000000000001' });
    // The urn prefix is machine noise; the org number is the identifying part.
    expect(destinationFor('linkedin', withHandle)).toEqual({ handle: null, id: '10000001' });
  });

  it('is null ONLY when the lane has no identifier at all', () => {
    expect(destinationFor('linkedin', noHandle)).toBeNull();
    expect(destinationFor('youtube', noHandle)).toBeNull();
    expect(destinationFor('instagram', null)).toBeNull();
  });

  it('covers the identifier lanes beyond the original six', () => {
    expect(destinationFor('telegram', connectedLanes)).toEqual({ handle: null, id: '-1001234567890123' });
    // A subreddit is a plain name, never an @handle.
    expect(destinationFor('reddit', connectedLanes)).toEqual({ handle: 'r/pendpost', id: null });
    expect(destinationFor('pinterest', connectedLanes)).toEqual({ handle: null, id: '912345678901234567' });
    expect(destinationFor('wordpress', connectedLanes)).toEqual({ handle: 'blog.example.com', id: null });
    expect(destinationFor('ghost', connectedLanes)).toEqual({ handle: 'news.example.com', id: null });
    expect(destinationFor('nostr', connectedLanes)).toEqual({ handle: null, id: connectedLanes.nostr.npub });
    expect(destinationFor('gbp', connectedLanes)).toEqual({ handle: null, id: 'locations/1234567890' });
  });

  it('a credentialed lane with no identifier reads connected, never missing', () => {
    expect(destinationFor('discord', connectedLanes)).toEqual({ connected: true });
    expect(destinationFor('tiktok', connectedLanes)).toEqual({ connected: true });
    // Same rule when the lane HAS an identifier slot but it is empty while the
    // credential exists.
    expect(destinationFor('reddit', { reddit: { authenticated: true, subreddit: '' } })).toEqual({ connected: true });
    // No credential at all stays null.
    expect(destinationFor('discord', { discord: { authenticated: false } })).toBeNull();
  });
});

describe('DestinationStrip', () => {
  it('names the account for each lane the list contains', () => {
    renderStrip({ platforms: ['instagram', 'x'], accounts: withHandle });
    expect(screen.getByText('@northwind')).toBeInTheDocument();
    expect(screen.getByText('@northwind_x')).toBeInTheDocument();
  });

  it('names only the lanes in front of the operator', () => {
    renderStrip({ platforms: ['instagram'], accounts: withHandle });
    expect(screen.queryByText('@northwind_x')).not.toBeInTheDocument();
  });

  it('renders a long id SHORT, with the full value reachable, never as a bare 17-digit number', () => {
    renderStrip({ platforms: ['instagram'], accounts: noHandle });
    expect(screen.queryByText('17840000000000001')).not.toBeInTheDocument();
    // Expanded shows the short id twice: once in the summary line, once as the chip.
    expect(screen.getAllByText(shortId('17840000000000001')).length).toBeGreaterThan(0);
    // The unabbreviated truth is still available.
    expect(screen.getByLabelText(/17840000000000001/)).toBeInTheDocument();
  });

  it('connected lanes NEVER render "no account on file"', () => {
    renderStrip({ platforms: ['telegram', 'reddit', 'discord'], accounts: connectedLanes });
    expect(screen.queryByText(t('destination.notConnected'))).not.toBeInTheDocument();
    expect(screen.getByText('r/pendpost')).toBeInTheDocument();
    // The credentialed-no-identifier lane says so quietly.
    expect(screen.getByText(t('destination.connected'))).toBeInTheDocument();
  });

  it('a lane with NO account is an action, not a warning that dead-ends', async () => {
    const onNavigate = vi.fn();
    renderStrip({ platforms: ['linkedin'], accounts: noHandle, onNavigate });
    // Said plainly, with the same Connect fix the post rows offer (an OAuth lane opens Setup
    // with the sign-in started).
    expect(screen.getByText('LinkedIn not connected')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Connect LinkedIn' }));
    expect(onNavigate).toHaveBeenCalledWith('setup', 'linkedin', { action: 'reconnect' });
  });

  // 2026-11-01: "No account on file" was vague and, beside rows judged by the setup, could
  // contradict them. The strip now reads the same setup the rows read.
  it('never says "No account on file"; the project setup decides "not connected"', () => {
    renderStrip({
      platforms: ['x', 'mastodon'],
      // Accounts know no X handle, yet the setup says X is connected: it is connected.
      accounts: { x: { handle: '' }, mastodon: { handle: '' } },
      setup: { platforms: [{ platform: 'x', status: 'connected' }, { platform: 'mastodon', status: 'incomplete' }] },
      onNavigate: vi.fn(),
    });
    expect(screen.queryByText(/no account on file/i)).not.toBeInTheDocument();
    expect(screen.queryByText('X not connected')).not.toBeInTheDocument();
    expect(screen.getByText('Mastodon not connected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect Mastodon' })).toBeInTheDocument();
  });

  it('a lane the owner marked as not in use reads quietly, never as not connected', () => {
    renderStrip({ platforms: ['x'], accounts: { x: { handle: '' } }, setup: { platforms: [{ platform: 'x', status: 'skipped' }] } });
    expect(screen.getByText('Not in use')).toBeInTheDocument();
    expect(screen.queryByText('X not connected')).not.toBeInTheDocument();
  });

  it('shows a skeleton while loading, not an empty row that reads as "no constraint"', () => {
    const { container } = renderStrip({ platforms: ['instagram'], accounts: null, isLoading: true });
    expect(container.querySelector('[aria-busy="true"]')).toBeTruthy();
    expect(screen.queryByText(t('destination.notConnected'))).not.toBeInTheDocument();
  });

  it('SAYS SO when the accounts cannot be read - a vanishing strip would be a lie', () => {
    renderStrip({ platforms: ['instagram'], accounts: null, isError: true });
    expect(screen.getByText(t('destination.unknown'))).toBeInTheDocument();
  });

  it('renders nothing when the list has no lanes at all', () => {
    const { container } = renderStrip({ platforms: [], accounts: withHandle });
    expect(container).toBeEmptyDOMElement();
  });
});

describe('DestinationStrip disclosure', () => {
  it('defaults COLLAPSED to one summary line: handles inline, chips hidden', () => {
    renderStrip({ platforms: ['instagram', 'x'], accounts: withHandle }, { expanded: false });
    const trigger = screen.getByRole('button', { expanded: false });
    expect(trigger).toHaveTextContent('@northwind · @northwind_x');
    // The chip strip (each chip carries the full-truth aria-label) is not rendered.
    expect(screen.queryByLabelText(/Instagram:/)).not.toBeInTheDocument();
  });

  it('summarises overflow as +N beyond the first three accounts', () => {
    renderStrip({ platforms: ['instagram', 'x', 'facebook', 'linkedin', 'youtube'], accounts: withHandle }, { expanded: false });
    const trigger = screen.getByRole('button', { expanded: false });
    expect(trigger).toHaveTextContent('+2');
    expect(trigger).not.toHaveTextContent(t('destination.missingCount', { n: 2 }));
  });

  it('names the unconnected count ONLY when lanes are truly unconnected', () => {
    renderStrip({ platforms: ['instagram', 'linkedin'], accounts: noHandle }, { expanded: false });
    expect(screen.getByText(t('destination.missingCount', { n: 1 }))).toBeInTheDocument();
  });

  it('the unconnected count wears the rows\' halted rose ink and alert glyph, never amber', () => {
    renderStrip({ platforms: ['instagram', 'linkedin'], accounts: noHandle }, { expanded: false });
    const count = screen.getByText(t('destination.missingCount', { n: 1 }));
    expect(count.getAttribute('data-tone')).toBe('halted');
    expect(count.className).toMatch(/text-rose-700/);
    expect(count.className).toMatch(/dark:text-rose-300/);
    expect(count.className).not.toMatch(/amber/);
    expect(count.querySelector('svg')).not.toBeNull();
  });

  it('connected-only lanes never count as unconnected in the summary', () => {
    renderStrip({ platforms: ['telegram', 'reddit', 'discord'], accounts: connectedLanes }, { expanded: false });
    const trigger = screen.getByRole('button', { expanded: false });
    expect(trigger).not.toHaveTextContent('ohne Konto');
    expect(trigger).not.toHaveTextContent('without an account');
  });

  it('the whole line expands to the chip strip and the choice persists', async () => {
    renderStrip({ platforms: ['instagram'], accounts: withHandle }, { expanded: false });
    await userEvent.click(screen.getByRole('button', { expanded: false }));
    expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument();
    expect(screen.getByLabelText(/Instagram:/)).toBeInTheDocument();
    expect(store.get('pendpost-destination-collapsed')).toBe('0');
  });

  it('expanded keeps the unconnected lane as a Setup deep-link', async () => {
    const onNavigate = vi.fn();
    renderStrip({ platforms: ['linkedin'], accounts: noHandle, onNavigate });
    await userEvent.click(screen.getByRole('button', { name: 'Connect LinkedIn' }));
    expect(onNavigate).toHaveBeenCalledWith('setup', 'linkedin', { action: 'reconnect' });
  });

  it('the collapsed summary counts lanes "not connected"', () => {
    renderStrip({ platforms: ['instagram', 'linkedin'], accounts: noHandle }, { expanded: false });
    expect(screen.getByText('1 not connected')).toBeInTheDocument();
  });
});
