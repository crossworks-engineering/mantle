import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import {
  getChangelogMarkdown,
  getLatestChangelogVersion,
  listChangelogVersions,
} from '@/lib/changelog';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'self' },
});

/**
 * GET /api/changelog[?version=x.y.z] — the CHANGELOG.md reader for the
 * zero-secret client (the file ships in the SERVER image). No version param ⇒
 * the latest entry + the full version list.
 */
export async function GET(req: Request) {
  // Owner only: the gate answered the caller and refused anyone else.
  ownerCaller();
  const requested = new URL(req.url).searchParams.get('version');

  const [versions, latest] = await Promise.all([
    listChangelogVersions(),
    getLatestChangelogVersion(),
  ]);
  const version = requested ?? latest;
  if (!version) return NextResponse.json({ versions: [], latest: null, markdown: null });
  const markdown = await getChangelogMarkdown(version);
  if (requested && markdown === null) {
    return NextResponse.json({ error: 'unknown version' }, { status: 404 });
  }
  return NextResponse.json({ versions, latest, version, markdown });
}
