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
    testTimeout: 20000,
    hookTimeout: 20000,
  },
});
