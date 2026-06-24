/**
 * The postMessage contract between a running mini app (inside its sandboxed
 * iframe) and the host page. Zero-dependency + client-safe so both the host
 * `AppSandbox` component and the API routes can import it.
 *
 * The iframe-side counterpart is bundled into every app by `@mantle/app-build`
 * (see its `@host` kit module); the two MUST agree on these shapes. Keep this
 * the single source of truth and mirror any change there.
 *
 * Trust model: the iframe has an opaque origin (sandbox without
 * allow-same-origin), so it holds no credentials and cannot call host APIs
 * directly. Its ONLY channel is postMessage to the parent, which re-derives the
 * owner from the session and enforces the per-app allowlist server-side.
 */

export const BRIDGE_VERSION = 1 as const;

/** Requests the app sends UP to the host (await a matching BridgeRes by `id`). */
export type BridgeReq =
  | { v: 1; id: string; kind: 'tool.call'; slug: string; input: unknown }
  | { v: 1; id: string; kind: 'db.query'; sql: string; params?: unknown[] }
  | { v: 1; id: string; kind: 'db.exec'; sql: string; params?: unknown[] };

/** Fire-and-forget lifecycle events the app emits (no response expected). */
export type BridgeEvt =
  | { v: 1; kind: 'ready' }
  | { v: 1; kind: 'resize'; height: number }
  | { v: 1; kind: 'error'; message: string; stack?: string }
  // Inspect mode (host-injected overlay → host): the user locked/cleared a
  // selection (regionId = a data-app-region value, or null when cleared), or
  // exited inspect via Esc (`inspect` with on:false).
  | { v: 1; kind: 'select'; regionId: string | null; label?: string }
  | { v: 1; kind: 'inspect'; on: boolean };

/** Responses the host sends DOWN, correlated to a BridgeReq by `id`. */
export type BridgeRes =
  | { v: 1; id: string; ok: true; output: unknown }
  | { v: 1; id: string; ok: false; error: string };

/** Control messages the host pushes DOWN unprompted: agent region annotations,
 *  and inspect-mode control (toggle select mode; set/clear the locked selection
 *  from the host side, e.g. when the user clears the focus chip). */
export type BridgeCtl =
  | { v: 1; kind: 'annotate'; regions: { id: string; note?: string; severity?: 'info' | 'warn' }[] }
  | { v: 1; kind: 'inspect'; on: boolean }
  | { v: 1; kind: 'select'; regionId: string | null }
  // Live theme: the host's <html> class + data-color-theme, mirrored onto the
  // iframe's <html> so a dark/light or colour-theme switch restyles a RUNNING
  // app (every theme's tokens are already in the linked stylesheet).
  | { v: 1; kind: 'theme'; cls: string; colorTheme: string | null };

export type FromApp = BridgeReq | BridgeEvt;
export type FromHost = BridgeRes | BridgeCtl;

export function isFromApp(m: unknown): m is FromApp {
  return !!m && typeof m === 'object' && (m as { v?: unknown }).v === BRIDGE_VERSION;
}
