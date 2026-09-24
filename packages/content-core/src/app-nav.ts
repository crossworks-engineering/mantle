/**
 * @mantle/content-core · app nav
 *
 * Pure logic for the shared app-navigation tree (types and limits in
 * @mantle/client-types/app-nav): the read projection, the strict write check,
 * pruning, and the tree operations a client needs to render and reorganise it.
 *
 * The server and every client use the same functions, so a move the sidebar
 * allows is a move the server accepts, and a depth the server rejects is one
 * the sidebar never offers.
 *
 * Zero runtime dependencies (the content-core rule): client-types is imported
 * for its constants, which are themselves dependency-free.
 */

import {
  APP_ICON_EMOJI_MAX,
  APP_ICON_MAX,
  APP_NAV_FOLDER_NAME_MAX,
  APP_NAV_MAX_DEPTH,
  APP_NAV_MAX_FOLDERS,
  LUCIDE_ICON_PREFIX,
  isAppTint,
  type AppNav,
  type AppNavEntry,
  type AppNavFolder,
  type AppTint,
} from '@mantle/client-types/app-nav';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LUCIDE_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function asId(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const id = raw.trim().toLowerCase();
  return UUID_RE.test(id) ? id : undefined;
}

/** An app or folder icon: an emoji, or `lucide:<kebab-name>`. Anything else
 *  (including an empty string) projects to undefined, i.e. the default tile. */
export function projectAppIcon(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim();
  if (!v || v.length > APP_ICON_MAX) return undefined;
  if (v.startsWith(LUCIDE_ICON_PREFIX)) {
    return LUCIDE_NAME_RE.test(v.slice(LUCIDE_ICON_PREFIX.length)) ? v : undefined;
  }
  // Emoji path: short, and no ASCII letters/digits, so a mistyped lucide name
  // ("chart-bar") can't masquerade as an emoji and render as literal text.
  if (v.length > APP_ICON_EMOJI_MAX || /[A-Za-z0-9]/.test(v)) return undefined;
  return v;
}

export function projectAppTint(raw: unknown): AppTint | undefined {
  return isAppTint(raw) ? raw : undefined;
}

function folderName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const name = raw.trim().replace(/\s+/g, ' ').slice(0, APP_NAV_FOLDER_NAME_MAX);
  return name || undefined;
}

// ── Read projection (tolerant) ───────────────────────────────────────────────

/**
 * Project a stored `appNav` value. Tolerant by design, because jsonb can hold
 * anything an older build or a hand edit put there: bad entries are dropped,
 * a repeated id keeps its first position, and a folder deeper than
 * APP_NAV_MAX_DEPTH is dissolved with its contents lifted into its parent, so
 * no app is lost to a bad folder. Undefined for unset or garbage.
 */
export function projectAppNav(raw: unknown): AppNav | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as { rev?: unknown; entries?: unknown };
  if (!Array.isArray(r.entries)) return undefined;
  const rev = typeof r.rev === 'number' && Number.isInteger(r.rev) && r.rev >= 0 ? r.rev : 0;
  const seen = new Set<string>();
  let folders = 0;

  const walk = (list: unknown[], depth: number): AppNavEntry[] => {
    const out: AppNavEntry[] = [];
    for (const item of list) {
      if (typeof item !== 'object' || item === null) continue;
      const e = item as Record<string, unknown>;
      const id = asId(e.id);
      if (!id || seen.has(id)) continue;
      if (e.kind === 'app') {
        seen.add(id);
        out.push({ kind: 'app', id });
        continue;
      }
      if (e.kind !== 'folder') continue;
      const kids = Array.isArray(e.children) ? e.children : [];
      const name = folderName(e.name);
      if (!name || depth >= APP_NAV_MAX_DEPTH || folders >= APP_NAV_MAX_FOLDERS) {
        // Dissolve: keep what it held, one level up.
        out.push(...walk(kids, depth));
        continue;
      }
      seen.add(id);
      folders++;
      const folder: AppNavFolder = { kind: 'folder', id, name, children: [] };
      const icon = projectAppIcon(e.icon);
      if (icon) folder.icon = icon;
      const color = projectAppTint(e.color);
      if (color) folder.color = color;
      folder.children = walk(kids, depth + 1);
      out.push(folder);
    }
    return out;
  };

  return { rev, entries: walk(r.entries, 0) };
}

// ── Write check (strict) ─────────────────────────────────────────────────────

/**
 * Why a proposed `entries` tree can't be saved, or null when it can. Strict,
 * unlike the projection: a client sending a bad tree has a bug, and silently
 * reshaping its save would hide it. Returns the first problem found.
 */
