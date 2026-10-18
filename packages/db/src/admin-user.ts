/**
 * "An Admin user" as SQL, for code that asks it of logins other than the
 * caller (the 0286 roll: server/web/lib/workspace-ticks.ts): the area rule,
 * mantle_area_rule (0304), the one SQL source of it. A user of this brain's
 * live Admin workspace whose limits do not switch `area` off (false or
 * "false"), and a login that is not disabled. The system pool's (the
 * runtime role may run it; no viewer role may).
 */
import { sql, type SQL } from 'drizzle-orm';
import type { WorkspaceArea as Area } from '@mantle/client-types/dto/workspaces';

/** `login` (a uuid expression) is an Admin user holding `area`. */
export function adminUserSql(login: SQL, area: Area = 'users'): SQL<boolean> {
  return sql<boolean>`"public"."mantle_area_rule"(${login}, ${area}::text)`;
}
