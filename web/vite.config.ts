import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Proxies /api to the local wrangler dev server on 8787, so `npm run dev:web`
// gives you a normal Vite dev loop while the Worker runs separately.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
