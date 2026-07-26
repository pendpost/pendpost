// destination-strip.test.jsx - "which account do these posts go to", stated once.
//
// On 2026-07-25 a bondigoo post published onto the pendpost Instagram account. The
// operator approved it with nothing on screen naming the destination: the cards carry a
// platform GLYPH, which says instagram, not WHICH instagram. These tests pin the three
// things that make the strip worth trusting - it names the account, it never invents or
// hides one, and a lane with no account is an ACTION rather than a dead end.

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import DestinationStrip, { destinationFor, shortId } from '../ui/DestinationStrip.jsx';
import { TooltipProvider } from '../ui/Tooltip.jsx';
import { I18nProvider, makeT } from '../../lib/i18n.js';

const t = makeT('en');

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

function renderStrip(props) {
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
    expect(screen.getByText(shortId('17841479717835003'))).toBeInTheDocument();
    // The unabbreviated truth is still available.
    expect(screen.getByLabelText(/17841479717835003/)).toBeInTheDocument();
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
