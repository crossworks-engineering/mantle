/**
 * Owner-only curation of the member Dashboard's tag sections
 * (prefs.teamHubTags — see @mantle/content/team-hub `curatedTeamSections` for
 * what members get out of it).
 *
 * PUT { tags: string[] } — replace the curated list wholesale (order = section
 * order). `[]` clears curation. Tags are canonicalised (trim/lowercase/dedupe,
 * capped) by the pref projection; the response returns the stored form so the
 * UI can reconcile. Deliberately NOT validated against currently-shared tags:
 * a curated tag with no visible pages just renders nothing — the owner may
 * curate ahead of sharing.
 *
 * Session-gated — under /api/team-admin, which is NOT in PUBLIC_PATHS, so it
 * carries the owner session, never a team token.
 */
import { NextResponse } from '@/server/http-compat';
import { updateProfilePreferences } from '@mantle/content';
import { getOwnerOr401 } from '@/lib/auth';

export async function PUT(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const tags = (body as { tags?: unknown } | null)?.tags;
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) {
    return NextResponse.json({ error: 'tags must be an array of strings' }, { status: 400 });
  }

  const prefs = await updateProfilePreferences(user.id, { teamHubTags: tags });
  return NextResponse.json({ tags: prefs.teamHubTags ?? [] });
}
