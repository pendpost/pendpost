import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Dev server proxies API + media to the pendpost server on 8090 (the live daemon) by
// default; the production build is served by the pendpost server itself. `npm run dev:live`
// overrides the target via VITE_API_TARGET so the Studio talks to the READ-ONLY dev API on
// its own port instead of the live daemon.
const API_TARGET = process.env.VITE_API_TARGET || 'http://127.0.0.1:8090';
const resolve = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5179,
    proxy: {
      '/api': API_TARGET,
      '/media': API_TARGET,
      '/review': API_TARGET, // dev: proxy the review listener's bundle/media/decision
    },
  },
  build: {
    // The review entry is INLINED into the listener's page shell (HOOK(W6)), so it must
    // be fully self-contained: no modulepreload-polyfill import (which would 404 on the
    // review listener, which serves no /assets). Disabling the polyfill is safe for the
    // SPA too - modern browsers support modulepreload natively; the hint is merely skipped
    // on ancient ones, the app still loads.
    modulePreload: { polyfill: false },
    rollupOptions: {
      // Two HTML entries: the Studio SPA (index.html) and the standalone, dependency-free
      // CLIENT review page (review.html -> src/review/main.js, spec 48 W6). The review
      // entry shares NOTHING with the SPA, so it emits its own self-contained chunk without
      // pulling React or the Studio in. Its output name is STABLE (review/review.js + .css)
      // so the review listener can read the built asset off disk and inline it at HOOK(W6)
      // without parsing a manifest.
      input: {
        main: resolve('./index.html'),
        review: resolve('./review.html'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'review' ? 'review/review.js' : 'assets/[name]-[hash].js'),
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: (asset) => {
          const name = asset.names && asset.names[0];
          return name && /review/.test(name) ? 'review/review[extname]' : 'assets/[name]-[hash][extname]';
        },
      },
    },
  },
});
