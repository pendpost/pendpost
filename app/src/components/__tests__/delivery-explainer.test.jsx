import { readFileSync } from 'node:fs';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import DeliveryExplainer from '../DeliveryExplainer.jsx';
import { I18nProvider } from '../../lib/i18n.js';

// DeliveryExplainer: a one-time native-vs-live card, shown once per machine and
// remembered across reloads (localStorage), unlike the always-recurring chip.
// A Map-backed localStorage keeps the persistence assertion deterministic across
// renders, independent of the test runner's localStorage backing.
function renderExplainer() {
  return render(
    <I18nProvider locale="en">
      <DeliveryExplainer />
    </I18nProvider>,
  );
}

beforeEach(() => {
  const store = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('DeliveryExplainer', () => {
  it('explains native vs live on first run', () => {
    renderExplainer();
    expect(screen.getByText('Keep publishing, even when your computer is off')).toBeInTheDocument();
    expect(screen.getByText(/your computer has to be on for your posts to go out/)).toBeInTheDocument();
  });

  it('stays dismissed across reloads once acknowledged', async () => {
    const user = userEvent.setup();
    const { unmount } = renderExplainer();
    await user.click(screen.getByText('Got it'));
    expect(screen.queryByText('Keep publishing, even when your computer is off')).not.toBeInTheDocument();
    unmount();
    renderExplainer(); // simulate an app restart / reload
    expect(screen.queryByText('Keep publishing, even when your computer is off')).not.toBeInTheDocument();
  });

  // Release polish 2026-11-01: in the planner List it sat between the Needs-you tray and the
  // posts and pushed every post below the first screen on a 375px phone. It now lives on the
  // 24/7 cloud page only, so its one link is the plans page (an in-app "Set up 24/7 service"
  // would point at the page it already sits on).
  it('is mounted on the 24/7 cloud page only, never in the planner', () => {
    const app = readFileSync(`${process.cwd()}/src/App.jsx`, 'utf8');
    const mounts = app.match(/\{page === '[a-z]+' \? <DeliveryExplainer\b/g) || [];
    expect(mounts).toEqual(["{page === 'cloud' ? <DeliveryExplainer"]);
    expect(app.match(/<DeliveryExplainer\b/g)).toHaveLength(1);
  });

  it('offers the plans link and its dismiss, no in-app set-up jump', () => {
    renderExplainer();
    expect(screen.getByRole('link', { name: /See plans/ })).toHaveAttribute('href', expect.stringContaining('/services'));
    expect(screen.getByRole('button', { name: 'Got it' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Set up/ })).not.toBeInTheDocument();
  });
});
