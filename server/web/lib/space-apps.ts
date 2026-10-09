/**
 * Member-built apps (team apps Phase 3): the helpers the member routes
 * (/api/member/my-apps) and the admin review routes in Apps
 * (/api/apps/members) share. The rules live in
 * @mantle/content member-space-apps.ts; these only map its refusals.
 */
import { NextResponse } from '@/server/http-compat';
import { SpaceAppError, type SpaceAppErrorCode } from '@mantle/content';
import { AppSnapshotRefusedError } from '@mantle/content/app-snapshots';
import { isUuid } from '@mantle/std';
import type { MemberCaller } from './auth';
import { auditFireAndForget, requestMetaFrom, type AuditEntry } from './audit';

const STATUS: Record<SpaceAppErrorCode, number> = {
  'not-found': 404,
  frozen: 409,
  unpublished: 409,
  'no-build': 409,
  'not-submitted': 409,
  'not-draft': 409,
  changed: 409,
  deleted: 409,
  'not-deleted': 409,
};

/** A refusal as a response with its words; anything else rethrows. A
 *  snapshot the member may not delete (a version, an automatic one,
 *  another login's) is 409 `not-yours`. */
export function spaceAppErrorResponse(err: unknown): NextResponse {
  if (err instanceof SpaceAppError) {
    return NextResponse.json(
      { ok: false, error: err.message, reason: err.code },
      { status: STATUS[err.code] },
    );
  }
  if (err instanceof AppSnapshotRefusedError) {
    return NextResponse.json(
      { ok: false, error: err.message, reason: 'not-yours' },
      { status: 409 },
    );
  }
  throw err;
}

/** The audit row of a member's change to their own app from the app (the
 *  same change over MCP writes mcp.my_app_*): the app and the entry by id,
 *  the path with its ids kept out. */
export function auditMemberApp(
  req: Request,
  member: MemberCaller,
  action: Extract<AuditEntry['action'], `member_app.${string}`>,
  detail: { appId: string; snapshotId?: string },
): void {
  auditFireAndForget({
    actorId: member.loginId,
    actorEmail: member.email,
    action,
    method: req.method,
    path: new URL(req.url).pathname.replace(/[0-9a-f-]{36}/gi, ':id'),
    ...requestMetaFrom(req),
    detail,
  });
}

/** The app id from the path, lower case, or null. */
export function spaceAppId(id: string): string | null {
  return isUuid(id) ? id.toLowerCase() : null;
}

export function spaceAppNotFound(): NextResponse {
  return NextResponse.json({ ok: false, error: 'app not found' }, { status: 404 });
}
