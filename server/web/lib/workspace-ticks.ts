/**
 * The roll of "Team is a normal workspace" (migration 0286, owner answer
 * Q1): the ticks are kept on the roll, counted first, and an Admin user
 * clears the member ticks right after it (the UI, or the command below).
 *
 * - teamCheckCounts (pnpm -C server/web ws:team-check): read only, numbers
 *   only, no names, emails, titles or ids. The same two counts are a plain
 *   SQL block in docs/update-prod.md that runs on a box before the roll
 *   (the older image has neither this file nor 0286); keep the two in step.
 * - clearMemberTicks (pnpm -C server/web ws:clear-member-ticks): one
 *   workspace, dry run by default, counts only. With apply it clears the
 *   Moderator tick of every user who is not an Admin user, keeps at least
 *   one Moderator, and writes the workspace_events row setModerator writes
 *   (user.moderator), with no actor and `by` naming the command. It never
 *   removes a row.
 *
 * "Admin user" is a user of the brain's Admin workspace (the one rule of
 * server/web/lib/workspaces.ts). "The former Team" is the workspace 0286
 * made normal (its workspace.update row says so), or on a box before the
 * roll the one with bridge_key 'team'. Both run on the system pool: the
 * operator's process, system(script:<file>) (docs/actors.md).
 */
import { sql } from 'drizzle-orm';
import { db, liveHolderBeyondAdminSql } from '@mantle/db';

/** What `by` says on each workspace_events row the clear writes. */
export const CLEAR_TICKS_BY = 'ws:clear-member-ticks';

/** The former Team workspace's id (0286 made it normal), or none. */
const FORMER_TEAM_SQL = sql`(
  select w.id from workspaces w
   where w.owner_id = mantle_brain_id()
     and (w.bridge_key = 'team'
          or exists (select 1 from workspace_events e
                      where e.workspace_id = w.id and e.action = 'workspace.update'
                        and e.subject->>'by' = 'migration 0286'))
   order by w.created_at limit 1)`;

/** A login that is a user of the brain's Admin workspace. */
const isAdminUser = (login: ReturnType<typeof sql>) => sql`exists (
  select 1 from workspace_users au
    join workspaces aw on aw.id = au.workspace_id and aw.is_admin
                      and aw.owner_id = mantle_brain_id()
   where au.login_id = ${login})`;

export type TeamCheckCounts = {
  /** 1 when the brain has the former Team workspace, else 0. */
  formerTeam: number;
  /** Its Moderators who are not Admin users (the ticks the switch gave). */
  formerTeamMemberModerators: number;
  /** The same over every shared workspace (not Admin, private or Former
   *  user), the former Team included. */
  sharedMemberModerators: number;
  /** Member-built apps (author_level 'team') with no live holder workspace
   *  beyond Admin: they read nothing after the roll (audit M3,
   *  appRunHolders); re-share each to a workspace to fix it. */
  memberAppsWithoutHolder: number;
};

/** Read only: one statement, numbers only. */
export async function teamCheckCounts(): Promise<TeamCheckCounts> {
  const [r] = (await db.execute(sql`
    with t as (select ${FORMER_TEAM_SQL} as id)
    select
      (select count(*) from t where t.id is not null)::int as former_team,
      (select count(*) from workspace_users u, t
        where u.workspace_id = t.id and u.moderator
          and not ${isAdminUser(sql`u.login_id`)})::int as former_team_member_moderators,
      (select count(*) from workspace_users u
         join workspaces w on w.id = u.workspace_id and w.owner_id = mantle_brain_id()
                          and w.archived_at is null
        where u.moderator and "public"."mantle_ws_any_shared"(array[w.id])
          and not ${isAdminUser(sql`u.login_id`)})::int as shared_member_moderators,
      (select count(*) from apps a
         join nodes n on n.id = a.node_id and n.type = 'app'
        where a.author_level = 'team' and n.owner_id = mantle_brain_id()
          and not exists (select 1 from workspaces w
                           where ${liveHolderBeyondAdminSql('w', 'n')}))::int as member_apps_without_holder
  `)) as unknown as Array<{
    former_team: number;
    former_team_member_moderators: number;
    shared_member_moderators: number;
    member_apps_without_holder: number;
  }>;
  return {
    formerTeam: r?.former_team ?? 0,
    formerTeamMemberModerators: r?.former_team_member_moderators ?? 0,
    sharedMemberModerators: r?.shared_member_moderators ?? 0,
    memberAppsWithoutHolder: r?.member_apps_without_holder ?? 0,
  };
}

