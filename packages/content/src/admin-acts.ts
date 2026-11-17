/**
 * The Admin acts as definers (migrations 0308, 0310; the contact share acts
 * went with 0378): an entity merge, a share closed, an app's trash. Each calls its
 * SECURITY DEFINER function in the acting login's scope (loginDefinerCall,
 * @mantle/db), and the function checks inside that the login is an Admin
 * user with the Admin workspace in its scope (mantle_admin_act_brain); a
 * member's scope, or none, is refused there with 42501. The routes call
 * these; the content functions with an owner (entity-dedup.ts) call the
 * same SQL bodies for system work, without the check.
 */
import { sql, type SQL } from 'drizzle-orm';
import { loginDefinerCall, type AppSnapshotCode } from '@mantle/db';
import { defineDomainError, findDatabaseError } from '@mantle/std';

/** The definer refused the login (mantle_admin_act_brain: 42501, detail
 *  admin_act_*): a login the guard let through as an Admin user that is
 *  none in the database now (role drift, an archived Admin workspace, a
 *  login disabled mid-request). */
export class AdminActRefusedError extends Error {
  constructor() {
    super('Not available to member logins.');
    this.name = 'AdminActRefusedError';
  }
}

// The guard's own refusal of a login that is no Admin user (session.ts
// loginRefused), the same 403 and body.
defineDomainError(AdminActRefusedError, {
  reason: 'the login is no Admin user in the database (an Admin act refused it inside)',
  status: 403,
  body: () => ({
    error: 'forbidden',
    reason: 'member-login',
    message: 'Not available to member logins.',
  }),
});

/** One Admin act's definer call in `loginId`'s scope (loginDefinerCall,
 *  'admin'), its rows; the definer's refusal of the login as
 *  AdminActRefusedError (any other error as it is). */
async function asAdmin<R>(loginId: string, query: SQL): Promise<R[]> {
  try {
    return await loginDefinerCall<R>(loginId, 'admin', query);
  } catch (err) {
    const pg = findDatabaseError(err) as { code?: unknown; detail?: unknown } | null;
    if (
      pg?.code === '42501' &&
      typeof pg.detail === 'string' &&
      pg.detail.startsWith('admin_act_')
    ) {
      throw new AdminActRefusedError();
    }
    throw err;
  }
}

/** POST /api/entities/merge: `dupId` into `canonicalId`, as `loginId`
 *  (mantle_entity_merge). False when they are one or either is missing. */
export async function adminMergeEntities(
  loginId: string,
  canonicalId: string,
  dupId: string,
): Promise<boolean> {
  const rows = await asAdmin<{ ok: boolean }>(
    loginId,
    sql`select mantle_entity_merge(${canonicalId}::uuid, ${dupId}::uuid) as ok`,
  );
  return rows[0]?.ok === true;
}

// ── Part c2 (migration 0310): the item gate's three Admin acts ─────────────

/** DELETE /api/shares/:id by an Admin user with the users area
 *  (mantle_share_close_admin): 'closed' (revoked now), 'gone' (no live
 *  share by this id), or 'no-area' when the login does not hold the users
 *  area (nothing written: the route closes it by the link's rule). */
export async function adminCloseShare(
  loginId: string,
  shareId: string,
): Promise<'closed' | 'gone' | 'no-area'> {
  const rows = await asAdmin<{ outcome: 'closed' | 'gone' | 'no-area' }>(
    loginId,
    sql`select mantle_share_close_admin(${shareId}::uuid) as outcome`,
  );
  return rows[0]!.outcome;
}

/** The snapshot a restore needs, as mantle_app_trash_act answers it. */
export type AppTrashRow = {
  seq: number;
  code: AppSnapshotCode | null;
  dbPath: string | null;
  schemaVersion: number | null;
  memberEra: boolean;
};

/** What an Admin user's act on the trash answered (mantle_app_trash_act). */
export type AppTrashOutcome =
  { outcome: 'not-found' | 'held' | 'purged' } | { outcome: 'restore'; row: AppTrashRow };

/** DELETE /api/apps/deleted/:id (purge: the rows removed inside) and
 *  POST /api/apps/deleted/:id/restore (restore: the check, and the
 *  snapshot the route restores from), as `loginId`. */
export async function adminAppTrashAct(
  loginId: string,
  appId: string,
  act: 'purge' | 'restore',
): Promise<AppTrashOutcome> {
  const rows = await asAdmin<{
    outcome: AppTrashOutcome['outcome'];
    seq: number | null;
    code: AppSnapshotCode | null;
    db_path: string | null;
    schema_version: number | null;
    member_era: boolean | null;
  }>(
    loginId,
    sql`select outcome, seq, code, db_path, schema_version, member_era
          from mantle_app_trash_act(${appId}::uuid, ${act})`,
  );
  const r = rows[0]!;
  if (r.outcome !== 'restore') return { outcome: r.outcome };
  return {
    outcome: 'restore',
    row: {
      seq: r.seq!,
      code: r.code,
      dbPath: r.db_path,
      schemaVersion: r.schema_version,
      memberEra: r.member_era === true,
    },
  };
}
