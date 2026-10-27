import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import type { HomeDeskState } from '@mantle/client-types';
import { anyLoginCaller } from '@/lib/auth';
import { loadHomeDesk, saveHomeDeskIfVersion, validateHomeDeskWrite } from '@mantle/content';
import { readJson } from '@/lib/read-body';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'self', scope: null, open: 'any' },
  PUT: {
    class: 'self',
    scope: null,
    open: 'any',
    item: { none: "the login's own things, not an item" },
  },
});

/**
 * The login's Desk (where each widget and desk icon sits, and the desk's
 * settings), on its own profile row so it follows the login across browsers
 * and devices. Its own route, not a field of the shell: the client reads it
 * when the Desk opens and when the window comes back, and saves it here.
 *
 *   GET -> 200 { homeDesk, version }       (null and 0 until one is saved)
 *   PUT { homeDesk, version, loginId }
 *       -> 200 { homeDesk, version: version + 1 }  when the stored version
 *                                                  equals the one sent
 *       -> 409 { homeDesk, version }               the stored desk, when
 *                                                  another device saved since
 *       -> 403 { error, code: 'login-mismatch' }   when `loginId` is not the
 *                                                  login of this session
 *
 * The save is one conditional UPDATE on the version (saveHomeDeskIfVersion),
 * so of two saves sent with the same version exactly one lands. Validation
 * is the write side of the shared projection (validateHomeDeskWrite: shape
 * and size only, the client owns what a widget is), strict: a desk the
 * projection would change is a 400, never a silent clear or a partial save.
 * The body is read up to 64 KB, twice the stored cap (a larger one is a 413).
 *
 * The body names the login the desk was arranged as (`loginId`), and a save
 * for any other login is refused, so a desk is never saved over another
 * login's. A browser holding several logins can switch the one in use from
 * another tab; the desk on screen here still belongs to the first, and its
 * next save carries that login's id under the other's credential. A 403
 * with a code of its own: the client stops saving for the visit, and
 * nobody's session ended.
 *
 * Open to every login (`open: 'any'`, anyLoginCaller), a member as an Admin
 * user: the desk is the login's own. Both run in the login's scope, where
 * the profile rules hold it to the login's own row (mantle_profile_writable,
 * 0302, on write); the keys it names (`homeDesk`, `homeDeskVersion`) are
 * personal, so nothing reaches the brain's row. An API key never gets here
 * (keys reach /api/v1 only: access-key-gate), nor a peer or a share link (no
 * login).
 */
export async function GET() {
  const login = anyLoginCaller();
  const state: HomeDeskState = await loadHomeDesk(login.loginId);
  return NextResponse.json(state);
}

const Body = z.object({
  homeDesk: z.unknown(),
  // Optional here so a body naming no login is the 403 below, as one
  // naming another is.
  loginId: z.unknown().optional(),
  version: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER - 1),
});
const BODY_MAX_BYTES = 64 * 1024;

export async function PUT(req: Request) {
  const login = anyLoginCaller();
  const parsed = Body.safeParse(await readJson(req, { maxBytes: BODY_MAX_BYTES }));
  const homeDesk = parsed.success ? validateHomeDeskWrite(parsed.data.homeDesk) : undefined;
  if (!parsed.success || !homeDesk) {
    return NextResponse.json(
      { error: 'homeDesk (a v1 desk) and version (a whole number) required' },
      { status: 400 },
    );
  }
  if (parsed.data.loginId !== login.loginId) {
    return NextResponse.json(
      { error: 'loginId is not the login of this session', code: 'login-mismatch' },
      { status: 403 },
    );
  }
  const saved = await saveHomeDeskIfVersion(login.loginId, homeDesk, parsed.data.version);
  const state: HomeDeskState = { homeDesk: saved.homeDesk, version: saved.version };
  return NextResponse.json(state, { status: saved.ok ? 200 : 409 });
}
