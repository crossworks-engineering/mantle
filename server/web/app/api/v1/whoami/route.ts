import { NextResponse } from '@/server/http-compat';
import { getLoginOr401 } from '@/lib/auth';
import { getRequestContext } from '@/server/request-context';

/**
 * GET /api/v1/whoami (public API v1): who the credential acts as, and, for
 * an API key, what the key may do. Every credential works here; any role.
 * About the login and the key only, never brain data.
 */
export async function GET() {
  const login = await getLoginOr401();
  if (login instanceof NextResponse) return login;
  const displayName =
    login.kind === 'admin'
      ? login.user.actor.displayName
      : login.kind === 'member'
        ? login.member.displayName
        : login.client.displayName;
  const key = getRequestContext()?.accessKey;
  return NextResponse.json(
    {
      role: login.kind,
      loginId: login.loginId,
      email: login.email,
      displayName,
      key: key
        ? {
            id: key.id,
            prefix: `mtlk_${key.prefix}`,
            name: key.name,
            access: key.access,
            areas: key.areas,
          }
        : null,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
