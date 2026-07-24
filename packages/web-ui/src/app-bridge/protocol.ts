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
  | { v: 1; id: string; kind: 'db.exec'; sql: string; params?: unknown[] }
  // Team-hub surface only: the shell answers from the /api/team/hub payload it
  // already holds (data-down). Rejected with ok:false anywhere else (owner
  // editor, ordinary shares) so hub apps degrade to a local preview.
  | { v: 1; id: string; kind: 'hub.get' };

/** Where a hub app can ask the /team shell to navigate (intent-up: the SHELL
 *  owns chat and the briefing reader; the app can open them, never embed them). */
export type HubNavTarget = 'chat' | { briefing: string } | { app: string };

/** Fire-and-forget lifecycle events the app emits (no response expected). */
export type BridgeEvt =
  | { v: 1; kind: 'ready' }
  | { v: 1; kind: 'resize'; height: number }
  | { v: 1; kind: 'error'; message: string; stack?: string }
  // Inspect mode (host-injected overlay → host): the user locked/cleared a
  // selection (regionId = a data-app-region value, or null when cleared), or
  // exited inspect via Esc (`inspect` with on:false).
  | { v: 1; kind: 'select'; regionId: string | null; label?: string }
  | { v: 1; kind: 'inspect'; on: boolean }
  // Team-hub surface only; ignored anywhere else.
  | { v: 1; kind: 'hub.nav'; target: HubNavTarget };

/** Responses the host sends DOWN, correlated to a BridgeReq by `id`. */
export type BridgeRes =
  { v: 1; id: string; ok: true; output: unknown } | { v: 1; id: string; ok: false; error: string };

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

/** The `hub.get` answer on the /team surface — everything the built-in hub
 *  renders, handed to a designated hub app so it can render the same things its
 *  own way. Mirrors the /api/team/hub response; every field is member-safe by
 *  construction (sections are the owner's team-mode page shares, stats are
 *  whitelisted coarse counts). `memberName` is display-grade — a hub app must
 *  never build permission logic on it. */
export type HubData = {
  /** Brain's site-name pref; null ⇒ the app should fall back to its own label. */
  siteName: string | null;
  /** Signed-in member's display name (null when the contact has none). */
  memberName: string | null;
  version: string;
  sections: {
    token: string;
    title: string;
    icon: string | null;
    summary: string | null;
    updatedAt: string;
    /** Token of the nearest team-shared ANCESTOR page, or null when top-level.
     *  A hub app nests children under their parent; the built-in hub renders
     *  only top-level (null) as cards. Every section is an openable share. */
    parentToken: string | null;
  }[];
  /** Whitelisted coarse per-type node counts (zeros included — the app decides
   *  what to hide). Same shape as the /api/team/hub `counts` field. */
  counts: Record<string, number>;
  /** The owner's OTHER team-shared apps (green published build), as launcher
   *  cards — the designated hub app is excluded. Open one with
   *  `host.hub.openApp(token)`; the shell renders it in the in-hub reader
   *  (same /s/<token> iframe + "back to hub" as a briefing). */
  apps: {
    token: string;
    title: string;
    description: string | null;
    updatedAt: string;
  }[];
};

/** Narrow an unknown `hub.nav` target to a valid one — the shell must not
 *  navigate on a malformed message from a (possibly buggy) app bundle. */
export function isHubNavTarget(t: unknown): t is HubNavTarget {
  if (t === 'chat') return true;
  if (!t || typeof t !== 'object') return false;
  const briefing = (t as { briefing?: unknown }).briefing;
  if (typeof briefing === 'string' && briefing.length > 0) return true;
  const app = (t as { app?: unknown }).app;
  return typeof app === 'string' && app.length > 0;
}
