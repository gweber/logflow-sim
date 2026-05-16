import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';

/**
 * Bundle the browser extension.
 *
 * Outputs three flat JS bundles (popup, content-script, background) plus
 * the manifest and HTML into `dist-extension/`. The user `cd`s into that
 * directory and loads it as an unpacked extension in Chrome / Firefox.
 *
 * The extension shares the same `src/core/` as the SPA — so every parser,
 * simulator, analyzer, and converter improvement lands in the extension
 * automatically without code duplication.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  publicDir: 'public',
  build: {
    outDir: '../dist-extension',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: resolve(fileURLToPath(new URL('.', import.meta.url)), 'popup.html'),
        'content-script': resolve(
          fileURLToPath(new URL('.', import.meta.url)),
          'src/content-script.ts'
        ),
        background: resolve(fileURLToPath(new URL('.', import.meta.url)), 'src/background.ts')
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
        format: 'es'
      }
    },
    target: 'chrome111'
  },
  resolve: {
    alias: {
      '@core': fileURLToPath(new URL('../src/core', import.meta.url))
    }
  }
});
