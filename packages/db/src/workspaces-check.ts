/**
 * workspaces:check: the read-only health check of the grants, the only
 * truth (migration 0261). Numbers only, never titles or names; it writes
 * nothing (the runner reads in a READ ONLY transaction).
 *
 *  - grant drift: nodes whose read_ws, write_ws or home_ws differ from what
 *    their item_grants rows give (the derivation of 0241 keeps them equal;
 *    any count is a writer that went around it);
 *  - orphan grants: rows of a missing node or workspace, and folder-derived
 *    rows whose folder is not the item's folder, or no longer grants that
 *    workspace;
 *  - items without a home: brain items with no home workspace (a migrated
 *    brain gives every new item one, 0261);
 *  - workspaces without a Moderator who can sign in (a user ticked
 *    Moderator; no workspace is Admin-moderated since 0286), and the Admin
 *    workspace on its own. Not the workspaces 0264 made: a "Former user"
 *    workspace has no users by design (an Admin user may join it), and a
 *    private workspace has its login alone, disabled or not;
 *  - assistants not in exactly one workspace: an assistant resource whose
 *    agent names another workspace or none, or an agent attached twice;
 *  - open links whose settings carry no `served` key (the served list): a
 *    finding only once some link carries the key, so a box whose links
 *    predate the key is not flagged for every link.
 */
import { sql } from 'drizzle-orm';
import { db } from './client';
import { liveWorkspaceText } from './workspace-live';

/** The grant drift count alone (`n`; also the integrity row). */
export const GRANT_DRIFT_SQL = `
SELECT count(*) AS n
  FROM "public"."nodes" n
  LEFT JOIN (
    SELECT ig."node_id",
           coalesce(array_agg(ig."workspace_id") FILTER (WHERE NOT ig."excluded"), '{}'::uuid[]) AS r,
           coalesce(array_agg(ig."workspace_id") FILTER (WHERE ig."write" AND NOT ig."excluded"), '{}'::uuid[]) AS w,
           (array_agg(ig."workspace_id") FILTER (WHERE ig."is_home"))[1] AS h
      FROM "public"."item_grants" ig GROUP BY ig."node_id") g ON g."node_id" = n."id"
 WHERE NOT (coalesce(n."read_ws", '{}') @> coalesce(g.r, '{}') AND coalesce(g.r, '{}') @> coalesce(n."read_ws", '{}')
            AND coalesce(n."write_ws", '{}') @> coalesce(g.w, '{}') AND coalesce(g.w, '{}') @> coalesce(n."write_ws", '{}'))
    OR n."home_ws" IS DISTINCT FROM g.h
`;

