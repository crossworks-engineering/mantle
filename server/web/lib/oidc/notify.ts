/**
 * Tell a login that a company sign-in link was made on it, as a key made
 * is told (access-keys-notify.ts): a link signs a provider account in as
 * the login, so one made from a stolen session must not go unseen. A fixed
 * text: never the account's subject or any provider value. Best effort: a
 * failure is logged and the link stays; the auth.oidc_linked audit row is
 * written either way.
 */
import { authUsers, db, eq } from '@mantle/db';
import { errorMessage } from '@mantle/std';
import { log } from '@mantle/tracing';
import { noticeToLogin } from '@/lib/access-keys-notify';
import { loginIsAdmin } from '@/lib/auth/admin-seat';
import { loadAnchorId } from '@/lib/auth/login-row';

export const LINK_MADE_TEXT =
  'A company sign-in account was linked to your login: it can now sign in as you. If this was not you, ask an admin to remove the link and end your sessions.';

/** Send the notice. Never throws. */
export async function notifyLinkMade(loginId: string): Promise<void> {
  try {
    const ownerId = await loadAnchorId();
    if (!ownerId) return;
    const [row] = await db
      .select({ admin: loginIsAdmin(loginId) })
      .from(authUsers)
      .where(eq(authUsers.id, loginId))
      .limit(1);
    if (!row) return;
    await noticeToLogin({
      ownerId,
      loginId,
      admin: row.admin === true,
      text: LINK_MADE_TEXT,
      deepLink: '/settings/profile',
      collapseKey: 'oidc-link-made',
    });
  } catch (err) {
    log('auth').warn(`company sign-in: the link-made notice failed: ${errorMessage(err)}`);
  }
}
