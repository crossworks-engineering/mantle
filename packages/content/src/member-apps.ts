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
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
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
import type { AppTint } from '@mantle/client-types';

/** The app levels a member may run: team and below. */
export const MEMBER_APP_LEVELS = ['team', 'client', 'public'] as const satisfies ViewerLevel[];

export function isMemberAppLevel(level: unknown): boolean {
  return (MEMBER_APP_LEVELS as readonly string[]).includes(asViewerLevel(level));
}

/** One launcher card. */
export type MemberAppCard = {
  id: string;
  title: string;
  icon: string | null;
  color: AppTint | null;
  description: string | null;
  audience: ViewerLevel;
  updatedAt: string;
};

/** A runnable app: what the frame and the brokers need, published only. */
export type MemberRunnableApp = {
  id: string;
  title: string;
  audience: ViewerLevel;
  manifest: AppManifest;
  publishedBuild: BuildRef;
};

const publishedGreen = sql`(${apps.publishedBuild}->>'ok')::boolean is true`;

function runnableWhere(anchorId: string) {
  return and(
    eq(nodes.ownerId, anchorId),
    eq(nodes.type, 'app'),
    inArray(nodes.audience, [...MEMBER_APP_LEVELS]),
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
      updatedAt: nodes.updatedAt,
      manifest: apps.manifest,
    })
    .from(nodes)
    .innerJoin(apps, eq(apps.nodeId, nodes.id))
    .where(runnableWhere(anchorId))
    .orderBy(asc(nodes.title))
    .limit(500);
  return rows.map((r) => {
    const d = (r.data ?? {}) as Record<string, unknown>;
    const description = (r.manifest as AppManifest | null)?.description;
    return {
      id: r.id,
      title: r.title,
      icon: projectAppIcon(d.icon) ?? null,
      color: projectAppTint(d.color) ?? null,
      description: typeof description === 'string' && description.trim() ? description : null,
      audience: asViewerLevel(r.audience),
      updatedAt: r.updatedAt.toISOString(),
    };
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
      audience: nodes.audience,
      manifest: apps.manifest,
      publishedBuild: apps.publishedBuild,
    })
    .from(nodes)
    .innerJoin(apps, eq(apps.nodeId, nodes.id))
    .where(and(eq(nodes.id, appId), runnableWhere(anchorId)))
    .limit(1);
  if (!row?.publishedBuild?.ok) return null;
  return {
    id: row.id,
    title: row.title,
    audience: asViewerLevel(row.audience),
    manifest: (row.manifest ?? {}) as AppManifest,
    publishedBuild: row.publishedBuild,
  };
}

/** Ids of the apps at team level or lower (published or not): the apps whose
 *  data a team surface may read (team-read app_db_list / app_db_query). */
export async function listTeamLevelAppIds(anchorId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, anchorId),
        eq(nodes.type, 'app'),
        inArray(nodes.audience, [...MEMBER_APP_LEVELS]),
      ),
    );
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
): Promise<{ appId: string; title: string } | null> {
  if (!homeAppId) return null;
  const app = await getMemberRunnableApp(anchorId, homeAppId);
  return app ? { appId: app.id, title: app.title } : null;
}