export function appNavIssue(entries: unknown): string | null {
  if (!Array.isArray(entries)) return 'entries must be an array';
  const seen = new Set<string>();
  let folders = 0;

  const check = (list: unknown[], depth: number): string | null => {
    for (const item of list) {
      if (typeof item !== 'object' || item === null) return 'every entry must be an object';
      const e = item as Record<string, unknown>;
      const id = asId(e.id);
      if (!id) return `'${String(e.id)}' is not a valid id (expected a UUID)`;
      if (seen.has(id)) return `'${id}' appears more than once`;
      seen.add(id);
      if (e.kind === 'app') continue;
      if (e.kind !== 'folder') return `entry '${id}' has an unknown kind`;
      if (depth >= APP_NAV_MAX_DEPTH) {
        return `folders nest at most ${APP_NAV_MAX_DEPTH} levels deep`;
      }
      if (++folders > APP_NAV_MAX_FOLDERS) return `at most ${APP_NAV_MAX_FOLDERS} folders`;
      if (!folderName(e.name)) return `folder '${id}' needs a name`;
      if (e.icon != null && e.icon !== '' && !projectAppIcon(e.icon)) {
        return `folder '${id}' has an invalid icon`;
      }
      if (e.color != null && !isAppTint(e.color)) return `folder '${id}' has an unknown colour`;
      if (!Array.isArray(e.children)) return `folder '${id}' needs a children array`;
      const inner = check(e.children, depth + 1);
      if (inner) return inner;
    }
    return null;
  };

  return check(entries, 0);
}

// ── Tree operations ──────────────────────────────────────────────────────────

/** Every app id placed in the tree, in display order. */
export function appNavAppIds(entries: readonly AppNavEntry[]): string[] {
  const out: string[] = [];
  const walk = (list: readonly AppNavEntry[]) => {
    for (const e of list) {
      if (e.kind === 'app') out.push(e.id);
      else walk(e.children);
    }
  };
  walk(entries);
  return out;
}

/** Drop app entries whose id fails `keep` (deleted apps). Folders stay, even
 *  when emptied: an empty folder is something the owner made on purpose. */
export function pruneAppNav(
  entries: readonly AppNavEntry[],
  keep: (appId: string) => boolean,
): AppNavEntry[] {
  const out: AppNavEntry[] = [];
  for (const e of entries) {
    if (e.kind === 'app') {
      if (keep(e.id)) out.push(e);
    } else {
      out.push({ ...e, children: pruneAppNav(e.children, keep) });
    }
  }
  return out;
}

export type AppNavLocation = {
  entry: AppNavEntry;
  /** Containing folder id, null at the root. */
  parentId: string | null;
  index: number;
  /** 0 at the root. A folder at depth d is nested d+1 levels deep. */
  depth: number;
};

