import { NextResponse } from '@/server/http-compat';
import type { AuthWhoami } from '@mantle/client-types';
import { sessionRole, publicLoginItself, unauthorizedRefusal } from '@/lib/auth';
import { adminFacts } from '@/lib/auth/login';
import { brainIdField } from '@/lib/brain-identity';
import { loginWorkspaces } from '@/lib/login-workspaces';
import { workspaceCaller } from '@/lib/workspaces';
import { routePolicy } from '@/lib/auth/route-declaration';
import { requestPasswordHold } from '@/lib/auth/password-hold';
import { passwordRule } from '@/lib/auth/password-rule';

export const policy = routePolicy({
  GET: {
    passwordHold: 'change-step',
    class: 'self',
    public: true,
    caller: 'publicLogin',
  },
});

/**
 * GET /api/auth/whoami: who a credential belongs to, for any role
 * (docs/mobile-companion-backend.md). The phone app holds one bearer and
 * learns here which login it is: the role, the login, its name, its shell
 * and its push prefix. Every role's shell is GET /api/shell. The roles are
 * admin and member: there are no client logins. A stranger, a dead token or a
 * role this code does not know gets 401.
 *
 * It also answers the login's workspaces, its Admin areas (empty
 * outside the Admin workspace) and whether it is the brain's anchor login
 * (`isOwner`): the same builder as GET /api/shell (lib/login-workspaces.ts),
 * so the phone's switcher needs no second call. About the login only, never
 * brain items.
 *
 * `brainId` (migration 0226) names this brain: with `loginId` it is the key a
 * device holding several logins, on several brains, files the session under,
 * and every push payload carries the same pair (lib/push/notify.ts). Left out
 * only while the database is behind the code (lib/brain-identity.ts).
 *
 * A public row (the gate lets every request in): the login is the one the
 * pipeline answers at the read (publicLoginItself). A
 * public row enters no workspace scope (the login's own rows, on the system
 * pool, 'login-self'), so the handler runs where the request runs.
 */
const ROUTES = {
  admin: { shell: '/api/shell', pushBase: '/api/push' },
  member: { shell: '/api/shell', pushBase: '/api/member/push' },
} as const;

export async function GET() {
  const login = await publicLoginItself();
  if (!login) return unauthorizedRefusal();
  // The display role (and its client routes) comes from Admin membership
  // (sessionRole); whether the login is an Admin user is adminFacts (no
  // scope here: the row's answer).
  const role = sessionRole(login);
  const body: AuthWhoami = {
    role,
    loginId: login.loginId,
    email: login.email,
    displayName: login.displayName ?? null,
    ...ROUTES[role],
    ...(await brainIdField()),
    ...(await loginWorkspaces('whoami', workspaceCaller(login), (await adminFacts(login)).admin)),
    // Only while the box password policy holds this credential (an SSO
    // session of a login whose password is no way in is never held): the
    // client's change-password step reads why and what a new password
    // needs.
    ...((await requestPasswordHold()) === 'change'
      ? { mustChangePassword: true as const, passwordRule: passwordRule() }
      : {}),
  };
  return NextResponse.json(body);
}
