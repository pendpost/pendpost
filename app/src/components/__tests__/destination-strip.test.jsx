// destination-strip.test.jsx - "which account do these posts go to", stated once.
//
// On 2026-07-25 a bondigoo post published onto the pendpost Instagram account. The
// operator approved it with nothing on screen naming the destination: the cards carry a
// platform GLYPH, which says instagram, not WHICH instagram. These tests pin the three
// things that make the strip worth trusting - it names the account, it never invents or
// hides one, and a lane with no account is an ACTION rather than a dead end.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import DestinationStrip, { destinationFor, shortId } from '../ui/DestinationStrip.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
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

// The real shape lib/accounts.mjs returns, with the live bondigoo/pendpost split that
// caused the incident: an Instagram account with a handle, one without.
const withHandle = {
  meta: { igHandle: 'bondigoo', igUserId: '17841479717835003', pageId: '1126781540525407' },
  linkedin: { orgUrn: 'urn:li:organization:110418589' },
  youtube: { channelId: 'UCFnVHisN1YFfk0HlmRsxYtg', handle: '' },
  x: { handle: '21Funkyy' },
};
const noHandle = {
  meta: { igHandle: '', igUserId: '17841479717835003', pageId: '1126781540525407' },
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
  return render(
    <I18nProvider locale="en">
      <TooltipProvider>
        <DestinationStrip {...props} />
      </TooltipProvider>
    </I18nProvider>,
  );
}

describe('destinationFor', () => {
  it('prefers a human handle over the machine id', () => {
    expect(destinationFor('instagram', withHandle)).toEqual({ handle: '@bondigoo', id: '17841479717835003' });
    expect(destinationFor('x', withHandle)).toEqual({ handle: '@21Funkyy', id: null });
  });

  it('falls back to the id when there is no handle, never to nothing', () => {
    expect(destinationFor('instagram', noHandle)).toEqual({ handle: null, id: '17841479717835003' });
    // The urn prefix is machine noise; the org number is the identifying part.
    expect(destinationFor('linkedin', withHandle)).toEqual({ handle: null, id: '110418589' });
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
    expect(screen.getByText('@bondigoo')).toBeInTheDocument();
    expect(screen.getByText('@21Funkyy')).toBeInTheDocument();
  });

  it('names only the lanes in front of the operator', () => {
    renderStrip({ platforms: ['instagram'], accounts: withHandle });
    expect(screen.queryByText('@21Funkyy')).not.toBeInTheDocument();
  });

  it('renders a long id SHORT, with the full value reachable, never as a bare 17-digit number', () => {
    renderStrip({ platforms: ['instagram'], accounts: noHandle });
    expect(screen.queryByText('17841479717835003')).not.toBeInTheDocument();
    // Expanded shows the short id twice: once in the summary line, once as the chip.
    expect(screen.getAllByText(shortId('17841479717835003')).length).toBeGreaterThan(0);
    // The unabbreviated truth is still available.
    expect(screen.getByLabelText(/17841479717835003/)).toBeInTheDocument();
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
    const chip = screen.getByRole('button', { name: /No account is on file for LinkedIn/i });
    await userEvent.click(chip);
    expect(onNavigate).toHaveBeenCalledWith('setup');
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
    expect(trigger).toHaveTextContent('@bondigoo · @21Funkyy');
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
    const chip = screen.getByRole('button', { name: /No account is on file for LinkedIn/i });
    await userEvent.click(chip);
    expect(onNavigate).toHaveBeenCalledWith('setup');
  });
});
