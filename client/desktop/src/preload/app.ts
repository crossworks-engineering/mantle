import { contextBridge } from 'electron';

/**
 * Preload for the Mantle UI window. Injects window.__MANTLE_ENV__ with the
 * user-chosen brain origin — the same object the web client's /env.js route
 * emits (packages/web-ui/src/runtime-env.ts reads it). contextBridge bindings
 * are read-only in the main world, and the shell additionally neutralizes the
 * dev server's /env.js, so this value is authoritative.
 */
const flag = '--mantle-env=';
const arg = process.argv.find((a) => a.startsWith(flag));
if (arg) {
  try {
    contextBridge.exposeInMainWorld('__MANTLE_ENV__', JSON.parse(arg.slice(flag.length)));
  } catch {
    // Malformed env argument: fall through — the UI degrades to same-origin
    // behavior, which fails visibly rather than silently pointing elsewhere.
  }
}
