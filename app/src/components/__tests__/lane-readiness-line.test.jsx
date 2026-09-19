import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import LaneReadinessLine, { SETUP_LANE, BLUESKY_ENV_VAR } from '../radar/LaneReadinessLine.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// LaneReadinessLine is the ONE presentational unit for a reply lane's state + its single
// recovering action, shared by the Radar automation strip and the autonomy ledger so both
// tell the same truth in the same words. This suite locks the reason -> line + action mapping
// (the mapping that used to live only in the ledger's PlatformRow) and the two Radar-only
// extras: copy-only capability truth and the bluesky env-only not-connected line.

const engageProbeMock = vi.fn(() => Promise.resolve({ ok: true, usable: true }));
const engageConfirmHandleMock = vi.fn(() => Promise.resolve({ ok: true }));
const resumeLaneMock = vi.fn(() => Promise.resolve({ ok: true }));

vi.mock('../../lib/api.js', () => ({
  engageProbe: (...a) => engageProbeMock(...a),
  engageConfirmHandle: (...a) => engageConfirmHandleMock(...a),
  resumeLane: (...a) => resumeLaneMock(...a),
  errText: (e, t, fallback) => (e && e.message) || (t ? t(fallback) : 'error'),
}));

function renderLine(props) {
  return render(
    <I18nProvider>
      <LaneReadinessLine label="Mastodon" clientName="Acme" onNavigate={props?.onNavigate} onRefresh={props?.onRefresh} {...props} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  engageProbeMock.mockClear();
  engageConfirmHandleMock.mockClear();
  resumeLaneMock.mockClear();
});

describe('LaneReadinessLine: reason -> line + one action', () => {
  it('ready: says Ready, offers no control', () => {
    renderLine({ lane: 'mastodon', runtime: { reason: 'ready', usable: true } });
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('never probed (checking, no lastProbeAt): "Not checked yet" + a Check now that probes', async () => {
    const onRefresh = vi.fn();
    renderLine({ lane: 'mastodon', runtime: { reason: 'checking' }, onRefresh });
    expect(screen.getByText('Not checked yet')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(engageProbeMock).toHaveBeenCalledWith('mastodon');
  });

  it('no_credential on a Setup-card lane: one Connect that deep-links to Setup', async () => {
    const onNavigate = vi.fn();
    renderLine({ lane: 'reddit', label: 'Reddit', runtime: { reason: 'no_credential' }, onNavigate });
    expect(screen.getByText('Not connected')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Connect' }));
    expect(onNavigate).toHaveBeenCalledWith('setup', SETUP_LANE.reddit);
  });

  it('no_credential on bluesky (no Setup card): names the env var, never a dead Connect', () => {
    renderLine({ lane: 'bluesky', label: 'Bluesky', runtime: { reason: 'no_credential' } });
    expect(screen.getByText('Not connected')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
    expect(screen.getByText(new RegExp(BLUESKY_ENV_VAR))).toBeInTheDocument();
  });

  it('not_logged_in: names the platform + Check again probes', async () => {
    renderLine({ lane: 'linkedin', label: 'LinkedIn', runtime: { reason: 'not_logged_in' } });
    expect(screen.getByText(/Not logged in/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(engageProbeMock).toHaveBeenCalledWith('linkedin');
  });

  it('wrong_account: names who is logged in + Check again', () => {
    renderLine({ lane: 'x', label: 'X', runtime: { reason: 'wrong_account', handleSeen: 'someoneelse' } });
    expect(screen.getByText(/someoneelse/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeInTheDocument();
  });

  it('confirm_handle: the handle question with Yes/No that write the confirm', async () => {
    renderLine({ lane: 'x', label: 'X', runtime: { reason: 'confirm_handle', handleSeen: 'acme' } });
    expect(screen.getByText(/@acme/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Yes' }));
    expect(engageConfirmHandleMock).toHaveBeenCalledWith('x', true);
  });

  it('cooling_down: names the window + Resume now', async () => {
    renderLine({ lane: 'reddit', label: 'Reddit', runtime: { reason: 'cooling_down', pausedUntil: '2026-09-16T20:00:00.000Z', pauseReason: 'platform_limit' } });
    expect(screen.getByText(/Cooling down/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Resume now' }));
    expect(resumeLaneMock).toHaveBeenCalledWith('reddit');
  });

  it('copyOnly: says draft-only, offers no arm action (capability truth)', () => {
    renderLine({ lane: 'x', label: 'X', copyOnly: true, runtime: { reason: 'ready' } });
    expect(screen.getByText('Draft only, no auto-reply here')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
