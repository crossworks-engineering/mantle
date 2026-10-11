import { NextResponse } from '@/server/http-compat';
import { getLoginOr401 } from '@/lib/auth';
import { brainIdField } from '@/lib/brain-identity';

/**
 * GET /api/auth/whoami: who a credential belongs to, for any role
 * (docs/mobile-companion-backend.md, "Three roles on the phone"). The phone
 * app holds one bearer and must learn which of the three shells to call;
 * before this it had to try each. About the login only, never brain data:
 * the role, the login, its name, its shell and its push prefix. Since
 * workspaces W5c every role's shell is GET /api/shell (the old member and
 * client shells answer 410), and a client's push routes answer 410 (the
 * client portal is gone). A stranger, a dead token or a role this code does
 * not know gets 401.
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

export async function GET() {
  const login = await getLoginOr401();
  if (login instanceof NextResponse) return login;
  const displayName =
    login.kind === 'admin'
      ? login.user.actor.displayName
      : login.kind === 'member'
        ? login.member.displayName
        : login.client.displayName;
  return NextResponse.json(
    {
      role: login.kind,
      loginId: login.loginId,
      email: login.email,
      displayName,
      ...ROUTES[login.kind],
      ...(await brainIdField()),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
