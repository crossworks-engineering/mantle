import { NextResponse } from '@/server/http-compat';
import { anyLoginCaller, legacyLogin } from '@/lib/auth';
import type { Login } from '@/lib/auth/login';
import { getRequestContext } from '@/server/request-context';
import type { ApiV1Whoami } from '@mantle/client-types';

/**
 * GET /api/v1/whoami (public API v1): who the credential acts as, and, for
 * an API key, what the key may do. Every credential works here; any role.
 * About the login and the key only, never brain data.
 */
async function handleGET(login: Login) {
  const { displayName } = login;
  const key = getRequestContext()?.accessKey;
  return NextResponse.json({
    // The display role (the legacy shape's, until the role is derived).
    role: legacyLogin(login).kind,
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

/** The login the pipeline answered (A4 hand batch A). Nothing here reads
 *  the database: it runs where the request runs (A6b: it left the scope
 *  whole before, 'rule-in-query', for no read). */
export async function GET() {
  const login = anyLoginCaller();
  return handleGET(login);
}
