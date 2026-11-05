/**
 * The rows of SCIM (migration 0359, docs/scim.md): the logins a provider
 * may see, the logins it manages (scim_users) and the logins it creates.
 *
 * The provider sees every login but the original account (the emergency
 * admin stays out of its reach) and a row with a role this code does not
 * know. Each write runs at the full-route spot login-credential: a new
 * login's row is a credential row (docs/runtime-role.md), and scim_users
 * is read only by the narrow role.
 *
 * Called only while SCIM is on: with the token unset no route reaches here.
 */
import { LOGIN_ROLES } from '@mantle/client-types/role-names';
import type { SQL } from 'drizzle-orm';
import {
  and,
  asc,
  authUsers,
  db,
  eq,
  inArray,
  onFullSystemRoute,
  scimUsers,
  sql,
} from '@mantle/db';
import type { ScimLogin } from './shapes';

/** The logins SCIM may see: not the original account, a known role. */
const visible = (): SQL =>
  and(eq(authUsers.isOwner, false), inArray(authUsers.role, [...LOGIN_ROLES]))!;

const loginColumns = {
  id: authUsers.id,
  email: authUsers.email,
  displayName: authUsers.displayName,
  disabledAt: authUsers.disabledAt,
  createdAt: authUsers.createdAt,
  externalId: scimUsers.externalId,
};

type Row = {
  id: string;
  email: string;
  displayName: string | null;
  disabledAt: Date | null;
  createdAt: Date;
  externalId: string | null;
};

const toLogin = (r: Row): ScimLogin => ({
  id: r.id,
  email: r.email,
  displayName: r.displayName,
  disabled: r.disabledAt !== null,
  externalId: r.externalId,
  createdAt: r.createdAt,
});

async function selectLogins(where: SQL, offset = 0, limit = 1): Promise<ScimLogin[]> {
  const rows = await db
    .select(loginColumns)
    .from(authUsers)
    .leftJoin(scimUsers, eq(scimUsers.loginId, authUsers.id))
    .where(and(visible(), where))
    .orderBy(asc(authUsers.createdAt), asc(authUsers.id))
    .offset(offset)
    .limit(limit);
  return rows.map(toLogin);
}

/** The login with this id, if SCIM may see it. */
export async function scimLoginById(id: string): Promise<ScimLogin | null> {
  return (await selectLogins(eq(authUsers.id, id)))[0] ?? null;
}

/** The login with this email (any case), if SCIM may see it: the one
 *  match on a name (plan section 9.3). */
export async function scimLoginByUserName(email: string): Promise<ScimLogin | null> {
  return (await selectLogins(sql`lower(${authUsers.email}) = lower(${email})`))[0] ?? null;
}

/** The login the provider named by its externalId, if SCIM may see it. */
export async function scimLoginByExternalId(externalId: string): Promise<ScimLogin | null> {
  return (await selectLogins(eq(scimUsers.externalId, externalId)))[0] ?? null;
}

/** A page of the logins SCIM may see, and how many there are. */
export async function scimLoginPage(
  offset: number,
  limit: number,
): Promise<{ logins: ScimLogin[]; total: number }> {
  const [totalRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(authUsers)
    .where(visible());
  const logins = limit > 0 ? await selectLogins(sql`true`, offset, limit) : [];
  return { logins, total: Number(totalRow?.n ?? 0) };
}

/** Whether any login holds this email (any case), the original account
 *  included: a new login never shares one. */
export async function emailTaken(email: string): Promise<boolean> {
  const [row] = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(sql`lower(${authUsers.email}) = lower(${email})`)
    .limit(1);
  return row !== undefined;
}

/**
 * A login the provider creates, with its scim_users row, in one
 * transaction: a member, with no password (it signs in through company
 * sign-in once an admin lets it, or with a password an admin sets) and no
 * workspace (it reaches nothing until an admin adds it). Never an admin.
 * Errors (a unique violation) are thrown as they are, after the rollback.
 */
export async function createScimLogin(row: {
  id: string;
  email: string;
  displayName: string | null;
  externalId: string | null;
  disabled: boolean;
}): Promise<void> {
  await onFullSystemRoute('login-credential', () =>
    db.transaction(async (tx) => {
      await tx.insert(authUsers).values({
        id: row.id,
        email: row.email,
        passwordHash: '',
        displayName: row.displayName,
        isOwner: false,
        role: 'member',
        contactId: null,
        disabledAt: row.disabled ? new Date() : null,
      });
      await tx.insert(scimUsers).values({ loginId: row.id, externalId: row.externalId });
    }),
  );
}

/**
 * Mark the login as the provider's (its scim_users row), and set its
 * externalId when `externalId` is given (null clears it). The first write
 * of the provider to a login it found by userName makes the row.
 */
export async function linkScimLogin(loginId: string, externalId?: string | null): Promise<void> {
  const set =
    externalId === undefined ? { updatedAt: sql`now()` } : { externalId, updatedAt: sql`now()` };
  await onFullSystemRoute('login-credential', () =>
    db
      .insert(scimUsers)
      .values({ loginId, externalId: externalId ?? null })
      .onConflictDoUpdate({ target: scimUsers.loginId, set }),
  );
}

/** How many logins the provider manages, and how many of them are
 *  disabled (the users area's status line). */
export async function scimCounts(): Promise<{ managed: number; disabled: number }> {
  const [row] = await db
    .select({
      managed: sql<number>`count(*)`,
      disabled: sql<number>`count(*) filter (where ${authUsers.disabledAt} is not null)`,
    })
    .from(scimUsers)
    .innerJoin(authUsers, eq(authUsers.id, scimUsers.loginId));
  return { managed: Number(row?.managed ?? 0), disabled: Number(row?.disabled ?? 0) };
}
