import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          // Two preloads: `connect` for the shell's own connect screen (IPC
          // surface), `app` for the Mantle UI window (__MANTLE_ENV__ injection).
          connect: resolve(__dirname, 'src/preload/connect.ts'),
          app: resolve(__dirname, 'src/preload/app.ts'),
        },
      },
    },
  },
  renderer: {
    // The renderer electron-vite builds is ONLY the connect screen. The Mantle
    // owner UI is loaded from a URL (Phase 0: the client/web dev server;
    // Phase 1: the embedded standalone build).
    root: resolve(__dirname, 'src/renderer'),
    build: {
      rollupOptions: { input: resolve(__dirname, 'src/renderer/index.html') },
    },
  },
});
