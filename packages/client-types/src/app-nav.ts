/**
 * App navigation: how the owner organises their mini apps in the sidebar.
 *
 * Two halves with different owners:
 *
 * - The LAYOUT (`AppNav`: folders, nesting, order) is BRAIN-level. It is one
 *   shared record on the anchor row (see BRAIN_PREFERENCE_KEYS), so every admin
 *   and every client (web, desktop, phone) renders the same tree.
 * - PINS and OPEN COUNTS are per-login: what one person keeps at hand and what
 *   they actually use.
 *
 * App icon and colour live on the app itself (`AppRow.icon` / `AppRow.color`),
 * not here, so every surface that lists an app shows the same face.
 *
 * Pure (no React, no runtime deps) so the server, the web client and any other
 * client can share the types and the limits.
 */

/**
 * Named tints for app and folder tiles. We store the KEY, never a colour: each
 * theme defines its own `--app-tint-<key>` / `--app-tint-<key>-ink` pair, so a
 * tile stays legible on every generated theme and in both modes.
 */
export const APP_TINTS = [
  'slate',
  'red',
  'orange',
  'amber',
  'lime',
  'green',
  'teal',
  'sky',
  'blue',
  'indigo',
  'violet',
  'pink',
] as const;
export type AppTint = (typeof APP_TINTS)[number];

export function isAppTint(v: unknown): v is AppTint {
  return typeof v === 'string' && (APP_TINTS as readonly string[]).includes(v);
}

/**
 * An app or folder icon is either an emoji (the historical form, up to 16
 * UTF-16 units so flags and ZWJ sequences fit) or `lucide:<name>` naming an
 * icon from the client's curated set. The server checks the SHAPE only; a
 * client that doesn't know a lucide name falls back to its default tile.
 */
export const LUCIDE_ICON_PREFIX = 'lucide:';
export const APP_ICON_EMOJI_MAX = 16;
export const APP_ICON_MAX = 48;

/** Folders nest at most this deep: folder › subfolder › sub-subfolder. */
export const APP_NAV_MAX_DEPTH = 3;
/** Across the whole tree. Generous; it bounds the stored jsonb, not taste. */
export const APP_NAV_MAX_FOLDERS = 200;
export const APP_NAV_FOLDER_NAME_MAX = 60;
/** Personal pins shown above the tree. */
export const APP_PINS_MAX = 12;
/** Personal sidebar favourites (nav hrefs). */
export const NAV_FAVORITES_MAX = 40;
export const NAV_FAVORITE_HREF_MAX = 200;
/** Per-login open counters kept; the least recently opened fall off. */
export const APP_OPENS_MAX = 300;

export type AppNavApp = { kind: 'app'; id: string };

export type AppNavFolder = {
  kind: 'folder';
  /** Client-generated UUID, stable across renames and moves. */
  id: string;
  name: string;
  icon?: string;
  color?: AppTint;
  children: AppNavEntry[];
};

export type AppNavEntry = AppNavApp | AppNavFolder;

/**
 * The shared layout. `entries` is the root level in display order; each folder
 * carries its own ordered children, so order and nesting are one structure and
 * a dangling parent or a cycle can't be expressed.
 *
 * An app that appears nowhere in the tree is UNSORTED: clients list those after
 * the tree (newest first), which is where a freshly created app lands.
 *
 * `rev` increments on every save. A save names the rev it was based on and is
 * refused (409) when another client saved first, so two devices can't silently
 * overwrite each other's reorganisation.
 */
export type AppNav = { rev: number; entries: AppNavEntry[] };

export const EMPTY_APP_NAV: AppNav = { rev: 0, entries: [] };

/** One login's use of one app: open count and last-opened ISO instant. */
export type AppOpenStat = { n: number; at: string };

/** Slim app row for navigation surfaces: everything the tree needs to render
 *  and search, nothing it doesn't. */
export type AppNavItem = {
  id: string;
  title: string;
  icon: string | null;
  color: AppTint | null;
  tags: string[];
  description: string | null;
  hasBuild: boolean;
  updatedAt: string;
};

/** GET /api/app-nav — the whole sidebar in one round-trip. `nav` is already
 *  pruned to apps that still exist, and `pins` likewise. */
export type AppNavResponse = {
  nav: AppNav;
  pins: string[];
  opens: Record<string, AppOpenStat>;
  apps: AppNavItem[];
};
