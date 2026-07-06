import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Vitest config for the dashboard. Component tests run in jsdom; the setup file
// registers @testing-library/jest-dom matchers and jest-axe (toHaveNoViolations).
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.js'],
    include: ['src/**/*.{test,spec}.{js,jsx}'],
    css: false,
    // Files run in parallel forks. The a11y assertions use the shared axeClean()
    // helper (src/test-utils/axe.js), which disables axe-core's asset preload —
    // that preload was the lone source of cross-file flakiness ("Preload assets
    // timed out.") under load, so parallelism is safe. Radix-bearing trees
    // (Tooltip/Popover) are heavy to mount in jsdom, hence the generous timeouts.
    pool: 'forks',
    // Cap fork parallelism. The heaviest suites (full-Composer axe scans,
    // assets-mutate) push a single jsdom worker to ~21s — right at the old 20s
    // budget — and under a full-fan-out run on an 8GB machine, memory contention
    // starved a different file into a timeout on each run. Capping to 4 forks
    // halves peak memory pressure so no worker is starved, and the 60s per-test
    // budget leaves headroom for the slowest Radix trees on a loaded machine.
    poolOptions: {
      forks: {
        maxForks: 4,
        minForks: 1,
      },
    },
    testTimeout: 60000,
    hookTimeout: 60000,
  },
});
