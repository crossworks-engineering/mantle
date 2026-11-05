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
  isNull,
  liveWorkspaceSql,
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

/**
 * The enabled login with this email (any case), if SCIM may see it: the
 * one match on a name (plan section 9.3). A disabled login is found by its
 * id or its externalId only, so an address handed on to a new person never
 * finds a leaver's login (the new person's create answers 409, and an admin
 * decides), and a provider that starts its sync again still finds everyone
 * active by name.
 */
export async function scimLoginByUserName(email: string): Promise<ScimLogin | null> {
  const where = and(sql`lower(${authUsers.email}) = lower(${email})`, isNull(authUsers.disabledAt));
  return (await selectLogins(where!))[0] ?? null;
}

/** The login the provider named by its externalId, if SCIM may see it. */
export async function scimLoginByExternalId(externalId: string): Promise<ScimLogin | null> {
  return (await selectLogins(eq(scimUsers.externalId, externalId)))[0] ?? null;
}

/**
 * A page of the enabled logins SCIM may see, and how many there are: the
 * list a provider imports from (Okta's Import Users) holds no disabled
 * login, by the same rule as the userName filter, so an import never
 * matches a new person to a leaver's login by email.
 */
export async function scimLoginPage(
  offset: number,
  limit: number,
): Promise<{ logins: ScimLogin[]; total: number }> {
  const enabled = isNull(authUsers.disabledAt);
  const [totalRow] = await db
    .select({ n: sql<number>`count(*)` })
    .from(authUsers)
    .where(and(visible(), enabled));
  const logins = limit > 0 ? await selectLogins(enabled, offset, limit) : [];
  return { logins, total: Number(totalRow?.n ?? 0) };
}

type Tx = { execute: (q: SQL) => PromiseLike<ArrayLike<unknown>> };

/**
 * Inside the enable's own transaction: lock the login row and say whether
 * its disable is still the provider's own and it is still no Admin user,
 * so an admin's disable, or an add to Admin, made since the provider's
 * check always wins.
 */
export async function stillDisabledByScim(tx: Tx, loginId: string): Promise<boolean> {
  const own = await tx.execute(sql`select 1 from auth.users u
    join public.scim_users s on s.login_id = u.id
    where u.id = ${loginId} and u.disabled_at = s.scim_disabled_at
    for update of u`);
  if (own.length === 0) return false;
  // Read under the lock: an add to Admin writes this login's row (its role
  // column), so it waits for the lock and cannot slip in after this read.
  const admin = await tx.execute(sql`select 1 from public.workspace_users wu
    join public.workspaces w on w.id = wu.workspace_id
    where wu.login_id = ${loginId} and w.is_admin and ${liveWorkspaceSql('w')}`);
  return admin.length === 0;
}

/**
 * Inside the disable's own transaction: lock the login row and say whether
 * it is still enabled. An admin's disable made since the provider's read
 * stays the admin's (the provider then neither rewrites it nor records it
 * as its own).
 */
export async function stillEnabled(tx: Tx, loginId: string): Promise<boolean> {
  const rows = await tx.execute(sql`select 1 from auth.users u
    where u.id = ${loginId} and u.disabled_at is null
    for update of u`);
  return rows.length > 0;
}

/**
 * The one login a company sign-in may link by the provider's object id
 * (`objectId`, compared without case): a login SCIM made (never one it
 * matched by email), enabled, not the original account, no Admin user, of
 * a role that signs in, with its session epoch for the link's check. Null
 * when none or more than one login holds that externalId.
 */
export async function scimLinkCandidate(
  objectId: string,
): Promise<{ id: string; email: string; sessionEpoch: number } | null> {
  const rows = await db
    .select({ id: authUsers.id, email: authUsers.email, sessionEpoch: authUsers.sessionEpoch })
    .from(scimUsers)
    .innerJoin(authUsers, eq(authUsers.id, scimUsers.loginId))
    .where(
      and(
        visible(),
        sql`lower(${scimUsers.externalId}) = lower(${objectId})`,
        eq(scimUsers.madeByScim, true),
        isNull(authUsers.disabledAt),
        sql`not exists (select 1 from "public"."workspace_users" wu
          join "public"."workspaces" w on w.id = wu.workspace_id
          where wu.login_id = ${authUsers.id} and w.is_admin and ${liveWorkspaceSql('w')})`,
      ),
    )
    .limit(2);
  return rows.length === 1 ? rows[0]! : null;
}

