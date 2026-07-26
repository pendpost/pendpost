import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import SidebarResizer from '../SidebarResizer.jsx';
import { I18nProvider } from '../../lib/i18n.js';
import { clampSidebarWidth, setSidebarWidth, SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN } from '../../lib/format.js';

const KEY = 'pendpost-sidebar-width';

// Node 22 ships an experimental `localStorage` global that shadows jsdom's and, without
// --localstorage-file, exposes NO methods at all - getItem/setItem/clear are all undefined.
// Every localStorage call in the app is wrapped in try/catch, so under vitest they simply
// no-op instead of throwing. That makes the real backend untestable here, so these tests
// install a Map-backed Storage that behaves like the browser's.
function installStorage() {
  const map = new Map();
  const stub = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => { map.clear(); },
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: stub, configurable: true, writable: true });
  Object.defineProperty(window, 'localStorage', { value: stub, configurable: true, writable: true });
  return stub;
}

// The rail width is a display preference with exactly two ways to go wrong: a value
// outside the layout's bounds, and a storage backend that is not there. Both are pure
// enough to pin down here rather than in a browser.
describe('sidebar width preference', () => {
  beforeEach(() => { installStorage(); });

  it('clamps to the layout bounds and rejects garbage', () => {
    expect(clampSidebarWidth(320)).toBe(320);
    expect(clampSidebarWidth(50)).toBe(SIDEBAR_WIDTH_MIN);
    expect(clampSidebarWidth(9999)).toBe(SIDEBAR_WIDTH_MAX);
    // A hand-edited or stale key lays the app out from the default, never from junk.
    expect(clampSidebarWidth('wide')).toBe(SIDEBAR_WIDTH_DEFAULT);
    expect(clampSidebarWidth(null)).toBe(SIDEBAR_WIDTH_DEFAULT);
    expect(clampSidebarWidth(undefined)).toBe(SIDEBAR_WIDTH_DEFAULT);
    // Sub-pixel drag deltas settle on whole pixels.
    expect(clampSidebarWidth(240.6)).toBe(241);
  });
});

function renderResizer() {
  return render(
    <I18nProvider>
      <SidebarResizer />
    </I18nProvider>,
  );
}

describe('SidebarResizer', () => {
  beforeEach(() => {
    installStorage();
    // format.js holds the width in a module singleton, which survives between tests
    // in a file; reset it so each test starts from the shipped width.
    setSidebarWidth(SIDEBAR_WIDTH_DEFAULT);
    document.documentElement.style.removeProperty('--sidebar-w');
  });

  it('exposes the width as a keyboard-operable separator', () => {
    renderResizer();
    const handle = screen.getByRole('separator');
    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    expect(handle).toHaveAttribute('aria-valuemin', String(SIDEBAR_WIDTH_MIN));
    expect(handle).toHaveAttribute('aria-valuemax', String(SIDEBAR_WIDTH_MAX));
    expect(handle).toHaveAttribute('tabindex', '0');
    // Icon-free control, so the accessible name has to come from the label.
    expect(handle).toHaveAccessibleName();
  });

  it('widens and narrows with the arrow keys, and persists', () => {
    renderResizer();
    const handle = screen.getByRole('separator');

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle).toHaveAttribute('aria-valuenow', '256');
    expect(localStorage.getItem(KEY)).toBe('256');
    expect(document.documentElement.style.getPropertyValue('--sidebar-w')).toBe('256px');

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle).toHaveAttribute('aria-valuenow', '240');
  });

  it('stores the default by removing the key', () => {
    renderResizer();
    const handle = screen.getByRole('separator');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(localStorage.getItem(KEY)).toBe('256');
    // Back at the shipped width there is nothing to remember.
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(handle).toHaveAttribute('aria-valuenow', String(SIDEBAR_WIDTH_DEFAULT));
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('resets to the default on double-click', () => {
    renderResizer();
    const handle = screen.getByRole('separator');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.doubleClick(handle);
    expect(handle).toHaveAttribute('aria-valuenow', String(SIDEBAR_WIDTH_DEFAULT));
  });

  it('keeps resizing when localStorage throws', () => {
    const stub = installStorage();
    stub.setItem = () => { throw new Error('QuotaExceededError'); };
    renderResizer();
    const handle = screen.getByRole('separator');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    // The session still resizes; only the persistence is silently lost. No error
    // reaches the user, because a display preference is not worth a dialog.
    expect(handle).toHaveAttribute('aria-valuenow', '256');
    expect(document.documentElement.style.getPropertyValue('--sidebar-w')).toBe('256px');
  });
});
