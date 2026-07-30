import { contextBridge, ipcRenderer } from 'electron';

/**
 * Preload for the Mantle UI window.
 *
 * 1. Injects window.__MANTLE_ENV__ with the user-chosen brain origin — the
 *    same object the web client's /env.js route emits
 *    (packages/web-ui/src/runtime-env.ts reads it). contextBridge bindings
 *    are read-only in the main world, and the shell additionally neutralizes
 *    the served /env.js, so this value is authoritative.
 * 2. Exposes window.mantleDesktop — the small desktop API the UI's
 *    DesktopBridge component (client/web/components/desktop) feature-detects:
 *    OS notifications and a dock/taskbar badge.
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

contextBridge.exposeInMainWorld('mantleDesktop', {
  platform: process.platform,
  notify: (payload: { title: string; body?: string }) =>
    ipcRenderer.send('desktop:notify', payload),
  setBadge: (count: number) => ipcRenderer.send('desktop:badge', count),
  // OS-keychain-backed bearer storage (packages/web-ui token-store detects
  // this and stops using localStorage). get() is a sync round-trip to main —
  // sub-millisecond, and always fresh across windows.
  tokenVault: {
    get: (): string | null => {
      const value = ipcRenderer.sendSync('vault:get') as unknown;
      return typeof value === 'string' ? value : null;
    },
    set: (token: string) => ipcRenderer.send('vault:set', token),
    clear: () => ipcRenderer.send('vault:clear'),
  },
});