/** The brain's original account (the anchor), or null on a box not set
 *  up yet: SCIM answers nothing there, so a provider's first sync never
 *  takes the first login's place. */
export async function brainOwnerId(): Promise<string | null> {
  const [row] = await db
    .select({ id: authUsers.id })
    .from(authUsers)
    .where(eq(authUsers.isOwner, true))
    .limit(1);
  return row?.id ?? null;
}

/**
 * What an enable or a rename by the provider asks of a login: `own`,
 * whether its disable is the one the provider made (its disabled_at is
 * still the one scim_users recorded), and `admin`, whether it is an Admin
 * user (Admin membership, disabled or not). The provider enables only an
 * own disable of a login that is no Admin user, and renames no Admin user.
 */
export async function scimLoginFacts(loginId: string): Promise<{ own: boolean; admin: boolean }> {
  const [row] = await db
    .select({
      own: sql<boolean>`(${authUsers.disabledAt} = ${scimUsers.scimDisabledAt})`,
      // A user of the live Admin workspace, the login disabled or not
      // (loginIsAdmin asks an enabled login: a disabled one is the case here).
      admin: sql<boolean>`exists (select 1 from "public"."workspace_users" wu
        join "public"."workspaces" w on w.id = wu.workspace_id
        where wu.login_id = ${authUsers.id} and w.is_admin and ${liveWorkspaceSql('w')})`,
    })
    .from(authUsers)
    .leftJoin(scimUsers, eq(scimUsers.loginId, authUsers.id))
    .where(eq(authUsers.id, loginId))
    .limit(1);
  return { own: row?.own === true, admin: row?.admin === true };
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
  // A login made disabled is the provider's own disable.
  const disabledAt = row.disabled ? new Date() : null;
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
        disabledAt,
      });
      await tx.insert(scimUsers).values({
        loginId: row.id,
        externalId: row.externalId,
        scimDisabledAt: disabledAt,
        madeByScim: true,
      });
    }),
  );
}

/**
 * The provider's row of a login (scim_users), made the first time the
 * provider writes to it (a login it found by userName). `externalId`, when
 * given, is set (the service sets it once). `disable`: a Date records it as
 * the provider's own disable (the disabled_at its disable wrote), 'clear'
 * forgets it (after the provider enabled the login).
 */
export async function writeScimRow(
  loginId: string,
  opts: { externalId?: string | null; disable?: Date | 'clear' } = {},
): Promise<void> {
  const mark = opts.disable === 'clear' ? null : opts.disable;
  await onFullSystemRoute('login-credential', () =>
    db
      .insert(scimUsers)
      .values({ loginId, externalId: opts.externalId ?? null, scimDisabledAt: mark ?? null })
      .onConflictDoUpdate({
        target: scimUsers.loginId,
        set: {
          updatedAt: sql`now()`,
          ...(opts.externalId !== undefined ? { externalId: opts.externalId } : {}),
          ...(mark !== undefined ? { scimDisabledAt: mark } : {}),
        },
      }),
  );
}

/** How many logins the provider manages, how many of them are disabled,
 *  and how many enabled ones it has given no externalId (found only by
 *  their email if the provider ever matches again: map one). The users
 *  area's status line. */
export async function scimCounts(): Promise<{
  managed: number;
  disabled: number;
  noExternalId: number;
}> {
  const [row] = await db
    .select({
      managed: sql<number>`count(*)`,
      disabled: sql<number>`count(*) filter (where ${authUsers.disabledAt} is not null)`,
      noExternalId: sql<number>`count(*) filter (where ${authUsers.disabledAt} is null
        and ${scimUsers.externalId} is null)`,
    })
    .from(scimUsers)
    .innerJoin(authUsers, eq(authUsers.id, scimUsers.loginId));
  return {
    managed: Number(row?.managed ?? 0),
    disabled: Number(row?.disabled ?? 0),
    noExternalId: Number(row?.noExternalId ?? 0),
  };
}
