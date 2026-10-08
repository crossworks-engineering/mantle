/**
 * Member-built apps (team apps Phase 3): the helpers the member routes
 * (/api/member/my-apps) and the admin review routes
 * (/api/team-admin/app-submissions) share. The rules live in
 * @mantle/content member-space-apps.ts; these only map its refusals.
 */
import { NextResponse } from '@/server/http-compat';
import { SpaceAppError, type SpaceAppErrorCode } from '@mantle/content';
import { isUuid } from '@mantle/std';

const STATUS: Record<SpaceAppErrorCode, number> = {
  'not-found': 404,
  frozen: 409,
  unpublished: 409,
  'no-build': 409,
  'not-submitted': 409,
  'not-draft': 409,
  changed: 409,
};

/** A refusal as a response with its words; anything else rethrows. */
export function spaceAppErrorResponse(err: unknown): NextResponse {
  if (err instanceof SpaceAppError) {
    return NextResponse.json(
      { ok: false, error: err.message, reason: err.code },
      { status: STATUS[err.code] },
    );
  }
  throw err;
}

/** The app id from the path, lower case, or null. */
export function spaceAppId(id: string): string | null {
  return isUuid(id) ? id.toLowerCase() : null;
}

export function spaceAppNotFound(): NextResponse {
  return NextResponse.json({ ok: false, error: 'app not found' }, { status: 404 });
}
