import { NextResponse } from 'next/server';
import { getOwnerOr401 } from '@/lib/auth';
import {
  getChangelogMarkdown,
  getLatestChangelogVersion,
  listChangelogVersions,
} from '@/lib/changelog';

/**
 * GET /api/changelog[?version=x.y.z] — the CHANGELOG.md reader for the
 * zero-secret client (the file ships in the SERVER image). No version param ⇒
 * the latest entry + the full version list.
 */
export async function GET(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
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
