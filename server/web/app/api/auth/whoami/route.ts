import { NextResponse } from '@/server/http-compat';
import type { AuthWhoami } from '@mantle/client-types';
import { getLoginOr401 } from '@/lib/auth';
import { brainIdField } from '@/lib/brain-identity';
import { ruleInQuery } from '@/lib/auth/rule-in-query';
import { loginWorkspaces } from '@/lib/login-workspaces';

/**
 * GET /api/auth/whoami: who a credential belongs to, for any role
 * (docs/mobile-companion-backend.md). The phone app holds one bearer and
 * learns here which login it is: the role, the login, its name, its shell
 * and its push prefix. Since workspaces W5c every role's shell is GET
 * /api/shell (the old member and client shells answer 410), and a client's
 * push routes answer 410 (the client portal is gone). A stranger, a dead
 * token or a role this code does not know gets 401.
 *
 * Since W7e it also answers the login's workspaces, its Admin areas (empty
 * outside the Admin workspace) and whether it is the brain's anchor login
 * (`isOwner`): the same builder as GET /api/shell (lib/login-workspaces.ts),
 * so the phone's switcher needs no second call. About the login only, never
 * brain items.
 *
 * `brainId` (migration 0226) names this brain: with `loginId` it is the key a
 * device holding several logins, on several brains, files the session under,
 * and every push payload carries the same pair (lib/push/notify.ts). Left out
 * only while the database is behind the code (lib/brain-identity.ts).
 */
const ROUTES = {
  admin: { shell: '/api/shell', pushBase: '/api/push' },
  member: { shell: '/api/shell', pushBase: '/api/member/push' },
  client: { shell: '/api/shell', pushBase: '/api/client/push' },
} as const;

async function handleGET() {
  const login = await getLoginOr401();
  if (login instanceof NextResponse) return login;
  const displayName =
    login.kind === 'admin'
      ? login.user.actor.displayName
      : login.kind === 'member'
        ? login.member.displayName
        : login.client.displayName;
  const body: AuthWhoami = {
    role: login.kind,
    loginId: login.loginId,
    email: login.email,
    displayName: displayName ?? null,
    ...ROUTES[login.kind],
    ...(await brainIdField()),
    ...(await loginWorkspaces('whoami', login)),
  };
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
}

export const GET = ruleInQuery(handleGET);
