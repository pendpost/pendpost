import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies API + media to the pendpost server on 8090 (the live daemon) by
// default; the production build is served by the pendpost server itself. `npm run dev:live`
// overrides the target via VITE_API_TARGET so the Studio talks to the READ-ONLY dev API on
// its own port instead of the live daemon.
const API_TARGET = process.env.VITE_API_TARGET || 'http://127.0.0.1:8090';
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5179,
    proxy: {
      '/api': API_TARGET,
      '/media': API_TARGET,
    },
  },
});
