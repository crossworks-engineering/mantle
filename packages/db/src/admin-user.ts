/**
 * "An Admin user" as SQL, for code that asks it of logins other than the
 * caller (the 0286 roll: server/web/lib/workspace-ticks.ts). The same rule
 * mayPromote applies to the caller (server/web/lib/workspaces.ts: areasFor,
 * areasFromLimits): a user of this brain's live Admin workspace whose limits
 * do not switch `area` off (false or "false", as mantle_scope_has_area reads
 * them), and a login that is not disabled (a disabled login never reaches
 * mayPromote: the session refuses it first).
 */
import { sql, type SQL } from 'drizzle-orm';
import type { WorkspaceArea as Area } from '@mantle/client-types/dto/workspaces';
import { liveWorkspaceSql } from './workspace-live';

/** `login` (a uuid expression) is an Admin user holding `area`. */
export function adminUserSql(login: SQL, area: Area = 'users'): SQL<boolean> {
  return sql<boolean>`exists (
    select 1 from "public"."workspace_users" au
      join "public"."workspaces" aw on aw.id = au.workspace_id and aw.is_admin
                                   and ${liveWorkspaceSql('aw')}
                                   and aw.owner_id = "public"."mantle_brain_id"()
      join auth.users al on al.id = au.login_id and al.disabled_at is null
     where au.login_id = ${login}
       and coalesce(au.limits -> 'areas' ->> ${area}, '') <> 'false')`;
}
