/**
 * App navigation, server side: the shared layout, per-login pins and open
 * counts, and the one read the sidebar makes (`loadAppNavView`).
 *
 * Where each half lives (see @mantle/client-types/app-nav for the why):
 *   profiles(anchor).preferences.appNav   the shared tree, rev-checked
 *   profiles(actor).preferences.appPins   one login's pins
 *   profiles(actor).preferences.appOpens  one login's open counters
 *
 * No SQL against the preferences column here: the rev-checked layout save and
 * the atomic open counter are the generic `savePreferenceIfRev` and
 * `bumpPreferenceCounter` in profile-preferences.ts.
 *
 * Every write NOTIFYs `app_nav_changed` with the anchor owner id, so each open
 * client refetches the tree (realtime type 'app-nav'), on every device.
 */
import { and, desc, eq, sql } from 'drizzle-orm';
import { apps, db, nodes } from '@mantle/db';
import type { AppNav, AppNavEntry, AppNavItem, AppNavResponse } from '@mantle/client-types';
import { EMPTY_APP_NAV } from '@mantle/client-types/app-nav';
import {
  appNavIssue,
  projectAppIcon,
  projectAppNav,
  projectAppTint,
  pruneAppNav,
} from '@mantle/content-core/app-nav';
import {
  bumpPreferenceCounter,
  loadPreferencesFor,
  savePreferenceIfRev,
  savePreferencesFor,
} from './profile-preferences';

/** NOTIFY channel for any app-nav write (payload: anchor owner id). Consumed
 *  by server/web/lib/realtime.ts, which broadcasts it as type 'app-nav'. */
export const APP_NAV_CHANGED_CHANNEL = 'app_nav_changed';

/** Tell every connected client the sidebar changed. Best-effort: a missed
 *  notify only delays the refresh until the next load. */
export async function notifyAppNavChanged(ownerId: string): Promise<void> {
  try {
    await db.execute(sql`SELECT pg_notify(${APP_NAV_CHANGED_CHANNEL}, ${ownerId}::text)`);
  } catch (err) {
    console.error('[app-nav] notify failed:', err instanceof Error ? err.message : err);
  }
}

/** Every app the owner has, slim, for navigation. Unpaginated on purpose: the
 *  sidebar needs the whole set to place and search it. */
export async function listAppNavItems(ownerId: string): Promise<AppNavItem[]> {
  const rows = await db
    .select({
      id: nodes.id,
      title: nodes.title,
      data: nodes.data,
      tags: nodes.tags,
      updatedAt: nodes.updatedAt,
      manifest: apps.manifest,
      publishedBuild: apps.publishedBuild,
    })
    .from(nodes)
    .leftJoin(apps, eq(apps.nodeId, nodes.id))
    .where(and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'app')))
    .orderBy(desc(nodes.updatedAt));
  return rows.map((r) => {
    const d = (r.data ?? {}) as Record<string, unknown>;
    return {
      id: r.id,
      title: r.title,
      icon: projectAppIcon(d.icon) ?? null,
      color: projectAppTint(d.color) ?? null,
      tags: r.tags ?? [],
      description:
        typeof r.manifest?.description === 'string' && r.manifest.description
          ? r.manifest.description
          : null,
      hasBuild: r.publishedBuild?.ok === true,
      updatedAt: r.updatedAt.toISOString(),
    };
  });
}

/**
 * The sidebar's single read. `ownerId` is the anchor (whose apps these are and
 * whose row holds the layout); `actorId` is the login, for pins and counts.
 * The tree and pins come back pruned to apps that still exist, so a client
 * never has to reconcile a deleted app.
 */
export async function loadAppNavView(ownerId: string, actorId: string): Promise<AppNavResponse> {
  const [items, prefs] = await Promise.all([listAppNavItems(ownerId), loadPreferencesFor(actorId)]);
  const live = new Set(items.map((a) => a.id));
  const nav = prefs.appNav ?? EMPTY_APP_NAV;
  const opens = Object.fromEntries(
    Object.entries(prefs.appOpens ?? {}).filter(([id]) => live.has(id)),
  );
  return {
    nav: { rev: nav.rev, entries: pruneAppNav(nav.entries, (id) => live.has(id)) },
    pins: (prefs.appPins ?? []).filter((id) => live.has(id)),
    opens,
    apps: items,
  };
}

export class AppNavInvalidError extends Error {}

export type SaveAppNavResult = { ok: true; nav: AppNav } | { ok: false; current: AppNav };

/**
 * Save the shared layout, compare-and-set on `baseRev` (savePreferenceIfRev):
 * a lost race returns `{ ok: false, current }` so the client can reapply its
 * change on top of what the other device saved.
 *
 * Placements of apps that don't exist (deleted since the client loaded) are
 * dropped rather than refused: a stale app id is expected, not a bug. Anything
 * else malformed throws AppNavInvalidError.
 */
export async function saveAppNav(
  ownerId: string,
  baseRev: number,
  entries: unknown,
): Promise<SaveAppNavResult> {
  const issue = appNavIssue(entries);
  if (issue) throw new AppNavInvalidError(issue);
  const projected = projectAppNav({ rev: 0, entries });
  if (!projected) throw new AppNavInvalidError('entries must be an array');

  const live = new Set((await listAppNavItems(ownerId)).map((a) => a.id));
  const next = {
    entries: pruneAppNav(projected.entries as AppNavEntry[], (id) => live.has(id)),
  };

  const saved = await savePreferenceIfRev(ownerId, 'appNav', next, baseRev);
  if (!saved.ok) {
    const current = saved.current ?? EMPTY_APP_NAV;
    return {
      ok: false,
      current: { rev: current.rev, entries: pruneAppNav(current.entries, (id) => live.has(id)) },
    };
  }
  void notifyAppNavChanged(ownerId);
  return { ok: true, nav: saved.value };
}

/** Replace one login's pins (order matters). Pins of missing apps are dropped. */
export async function saveAppPins(
  ownerId: string,
  actorId: string,
  pins: string[],
): Promise<string[]> {
  const live = new Set((await listAppNavItems(ownerId)).map((a) => a.id));
  const prefs = await savePreferencesFor(actorId, {
    appPins: pins.filter((id) => live.has(id.trim().toLowerCase())),
  });
  void notifyAppNavChanged(ownerId);
  return prefs.appPins ?? [];
}

/**
 * Count one open of an app by one login (bumpPreferenceCounter: atomic, so two
 * tabs opening at once both count). Returns false when the app doesn't exist.
 */
export async function recordAppOpen(
  ownerId: string,
  actorId: string,
  appId: string,
): Promise<boolean> {
  const [app] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, appId), eq(nodes.ownerId, ownerId), eq(nodes.type, 'app')))
    .limit(1);
  if (!app) return false;
  await bumpPreferenceCounter(actorId, 'appOpens', app.id);
  return true;
}
