// Shared accessibility-test runner for component tests.
//
// jest-axe's default `axe` already disables the color-contrast rules in jsdom
// (jsdom can't compute layout or real colors). What it does NOT disable is
// axe-core's asset *preload* step, which still races to load cross-origin
// stylesheets before every run. Under the parallel fork pool that preload
// times out on a loaded machine and the a11y assertions fail intermittently
// with "Preload assets timed out." — see _shouldPreload / _preload in
// axe-core (node_modules/axe-core/axe.js).
//
// Passing `preload: false` short-circuits that step entirely. The only assets
// axe preloads are the CSSOM used by color-contrast, which is already off here,
// so this skips a timeout source without dropping any rule that actually runs
// in jsdom. Use `axeClean(container)` everywhere instead of jest-axe's `axe`.
import { configureAxe } from 'jest-axe';

export const axeClean = configureAxe({ preload: false });