export function findAppNavEntry(
  entries: readonly AppNavEntry[],
  id: string,
): AppNavLocation | null {
  const walk = (
    list: readonly AppNavEntry[],
    parentId: string | null,
    depth: number,
  ): AppNavLocation | null => {
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      if (e.id === id) return { entry: e, parentId, index: i, depth };
      if (e.kind === 'folder') {
        const hit = walk(e.children, e.id, depth + 1);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(entries, null, 0);
}

/** How many folder levels an entry occupies: 0 for an app, 1 for a folder of
 *  apps, 2 for a folder holding a folder, and so on. */
export function appNavFolderHeight(entry: AppNavEntry): number {
  if (entry.kind === 'app') return 0;
  let inner = 0;
  for (const c of entry.children) inner = Math.max(inner, appNavFolderHeight(c));
  return 1 + inner;
}

/**
 * Whether `id` may move into folder `toParentId` (null = the root): the target
 * must exist, must not be the entry itself or inside it, and the entry's folder
 * height must still fit under APP_NAV_MAX_DEPTH once it lands there.
 */
export function canMoveAppNavEntry(
  entries: readonly AppNavEntry[],
  id: string,
  toParentId: string | null,
): boolean {
  const from = findAppNavEntry(entries, id);
  if (!from) return false;
  let targetDepth = 0; // depth the entry will sit at
  if (toParentId !== null) {
    const target = findAppNavEntry(entries, toParentId);
    if (!target || target.entry.kind !== 'folder') return false;
    if (toParentId === id) return false;
    if (from.entry.kind === 'folder' && findAppNavEntry(from.entry.children, toParentId)) {
      return false;
    }
    targetDepth = target.depth + 1;
  }
  return targetDepth + appNavFolderHeight(from.entry) <= APP_NAV_MAX_DEPTH;
}

function removeAt(
  list: readonly AppNavEntry[],
  id: string,
): { list: AppNavEntry[]; removed: AppNavEntry | null } {
  let removed: AppNavEntry | null = null;
  const out: AppNavEntry[] = [];
  for (const e of list) {
    if (e.id === id) {
      removed = e;
      continue;
    }
    if (e.kind === 'folder' && !removed) {
      const inner = removeAt(e.children, id);
      if (inner.removed) {
        removed = inner.removed;
        out.push({ ...e, children: inner.list });
        continue;
      }
    }
    out.push(e);
  }
  return { list: out, removed };
}

function insertAt(
  list: readonly AppNavEntry[],
  parentId: string | null,
  index: number,
  entry: AppNavEntry,
): AppNavEntry[] {
  if (parentId === null) {
    const out = [...list];
    out.splice(Math.max(0, Math.min(index, out.length)), 0, entry);
    return out;
  }
  return list.map((e) =>
    e.kind === 'folder'
      ? e.id === parentId
        ? { ...e, children: insertAt(e.children, null, index, entry) }
        : { ...e, children: insertAt(e.children, parentId, index, entry) }
      : e,
  );
}

/**
 * Move an entry (app or folder) to `index` within `toParentId` (null = root),
 * where `index` counts positions in the target list AFTER the entry has been
 * taken out of its old place. Returns the new tree, or null when the move is
 * illegal (see canMoveAppNavEntry). The input is never mutated.
 */
export function moveAppNavEntry(
  entries: readonly AppNavEntry[],
  id: string,
  toParentId: string | null,
  index: number,
): AppNavEntry[] | null {
  if (!canMoveAppNavEntry(entries, id, toParentId)) return null;
  const { list, removed } = removeAt(entries, id);
  if (!removed) return null;
  return insertAt(list, toParentId, index, removed);
}

/**
 * Place an app that isn't in the tree yet (an unsorted app). Returns null when
 * it is already placed or the target folder doesn't exist.
 */
export function placeAppNavApp(
  entries: readonly AppNavEntry[],
  appId: string,
  toParentId: string | null,
  index: number,
): AppNavEntry[] | null {
  if (findAppNavEntry(entries, appId)) return null;
  if (toParentId !== null) {
    const target = findAppNavEntry(entries, toParentId);
    if (!target || target.entry.kind !== 'folder') return null;
  }
  return insertAt(entries, toParentId, index, { kind: 'app', id: appId });
}

/**
 * Delete a folder without deleting what it holds: its children take its place
 * in the parent, in order. Lifting children one level up can never break the
 * depth limit. Null when `folderId` isn't a folder.
 */
export function dissolveAppNavFolder(
  entries: readonly AppNavEntry[],
  folderId: string,
): AppNavEntry[] | null {
  const hit = findAppNavEntry(entries, folderId);
  if (!hit || hit.entry.kind !== 'folder') return null;
  const kids = hit.entry.children;
  const splice = (list: readonly AppNavEntry[]): AppNavEntry[] => {
    const out: AppNavEntry[] = [];
    for (const e of list) {
      if (e.id === folderId) out.push(...kids);
      else if (e.kind === 'folder') out.push({ ...e, children: splice(e.children) });
      else out.push(e);
    }
    return out;
  };
  return splice(entries);
}

/** Shallow-update one folder's name/icon/colour. Null when not a folder. */
export function updateAppNavFolder(
  entries: readonly AppNavEntry[],
  folderId: string,
  patch: { name?: string; icon?: string | null; color?: AppTint | null },
): AppNavEntry[] | null {
  if (findAppNavEntry(entries, folderId)?.entry.kind !== 'folder') return null;
  const apply = (list: readonly AppNavEntry[]): AppNavEntry[] =>
    list.map((e) => {
      if (e.kind !== 'folder') return e;
      if (e.id !== folderId) return { ...e, children: apply(e.children) };
      const next: AppNavFolder = { ...e };
      if (patch.name !== undefined) next.name = folderName(patch.name) ?? e.name;
      if (patch.icon !== undefined) {
        const icon = projectAppIcon(patch.icon);
        if (icon) next.icon = icon;
        else delete next.icon;
      }
      if (patch.color !== undefined) {
        if (patch.color && isAppTint(patch.color)) next.color = patch.color;
        else delete next.color;
      }
      return next;
    });
  return apply(entries);
}

/** One visible row of the rendered tree. */
export type AppNavRow = {
  entry: AppNavEntry;
  depth: number;
  parentId: string | null;
  /** Last child of its parent: draws └ instead of ├. */
  isLast: boolean;
  /**
   * For each ancestor level 0..depth-1, whether that ancestor was the last
   * child of ITS parent. A level whose ancestor was last draws no continuing
   * vertical guide (the └ already closed it); any other level draws │.
   */
  guides: boolean[];
};

/**
 * Flatten the tree into display rows, descending only into folders `isOpen`
 * reports as expanded. Carries what the dotted guide lines need, so the
 * renderer doesn't have to walk the tree itself.
 */
export function flattenAppNav(
  entries: readonly AppNavEntry[],
  isOpen: (folderId: string) => boolean,
): AppNavRow[] {
  const rows: AppNavRow[] = [];
  const walk = (
    list: readonly AppNavEntry[],
    depth: number,
    parentId: string | null,
    guides: boolean[],
  ) => {
    list.forEach((entry, i) => {
      const isLast = i === list.length - 1;
      rows.push({ entry, depth, parentId, isLast, guides });
      if (entry.kind === 'folder' && isOpen(entry.id)) {
        walk(entry.children, depth + 1, entry.id, [...guides, isLast]);
      }
    });
  };
  walk(entries, 0, null, []);
  return rows;
}
