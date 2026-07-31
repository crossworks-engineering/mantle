/**
 * The Mantle Desktop shell's injected API — `window.mantleDesktop`, exposed
 * by the shell's preload (client/desktop). Feature-detect via
 * `desktopShell()`: a browser returns null and every caller falls back to
 * plain web behavior. This module is the single owner of the global
 * declaration so client code and the shell agree on one shape.
 */
export type DesktopShellApi = {
  platform: string;
  notify(payload: { title: string; body?: string }): void;
  setBadge(count: number): void;
  /** OS-keychain-backed bearer storage (Electron safeStorage). Optional:
   *  older shells predate it, and callers must fall back to localStorage. */
  tokenVault?: {
    get(): string | null;
    set(token: string): void;
    clear(): void;
  };
};

declare global {
  interface Window {
    mantleDesktop?: DesktopShellApi;
  }
}

export function desktopShell(): DesktopShellApi | null {
  return typeof window === 'undefined' ? null : (window.mantleDesktop ?? null);
}
