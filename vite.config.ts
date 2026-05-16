import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

// Allow serving the SPA under a sub-path (e.g. `netverdict.io/logflow/`).
// `BASE` must start and end with `/` per Vite's contract. Empty defaults
// keep local dev/Docker working at `/` without any env wiring.
const BASE = process.env.VITE_BASE ?? '/';

export default defineConfig({
  root: 'src/ui',
  base: BASE,
  plugins: [preact(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      react: 'preact/compat',
      'react-dom': 'preact/compat'
    }
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000'
    }
  },
  build: {
    outDir: '../../dist/ui',
    emptyOutDir: true
  }
});
