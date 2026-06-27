// Vitest setup: jest-dom matchers (toBeInTheDocument, etc.) plus jest-axe's
// toHaveNoViolations for the accessibility checks on key screens.
import '@testing-library/jest-dom/vitest';
import { expect, afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import { toHaveNoViolations } from 'jest-axe';

expect.extend(toHaveNoViolations);

// Unmount and clear the jsdom DOM after every test so queries never match
// leftover nodes from a previous test (RTL auto-cleanup is not guaranteed
// under the single-fork pool we use for the Radix-bearing component trees).
afterEach(() => cleanup());

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
