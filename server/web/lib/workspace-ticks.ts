/**
 * The roll of "Team is a normal workspace" (migration 0286, owner answer
 * Q1): the ticks are kept on the roll, counted first, and an Admin user
 * clears the member ticks right after it (the UI, or the command below).
 *
 * - teamCheckCounts (pnpm -C server/web ws:team-check): read only, numbers
 *   only, no names, emails, titles or ids. Its second and fourth counts
 *   (the former Team's member Moderators, member-built apps with no holder)
 *   are a plain SQL block in docs/update-prod.md that runs on a box before
 *   the roll (the older image has neither this file nor 0286); keep the
 *   two in step.
 * - clearMemberTicks (pnpm -C server/web ws:clear-member-ticks): one
 *   workspace, dry run by default, counts only. With apply it clears the
 *   Moderator tick of every user who is not an Admin user, keeps at least
 *   one Moderator, and writes the workspace_events row setModerator writes
 *   (user.moderator), with no actor and `by` naming the command. It never
 *   removes a row. Each clear is mantle_ws_set_moderator (0305), the same
 *   definer the workspace screen calls, as workspace
 *   system work (systemWork 'ws-clear-ticks': the one actor its SQL
 *   allowlist, mantle_ws_system_work, takes from this command).
 *
 * "Admin user" is adminUserSql (@mantle/db): a live login in the brain's
 * Admin workspace holding the users area, the rule mayPromote applies to its
 * caller (server/web/lib/workspaces.ts), so a disabled Admin login, or one
 * whose users area is off, never counts as the Admin Moderator that lets
 * the clear take every member tick. "The former Team" is the workspace 0286
 * made normal (its workspace.update row says so), or on a box before the
 * roll the one with bridge_key 'team'. Both run on the system pool: the
 * operator's process, system(script:<file>) (docs/actors.md).
 */
import { sql } from 'drizzle-orm';
import {
  adminUserSql,
  db,
  holderReadsSql,
  liveWorkspaceSql,
  nodes,
  sharedWorkspacesSql,
  systemWork,
} from '@mantle/db';
import { UUID_RE } from '@mantle/std';

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
          and not ${adminUserSql(sql`u.login_id`)})::int as former_team_member_moderators,
      (select count(*) from workspace_users u
         join workspaces w on w.id = u.workspace_id and w.owner_id = mantle_brain_id()
                          and ${liveWorkspaceSql('w')}
        where u.moderator and ${sharedWorkspacesSql(sql`array[w.id]`)}
          and not ${adminUserSql(sql`u.login_id`)})::int as shared_member_moderators,
      (select count(*) from apps a
         join ${nodes} on ${nodes.id} = a.node_id and ${nodes.type} = 'app'
        where a.author_level = 'team' and ${nodes.ownerId} = mantle_brain_id()
          and not ${holderReadsSql()})::int as member_apps_without_holder
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
  return systemWork(() => clearTicksTx(target, apply), 'ws-clear-ticks');
}

/** clearMemberTicks' transaction, as workspace system work. */
function clearTicksTx(target: ReturnType<typeof sql>, apply: boolean): Promise<ClearTicksResult> {
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
      select u.login_id::text as login, ${adminUserSql(sql`u.login_id`)} as admin
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
          select "public"."mantle_ws_set_moderator"(mantle_brain_id(), ${ws.id}::uuid,
                   ${login}::uuid, false, ${CLEAR_TICKS_BY})`);
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
