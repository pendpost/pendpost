// Vitest setup: jest-dom matchers (toBeInTheDocument, etc.) plus jest-axe's
// toHaveNoViolations for the accessibility checks on key screens.
import '@testing-library/jest-dom/vitest';
import { expect, afterEach, beforeEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { toHaveNoViolations } from 'jest-axe';
import { recheckTiming } from './src/lib/useRecheck.js';

expect.extend(toHaveNoViolations);

// The recheck buttons hold their spinner for a minimum time (lib/useRecheck.js) so a fast answer
// is still seen. Suites that do not test that minimum run without it; the ones that do set it.
beforeEach(() => { recheckTiming.minBusyMs = 0; });

// Unmount and clear the jsdom DOM after every test so queries never match
// leftover nodes from a previous test (RTL auto-cleanup is not guaranteed
// under the single-fork pool we use for the Radix-bearing component trees).
afterEach(() => {
  cleanup();
  // Components persist UI prefs (e.g. Radar's `pendpost.radar.sort`) in Web Storage.
  // On Node 20/22 jsdom's storage works, so one test's choice leaked into the next;
  // on Node 25 the experimental global shadows it with a method-less object and every
  // write is dropped, which hid the leak. Clearing after each test makes both behave
  // the same: no test inherits another's storage.
  for (const store of [globalThis.localStorage, globalThis.sessionStorage]) {
    if (typeof store?.clear === 'function') store.clear();
  }
});

// jsdom ships neither ResizeObserver nor Element.scrollIntoView, both of which
// Radix's Popper (used by Tip/Popover) calls when a floating surface mounts.
// Polyfill them so tooltip/popover-bearing components render in tests.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
