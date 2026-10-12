/**
 * Former client logins (workspaces W8a fix round 1). There is no client
 * login role since migration 0272; the client logins it ended are listed in
 * `archive_client_logins` and stay former clients:
 *
 *  - an admin cannot enable one again (it stays the disabled member row 0272
 *    left, so what it wrote keeps its author), and the login bridge gives
 *    one no workspace (0272);
 *  - an invite or a new login on the email or the contact of one is
 *    refused, so a former client never comes back as a member by itself.
 *    Clients are set up by hand (owner rule 21.9);
 *  - what one wrote stays client-sourced (packages/tools/src/client-sourced.ts).
 *
 * The admin pool reads the archive (management routes and the public
 * invite routes run there); no level or workspace role is granted it.
 */
import { eq, sql } from 'drizzle-orm';
import { archiveClientLogins, db } from '@mantle/db';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = Tx | typeof db;

/** What an admin reads when enabling a former client login is refused. */
export const FORMER_CLIENT_ENABLE_MESSAGE =
  'This was a client login. A former client login stays disabled and cannot be enabled again.';

/** What an admin reads when an invite or a new login on a former client's
 *  email is refused. */
export const FORMER_CLIENT_EMAIL_MESSAGE =
  'That email belonged to a client login. A former client cannot be invited or given a new login.';

/** What an admin reads when an invite or a new login linked to a former
 *  client's contact is refused (W8a fix round 2). */
export const FORMER_CLIENT_CONTACT_MESSAGE =
  'That contact belonged to a client login. A former client cannot be invited or given a new login.';

/** Whether `loginId` was a client login (archived by 0272). */
export async function isFormerClientLogin(loginId: string, exec: Exec = db): Promise<boolean> {
  const [row] = await exec
    .select({ id: archiveClientLogins.loginId })
    .from(archiveClientLogins)
    .where(eq(archiveClientLogins.loginId, loginId))
    .limit(1);
  return !!row;
}

/** Whether `email` (any case) was the email of a client login (archived by
 *  0272), whether or not that login still exists. */
export async function isFormerClientEmail(email: string, exec: Exec = db): Promise<boolean> {
  const wanted = email.trim().toLowerCase();
  if (!wanted) return false;
  const [row] = await exec
    .select({ id: archiveClientLogins.loginId })
    .from(archiveClientLogins)
    .where(sql`lower(${archiveClientLogins.email}) = ${wanted}`)
    .limit(1);
  return !!row;
}

/** Whether `contactId` was the contact of a client login (archived by 0272),
 *  whether or not that login still exists (W8a fix round 2). */
export async function isFormerClientContact(contactId: string, exec: Exec = db): Promise<boolean> {
  const [row] = await exec
    .select({ id: archiveClientLogins.loginId })
    .from(archiveClientLogins)
    .where(eq(archiveClientLogins.contactId, contactId))
    .limit(1);
  return !!row;
}
