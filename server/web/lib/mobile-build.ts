/**
 * The phone app's build, and the "Update the app" answer (workspaces W7e,
 * plan 7.3 and 12). An older phone app (Admin only, it calls the owner
 * routes) gets HTTP 426 for a non-Admin login, never a vague error; the
 * workspace-aware build (any login, the workspace switcher) says so with
 * the `X-Jackdaw-Mobile` request header on its sign-in calls.
 *
 * The header carries the app's build number: `27`, or the full version as
 * the store shows it (`1.15.0+27`, the number after '+'). Anything else is
 * no build at all.
 */
import { NextResponse } from '@/server/http-compat';

/** The request header the phone app sends its build in. */
export const MOBILE_BUILD_HEADER = 'x-jackdaw-mobile';

/** The first phone build that speaks the workspaces contract (any login,
 *  whoami's workspaces and areas). Builds up to 26 are Admin only. */
export const MOBILE_MIN_WORKSPACE_BUILD = 27;

/** The build number the request's header names, or null. */
export function mobileBuildOf(req: Request): number | null {
  const raw = req.headers.get(MOBILE_BUILD_HEADER)?.trim() ?? '';
  const m = /^(?:\d+\.\d+\.\d+\+)?(\d{1,9})$/.exec(raw);
  return m ? Number(m[1]) : null;
}

/** Whether the request comes from a phone build at or above the minimum. */
export function isWorkspaceMobileBuild(req: Request): boolean {
  const build = mobileBuildOf(req);
  return build !== null && build >= MOBILE_MIN_WORKSPACE_BUILD;
}

/** The 426 an older phone app gets for a non-Admin login. */
export function updateTheAppResponse(): NextResponse {
  return NextResponse.json(
    {
      error: 'Update the app to sign in with this login.',
      reason: 'update-app',
      minBuild: MOBILE_MIN_WORKSPACE_BUILD,
    },
    { status: 426 },
  );
}
