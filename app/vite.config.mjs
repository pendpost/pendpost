import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies API + media to the pendpost server on 8090;
// the production build is served by the pendpost server itself.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5179,
    proxy: {
      '/api': 'http://127.0.0.1:8090',
      '/media': 'http://127.0.0.1:8090',
    },
  },
});
