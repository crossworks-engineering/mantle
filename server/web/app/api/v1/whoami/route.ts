import { NextResponse } from '@/server/http-compat';
import { anyLoginCaller, sessionRole } from '@/lib/auth';
import type { Login } from '@/lib/auth/login';
import { getRequestContext } from '@/server/request-context';
import type { ApiV1Whoami } from '@mantle/client-types';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'content', open: 'any', keyArea: 'self' },
});

/**
 * GET /api/v1/whoami (public API v1): who the credential acts as, and, for
 * an API key, what the key may do. Every credential works here; any role.
 * About the login and the key only, never brain data.
 */
async function handleGET(login: Login) {
  const { displayName } = login;
  const key = getRequestContext()?.accessKey;
  return NextResponse.json({
    // The display role (sessionRole: from Admin membership).
    role: sessionRole(login),
    loginId: login.loginId,
    email: login.email,
    displayName,
    key: key
      ? {
          id: key.id,
          prefix: `mtlk_${key.prefix}`,
          name: key.name,
          access: key.access,
          areas: key.areas ? [...key.areas] : null,
        }
      : null,
  } satisfies ApiV1Whoami);
}

/** The login the pipeline answered. Nothing here reads the database: it
 *  runs where the request runs. */
export async function GET() {
  const login = anyLoginCaller();
  return handleGET(login);
}
