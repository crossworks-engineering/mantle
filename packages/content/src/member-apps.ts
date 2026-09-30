/**
 * Apps for members (member logins Phase 4b, plan v3.1 section 4a). A member
 * RUNS apps; a member never creates, edits, builds, publishes, shares or
 * deletes one. What a member may run: an app at team level or lower, with a
 * green PUBLISHED build. Never a draft.
 *
 * The rule is written in every query here (`MEMBER_APP_LEVELS`, the published
 * build), not left to row security alone: the db broker runs the app's SQLite
 * on the admin pool (the registry rows it writes are admin), and row security
 * does not reach SQLite. The member routes still read through
 * `withViewer('team', …)` as a second lock.
 *
 * Only granted columns are read (never `apps.draft_*`), so these work on the
 * team role.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  apps,
  asViewerLevel,
  db,
  nodes,
  type AppManifest,
  type BuildRef,
  type ViewerLevel,
} from '@mantle/db';
import { projectAppIcon, projectAppTint } from '@mantle/content-core/app-nav';
import type { AppTint, MemberAppCard, MemberAppLevel, MemberHomeApp } from '@mantle/client-types';
import { isReadAt, itemLevel, readAtSql } from './item-level';

/** The app levels a member may run: team and below. Pinned to the published
 *  `MemberAppLevel` in server/web/lib/client-types-drift.test.ts. */
export const MEMBER_APP_LEVELS = [
  'team',
  'client',
  'public',
] as const satisfies readonly MemberAppLevel[];

export function isMemberAppLevel(level: unknown): level is MemberAppLevel {
  return (MEMBER_APP_LEVELS as readonly string[]).includes(asViewerLevel(level));
}

/** One launcher card: the published contract type. */
export type { MemberAppCard };

/** A runnable app: what the frame and the brokers need, published only. */
export type MemberRunnableApp = {
  id: string;
  title: string;
  icon: string | null;
  color: AppTint | null;
  audience: ViewerLevel;
  manifest: AppManifest;
  publishedBuild: BuildRef;
  /** apps.data_read_only: the app is informational (client logins C6). */
  dataReadOnly: boolean;
};

/**
 * May a member WRITE this app's database (client logins C6, Jason's rule of
 * 2026-09-30)? An app at team or client level is a shared workspace: every
 * member who runs it writes it, unless an admin marked it informational. A
 * public app stays read only for members, so nothing a member writes shows
 * to anonymous visitors (decided 2026-09-27).
 */
export function memberMayWriteAppData(app: {
  audience: ViewerLevel;
  dataReadOnly: boolean;
}): boolean {
  return (app.audience === 'team' || app.audience === 'client') && !app.dataReadOnly;
}

const publishedGreen = sql`(${apps.publishedBuild}->>'ok')::boolean is true`;

function runnableWhere(anchorId: string) {
  return and(
    eq(nodes.ownerId, anchorId),
    eq(nodes.type, 'app'),
    // Its own level or the share of a folder holding it.
    readAtSql(MEMBER_APP_LEVELS),
    publishedGreen,
  );
}

/** The apps a member may run, by title. */
export async function listMemberApps(anchorId: string): Promise<MemberAppCard[]> {
  const rows = await db
    .select({
      id: nodes.id,
      title: nodes.title,
      data: nodes.data,
      audience: nodes.audience,
      inheritedLevel: nodes.inheritedLevel,
      embeddedLevel: nodes.embeddedLevel,
      updatedAt: nodes.updatedAt,
      manifest: apps.manifest,
      dataReadOnly: apps.dataReadOnly,
    })
    .from(nodes)
    .innerJoin(apps, eq(apps.nodeId, nodes.id))
    .where(runnableWhere(anchorId))
    .orderBy(asc(nodes.title))
    .limit(500);
  return rows.flatMap((r): MemberAppCard[] => {
    // The query already keeps to these levels; a row outside them is never
    // a card, whatever the column holds.
    if (!isReadAt(r.audience, r.inheritedLevel, MEMBER_APP_LEVELS, r.embeddedLevel)) return [];
    // The level it is read at: its own, or its folder's share when that is
    // more open (an admin app in a team folder runs, and writes, as team).
    const audience = itemLevel(r.audience, r.inheritedLevel, r.embeddedLevel) as MemberAppLevel;
    const d = (r.data ?? {}) as Record<string, unknown>;
    const description = (r.manifest as AppManifest | null)?.description;
    return [
      {
        id: r.id,
        title: r.title,
        icon: projectAppIcon(d.icon) ?? null,
        color: projectAppTint(d.color) ?? null,
        description: typeof description === 'string' && description.trim() ? description : null,
        audience,
        updatedAt: r.updatedAt.toISOString(),
        dataReadOnly: !memberMayWriteAppData({
          audience,
          dataReadOnly: r.dataReadOnly === true,
        }),
      },
    ];
  });
}

/** One app a member may run, or null: not an app, above team, no green
 *  published build, or not this brain's. The same null for all of them. */
export async function getMemberRunnableApp(
  anchorId: string,
  appId: string,
): Promise<MemberRunnableApp | null> {
  const [row] = await db
    .select({
      id: nodes.id,
      title: nodes.title,
      data: nodes.data,
      audience: nodes.audience,
      inheritedLevel: nodes.inheritedLevel,
      embeddedLevel: nodes.embeddedLevel,
      manifest: apps.manifest,
      publishedBuild: apps.publishedBuild,
      dataReadOnly: apps.dataReadOnly,
    })
    .from(nodes)
    .innerJoin(apps, eq(apps.nodeId, nodes.id))
    .where(and(eq(nodes.id, appId), runnableWhere(anchorId)))
    .limit(1);
  if (!row?.publishedBuild?.ok) return null;
  const d = (row.data ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    title: row.title,
    icon: projectAppIcon(d.icon) ?? null,
    color: projectAppTint(d.color) ?? null,
    audience: itemLevel(row.audience, row.inheritedLevel, row.embeddedLevel),
    manifest: (row.manifest ?? {}) as AppManifest,
    publishedBuild: row.publishedBuild,
    dataReadOnly: row.dataReadOnly === true,
  };
}

/** Ids of the apps at team level or lower (published or not): the apps whose
 *  data a team surface may read (team-read app_db_list / app_db_query). */
export async function listTeamLevelAppIds(anchorId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.ownerId, anchorId), eq(nodes.type, 'app'), readAtSql(MEMBER_APP_LEVELS)));
  return new Set(rows.map((r) => r.id));
}

/**
 * The members' home app (plan 4a, "Hub app"): the app the brain pins as home
 * (the `teamHubAppId` pref, set in Team admin > Settings), honoured for a
 * member only while it is one they may run. No share is needed: the level is
 * the access. Null means the member home shows its built-in view.
 */
export async function resolveMemberHomeApp(
  anchorId: string,
  homeAppId: string | undefined,
): Promise<MemberHomeApp | null> {
  if (!homeAppId) return null;
  const app = await getMemberRunnableApp(anchorId, homeAppId);
  return app ? { appId: app.id, title: app.title, icon: app.icon, color: app.color } : null;
}
