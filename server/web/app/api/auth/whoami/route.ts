import { NextResponse } from '@/server/http-compat';
import { getLoginOr401 } from '@/lib/auth';

/**
 * GET /api/auth/whoami: who a credential belongs to, for any role
 * (docs/mobile-companion-backend.md, "Three roles on the phone"). The phone
 * app holds one bearer and must learn which of the three shells to call;
 * before this it had to try each. About the login only, never brain data:
 * the role, the login, its name, and the two route prefixes that differ per
 * role. A stranger, a dead token or a role this code does not know gets 401.
 */
const ROUTES = {
  admin: { shell: '/api/shell', pushBase: '/api/push' },
  member: { shell: '/api/member/shell', pushBase: '/api/member/push' },
  client: { shell: '/api/client/shell', pushBase: '/api/client/push' },
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
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