/** One row of counts. */
export const WORKSPACES_CHECK_SQL = `
WITH b AS (SELECT "public"."mantle_brain_id"() AS brain),
admin_ws AS (
  SELECT w."id" FROM "public"."workspaces" w, b WHERE w."owner_id" = b.brain AND w."is_admin"
),
moderated AS (
  SELECT w."id", w."is_admin",
         EXISTS (
           SELECT 1 FROM "public"."workspace_users" u
             JOIN auth.users x ON x."id" = u."login_id" AND x."disabled_at" IS NULL
            WHERE u."workspace_id" = w."id" AND u."moderator") AS ok
    FROM "public"."workspaces" w, b
   WHERE w."owner_id" = b.brain AND ${liveWorkspaceText('w')}
     AND NOT EXISTS (SELECT 1 FROM "public"."former_user_workspaces" f WHERE f."workspace_id" = w."id")
     AND NOT EXISTS (SELECT 1 FROM "public"."private_workspaces" p WHERE p."workspace_id" = w."id")
),
links AS (
  SELECT count(*) FILTER (WHERE NOT (s."settings" ? 'served')) AS without_served,
         count(*) FILTER (WHERE s."settings" ? 'served') AS with_served
    FROM "public"."shares" s
   WHERE s."revoked_at" IS NULL AND s."contact_id" IS NULL
     AND (s."expires_at" IS NULL OR s."expires_at" > now())
)
SELECT
  EXISTS (SELECT 1 FROM admin_ws) AS migrated,
  (SELECT d.n FROM (${GRANT_DRIFT_SQL}) d) AS grant_drift,
  (SELECT count(*) FROM "public"."item_grants" ig
     LEFT JOIN "public"."nodes" n ON n."id" = ig."node_id"
     LEFT JOIN "public"."workspaces" w ON w."id" = ig."workspace_id"
    WHERE n."id" IS NULL OR w."id" IS NULL
       OR (ig."via_folder_id" IS NOT NULL
           AND (NOT EXISTS (SELECT 1 FROM "public"."nodes" f
                             WHERE f."id" = ig."via_folder_id" AND f."owner_id" = n."owner_id"
                               AND f."type" = 'branch'
                               AND f."path" = "public"."mantle_parent_folder_path"(n."type", n."path"))
                OR NOT EXISTS (SELECT 1 FROM "public"."item_grants" fg
                                WHERE fg."node_id" = ig."via_folder_id"
                                  AND fg."workspace_id" = ig."workspace_id" AND NOT fg."excluded")))) AS orphan_grants,
  (SELECT count(*) FROM "public"."nodes" n, b
    WHERE n."owner_id" = b.brain AND n."home_ws" IS NULL AND EXISTS (SELECT 1 FROM admin_ws)) AS items_without_home,
  (SELECT count(*) FROM moderated WHERE NOT ok) AS workspaces_without_moderator,
  (SELECT count(*) FROM moderated WHERE NOT ok AND "is_admin") AS admin_without_moderator,
  (SELECT count(*) FROM (
     SELECT r."ref_id"
       FROM "public"."workspace_resources" r
       LEFT JOIN "public"."agents" a ON a."id"::text = r."ref_id"
      WHERE r."type" = 'assistant'
      GROUP BY r."ref_id"
     HAVING count(*) > 1 OR bool_or(a."workspace_id" IS DISTINCT FROM r."workspace_id")) x) AS assistants_not_in_one,
  (SELECT without_served FROM links) AS links_without_served,
  (SELECT with_served FROM links) AS links_with_served
`;

export interface WorkspacesCheck {
  /** The brain has workspaces (an Admin workspace). */
  migrated: boolean;
  grantDrift: number;
  orphanGrants: number;
  itemsWithoutHome: number;
  workspacesWithoutModerator: number;
  adminWithoutModerator: number;
  assistantsNotInOneWorkspace: number;
  linksWithoutServed: number;
  /** Some open link carries the `served` key, so one without it is a finding. */
  linksServedInUse: boolean;
}

type CheckRow = {
  migrated: boolean;
  grant_drift: string | number;
  orphan_grants: string | number;
  items_without_home: string | number;
  workspaces_without_moderator: string | number;
  admin_without_moderator: string | number;
  assistants_not_in_one: string | number;
  links_without_served: string | number;
  links_with_served: string | number;
};

/** The counts from the row WORKSPACES_CHECK_SQL returns. */
export function parseWorkspacesCheck(row: CheckRow): WorkspacesCheck {
  return {
    migrated: Boolean(row.migrated),
    grantDrift: Number(row.grant_drift),
    orphanGrants: Number(row.orphan_grants),
    itemsWithoutHome: Number(row.items_without_home),
    workspacesWithoutModerator: Number(row.workspaces_without_moderator),
    adminWithoutModerator: Number(row.admin_without_moderator),
    assistantsNotInOneWorkspace: Number(row.assistants_not_in_one),
    linksWithoutServed: Number(row.links_without_served),
    linksServedInUse: Number(row.links_with_served) > 0,
  };
}

/** How many findings the check holds (the Admin count is inside the
 *  workspace count; links only once the served key is in use). */
export function workspacesCheckFindings(c: WorkspacesCheck): number {
  return (
    c.grantDrift +
    c.orphanGrants +
    c.itemsWithoutHome +
    c.workspacesWithoutModerator +
    c.assistantsNotInOneWorkspace +
    (c.linksServedInUse ? c.linksWithoutServed : 0)
  );
}

/** Run the check in a READ ONLY transaction: it cannot write. */
export async function runWorkspacesCheck(): Promise<WorkspacesCheck> {
  const rows = (await db.transaction(async (tx) => tx.execute(sql.raw(WORKSPACES_CHECK_SQL)), {
    accessMode: 'read only',
  })) as unknown as CheckRow[];
  return parseWorkspacesCheck(rows[0]!);
}
