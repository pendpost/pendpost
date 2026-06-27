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
});
