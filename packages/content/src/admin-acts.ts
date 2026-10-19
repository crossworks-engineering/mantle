/**
 * Four Admin acts as definers (workspaces arch plan v3.2, part c1;
 * migration 0308): a contact's sharing, Revoke all of a contact's shares,
 * sharing an item with contacts, and an entity merge. Each calls its
 * SECURITY DEFINER function in the acting login's scope (adminActTx,
 * @mantle/db), and the function checks inside that the login is an Admin
 * user with the Admin workspace in its scope (mantle_admin_act_brain); a
 * member's scope, or none, is refused there with 42501. The routes call
 * these; the content functions with an owner (contact-share-codes.ts,
 * contact-shares.ts, entity-dedup.ts) call the same SQL bodies for system
 * work, without the check.
 */
import { sql } from 'drizzle-orm';
import { adminActTx, type AppSnapshotCode } from '@mantle/db';
import { defineDomainError, findDatabaseError } from '@mantle/std';
import { contactSharingAct, type ContactSharingAction } from './contact-share-codes';
import type { ContactSharingActResult } from './contact-share-codes';
import { contactShareAct, type ContactShareActRow } from './contact-shares';
import type { CreatedContactShare } from '@mantle/client-types';

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
// loginRefused('member')), the same 403 and body.
defineDomainError(AdminActRefusedError, {
  reason: 'the login is no Admin user in the database (an Admin act refused it inside)',
  status: 403,
  body: () => ({
    error: 'forbidden',
    reason: 'member-login',
    message: 'Not available to member logins.',
  }),
});

/** adminActTx, with the definer's refusal of the login as
 *  AdminActRefusedError (any other error as it is). */
async function asAdmin<T>(loginId: string, fn: Parameters<typeof adminActTx<T>>[1]): Promise<T> {
  try {
    return await adminActTx(loginId, fn);
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

/** POST /api/contacts/:id/sharing: switch on, a new code, switch off, as
 *  `loginId` (mantle_contact_sharing_set). */
export async function adminContactSharing(
  loginId: string,
  contactId: string,
  action: ContactSharingAction,
): Promise<ContactSharingActResult> {
  return contactSharingAct(contactId, action, (codeHash) =>
    asAdmin(loginId, async (tx) => {
      const rows = (await tx.execute(
        sql`select outcome, revoked from mantle_contact_sharing_set(
              ${contactId}::uuid, ${action}, ${codeHash})`,
      )) as unknown as { outcome: string; revoked: number }[];
      return rows[0]!;
    }),
  );
}

/** DELETE /api/contacts/:id/shares: Revoke all, as `loginId`
 *  (mantle_contact_shares_revoke_all). How many; null when the id is not a
 *  contact of the brain. */
export async function adminRevokeAllContactShares(
  loginId: string,
  contactId: string,
): Promise<number | null> {
  return asAdmin(loginId, async (tx) => {
    const rows = (await tx.execute(
      sql`select mantle_contact_shares_revoke_all(${contactId}::uuid) as n`,
    )) as unknown as { n: number | null }[];
    return rows[0]?.n ?? null;
  });
}

/** POST /api/shares/contacts: one item shared with contacts, as `loginId`
 *  (mantle_share_with_contacts; its home is not checked). Throws
 *  ContactShareRefusedError when refused. */
export async function adminCreateContactShares(
  loginId: string,
  nodeId: string,
  contactIds: readonly string[],
  canWrite: boolean,
): Promise<CreatedContactShare[]> {
  return contactShareAct(contactIds, (a) =>
    asAdmin(
      loginId,
      async (tx) =>
        (await tx.execute(
          sql`select share_id::text, contact_id::text, token, refused
                from mantle_share_with_contacts(${nodeId}::uuid, ${a.contacts}::uuid[],
                       ${a.tokens}::text[], ${canWrite}, ${a.kinds}::text[])`,
        )) as unknown as ContactShareActRow[],
    ),
  );
}

/** POST /api/entities/merge: `dupId` into `canonicalId`, as `loginId`
 *  (mantle_entity_merge). False when they are one or either is missing. */
export async function adminMergeEntities(
  loginId: string,
  canonicalId: string,
  dupId: string,
): Promise<boolean> {
  return asAdmin(loginId, async (tx) => {
    const rows = (await tx.execute(
      sql`select mantle_entity_merge(${canonicalId}::uuid, ${dupId}::uuid) as ok`,
    )) as unknown as { ok: boolean }[];
    return rows[0]?.ok === true;
  });
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
  return asAdmin(loginId, async (tx) => {
    const rows = (await tx.execute(
      sql`select mantle_share_close_admin(${shareId}::uuid) as outcome`,
    )) as unknown as { outcome: 'closed' | 'gone' | 'no-area' }[];
    return rows[0]!.outcome;
  });
}

/** What "Can write" on a contact share answered
 *  (mantle_share_contact_write_set). */
export type ContactShareWriteOutcome =
  { outcome: 'ok'; contactId: string } | { outcome: 'not-contact' | 'not-found' | 'write-not-app' };

/** PATCH /api/shares/:id { canWrite } on a contact share, as `loginId`:
 *  'not-contact' when no share names a contact by this id (nothing
 *  written: the route answers it by the link's rule). */
export async function adminSetContactShareCanWrite(
  loginId: string,
  shareId: string,
  canWrite: boolean,
): Promise<ContactShareWriteOutcome> {
  return asAdmin(loginId, async (tx) => {
    const rows = (await tx.execute(
      sql`select outcome, contact::text as contact
            from mantle_share_contact_write_set(${shareId}::uuid, ${canWrite})`,
    )) as unknown as { outcome: ContactShareWriteOutcome['outcome']; contact: string | null }[];
    const r = rows[0]!;
    return r.outcome === 'ok' ? { outcome: 'ok', contactId: r.contact! } : { outcome: r.outcome };
  });
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
  return asAdmin(loginId, async (tx) => {
    const rows = (await tx.execute(
      sql`select outcome, seq, code, db_path, schema_version, member_era
            from mantle_app_trash_act(${appId}::uuid, ${act})`,
    )) as unknown as {
      outcome: AppTrashOutcome['outcome'];
      seq: number | null;
      code: AppSnapshotCode | null;
      db_path: string | null;
      schema_version: number | null;
      member_era: boolean | null;
    }[];
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
  });
}
