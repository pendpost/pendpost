import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ConnectionStatus from '../ConnectionStatus.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import { TooltipProvider } from '../ui/Tooltip.jsx';

// ConnectionStatus replaces the dismissible SchedulerChip with a persistent, merged
// delivery + always-on control. We mock the cloud bridge so each merged state renders
// without the network: useCloud's value + the `running` prop pick the status line and
// icon, and the click-popover carries the two CTAs (external plans link + the in-app
// set-up/manage action). The status string also seeds the hover tooltip, so status
// assertions use getAllByText (the popover copy is the one that always renders).
let cloudState;
let subState;
let clientsState;
let capsState;
vi.mock('../../lib/cloud.js', () => ({
  useCloud: () => cloudState,
  useCloudClients: () => clientsState,
  useCloudSubscription: () => subState,
  useCapabilities: () => capsState,
}));

function renderStatus(props) {
  return render(
    <I18nProvider locale="en">
      <TooltipProvider>
        <ConnectionStatus {...props} />
      </TooltipProvider>
    </I18nProvider>,
  );
}

const trigger = () => screen.getByRole('button', { name: 'Delivery and 24/7 status' });

beforeEach(() => {
  cloudState = { data: undefined, isLoading: true };
  subState = { data: undefined };
  clientsState = { data: { clients: [] } };
  capsState = { data: { cloudLanes: ['meta', 'linkedin', 'x'], nativeLanes: ['youtube', 'mastodon', 'wordpress', 'ghost'], localOnlyLanes: ['reddit', 'tiktok'] } };
});

describe('ConnectionStatus', () => {
  it('renders a persistent, non-dismissible trigger (no dismiss control)', () => {
    renderStatus({ running: true });
    expect(trigger()).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /dismiss|ausblenden/i })).not.toBeInTheDocument();
  });

  it('local running: popover names the keep-open status and the external plans link', async () => {
    const user = userEvent.setup();
    cloudState = { data: { workspaceId: '', enabled: false }, isLoading: false };
    renderStatus({ running: true });
    await user.click(trigger());
    expect(screen.getAllByText('Publishing while pendpost is open').length).toBeGreaterThan(0);
    const plans = await screen.findByRole('link', { name: /view plans and pricing/i });
    // Links at the live /services page; ?from=app flips its managed CTA to "enable always-on".
    expect(plans).toHaveAttribute('href', 'https://pendpost.com/services?from=app');
    expect(plans).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('button', { name: 'Set up 24/7 service' })).toBeInTheDocument();
    // The disconnected upsell carries an inline price summary (less friction).
    expect(screen.getByText('Self-hosting: free forever.')).toBeInTheDocument();
    expect(screen.getByText(/plans include a pooled monthly post allowance/)).toBeInTheDocument();
  });

  it('cloud connected + keyed + enabled: shows the always-on status and a Manage cloud CTA', async () => {
    const user = userEvent.setup();
    // Operational = workspaceId AND the api key present AND the ACTIVE brand always-on
    // (the glyph follows the selected client, not the install).
    cloudState = { data: { workspaceId: 'ws_1', enabled: true, apiKey: { present: true } }, isLoading: false };
    clientsState = { data: { clients: [{ clientId: 'acme', active: true, alwaysOn: true }] } };
    renderStatus({ running: false });
    await user.click(trigger());
    expect(screen.getAllByText('Publishing around the clock through the cloud').length).toBeGreaterThan(0);
    expect(await screen.findByRole('button', { name: 'Manage cloud' })).toBeInTheDocument();
    // Connected: the inline price upsell is replaced by the live usage line, not shown.
    expect(screen.queryByText('Self-hosting: free forever.')).not.toBeInTheDocument();
  });

  it('cloud connected but KEYLESS (api key missing): not shown as cloud-on; falls back to local', async () => {
    // The keyless half-state: a workspace is connected but PENDPOST_CLOUD_API_KEY is absent,
    // so the cloud cannot publish - the same condition Cloud.jsx treats as "finish setup".
    // The header must NOT claim "publishing through the cloud"; the local scheduler is the
    // real firer, so it shows the local status instead (mirrors Cloud.jsx's connected gate:
    // workspaceId AND apiKey.present).
    const user = userEvent.setup();
    cloudState = { data: { workspaceId: 'ws_1', enabled: true, apiKey: { present: false } }, isLoading: false };
    renderStatus({ running: true });
    await user.click(trigger());
    expect(screen.queryByText('Publishing around the clock through the cloud')).not.toBeInTheDocument();
    expect(screen.getAllByText('Publishing while pendpost is open').length).toBeGreaterThan(0);
  });

  it('scheduler off, no cloud: shows the paused status', async () => {
    const user = userEvent.setup();
    cloudState = { data: { workspaceId: '', enabled: false }, isLoading: false };
    renderStatus({ running: false });
    await user.click(trigger());
    expect(screen.getAllByText('Paused until pendpost is open').length).toBeGreaterThan(0);
  });

  it('the set-up CTA routes to the in-app cloud page', async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    cloudState = { data: { workspaceId: '', enabled: false }, isLoading: false };
    renderStatus({ running: true, onNavigate });
    await user.click(trigger());
    await user.click(await screen.findByRole('button', { name: 'Set up 24/7 service' }));
    expect(onNavigate).toHaveBeenCalledWith('cloud');
  });
});