export type ClearTicksResult =
  | { ok: false; reason: 'not_found' | 'archived' | 'admin_workspace' }
  | {
      ok: true;
      applied: boolean;
      /** Moderators before the run. */
      moderators: number;
      /** Of them, Admin users (they keep the tick). */
      adminModerators: number;
      /** Ticks cleared (with apply) or that a run with --apply clears. */
      cleared: number;
      /** A member tick kept so the workspace keeps a Moderator (0 or 1). */
      keptForLastModerator: number;
    };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Clear the Moderator tick of every user of one workspace who is not an
 * Admin user. `workspace` is its id, or 'former-team' for the workspace
 * 0286 made normal. The Admin workspace is refused (its Moderators are
 * Admin users by rule), and so is an archived one (nobody manages it).
 * When no Admin user moderates the workspace, the member Moderator added
 * first keeps the tick: a workspace never ends without a Moderator.
 */
export async function clearMemberTicks(
  workspace: string,
  apply: boolean,
): Promise<ClearTicksResult> {
  if (workspace !== 'former-team' && !UUID_RE.test(workspace))
    return { ok: false, reason: 'not_found' };
  const target = workspace === 'former-team' ? FORMER_TEAM_SQL : sql`${workspace}::uuid`;
  return db.transaction(async (tx) => {
    // The workspace row first, FOR UPDATE, as every change on the
    // workspace screen takes it: a tick changed there meanwhile waits.
    const [ws] = (await tx.execute(sql`
      select w.id::text as id, w.is_admin, w.archived_at is not null as archived
        from workspaces w
       where w.id = ${target} and w.owner_id = mantle_brain_id()
       for update`)) as unknown as Array<{ id: string; is_admin: boolean; archived: boolean }>;
    if (!ws) return { ok: false, reason: 'not_found' } as const;
    if (ws.is_admin) return { ok: false, reason: 'admin_workspace' } as const;
    if (ws.archived) return { ok: false, reason: 'archived' } as const;
    const mods = (await tx.execute(sql`
      select u.login_id::text as login, ${isAdminUser(sql`u.login_id`)} as admin
        from workspace_users u
       where u.workspace_id = ${ws.id} and u.moderator
       order by u.added_at, u.login_id`)) as unknown as Array<{ login: string; admin: boolean }>;
    const admins = mods.filter((m) => m.admin).length;
    let members = mods.filter((m) => !m.admin).map((m) => m.login);
    // Never the last Moderator: with no Admin user among them, the first
    // added member keeps the tick.
    const kept = admins === 0 && members.length > 0 ? 1 : 0;
    if (kept) members = members.slice(1);
    if (apply) {
      for (const login of members) {
        await tx.execute(sql`
          update workspace_users set moderator = false
           where workspace_id = ${ws.id} and login_id = ${login}::uuid and moderator`);
        await tx.execute(sql`
          insert into workspace_events (workspace_id, actor_id, action, subject)
          values (${ws.id}, null, 'user.moderator',
                  ${JSON.stringify({ login, moderator: false, by: CLEAR_TICKS_BY })}::jsonb)`);
      }
    }
    return {
      ok: true,
      applied: apply,
      moderators: mods.length,
      adminModerators: admins,
      cleared: members.length,
      keptForLastModerator: kept,
    } as const;
  });
}
