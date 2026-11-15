import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The NestJS app serves the built dashboard (front/dist) on the same origin as /api, under a strict
// CSP (script-src / style-src 'self'): the build must emit only external script and style files.
// In development, `npm run dev` serves on :5173 and proxies the API to the app on :3000, so the
// session cookie stays same-origin.
const API = process.env.COINS_API_URL ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // No inlined data: URIs for assets (the CSP allows data: for images only).
    assetsInlineLimit: 0,
    sourcemap: false,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: API, changeOrigin: false },
      '/healthz': { target: API, changeOrigin: false },
    },
  },
});
