/**
 * Members' apps in the admin's Apps screen (workspace review pattern,
 * 2026-10-09): the helpers the /api/apps/members/** routes share. What an
 * admin may reach is the content layer's rule (getMemberAppForReview:
 * submitted, or shared with the team; never a private draft, never a draft
 * source). Every route is admin only (getOwnerOr401) and answers an id it may
 * not reach exactly like an id that does not exist.
 */
import { NextResponse } from '@/server/http-compat';
import { getMemberAppForReview, type MemberAppForReview } from '@mantle/content';
import type { ReviewTester } from '@mantle/content/app-review-test';
import type { SessionUser } from '@/lib/auth';
import { spaceAppId, spaceAppNotFound } from '@/lib/space-apps';

/** The app an admin may review, or the plain 404. */
export async function reviewAppOr404(rawId: string): Promise<MemberAppForReview | NextResponse> {
  const id = spaceAppId(rawId);
  const app = id ? await getMemberAppForReview(id) : null;
  return app ?? spaceAppNotFound();
}

/** What the browser gets: no space id, no storage keys, no manifest. */
export function reviewAppDto(app: MemberAppForReview) {
  const { spaceId: _space, publishedBuild: _build, manifest: _manifest, ...dto } = app;
  return dto;
}

/** The admin who tests: the acting login, never the anchor. */
export function reviewTester(user: SessionUser): ReviewTester {
  return { loginId: user.actor.id };
}
