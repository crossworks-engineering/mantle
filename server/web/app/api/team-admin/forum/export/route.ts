/**
 * Admin only: the Forum archive (member logins, Phase 6).
 *
 *   GET  /api/team-admin/forum/export -> 200 { unexported }: topics with no
 *        archive page yet (the button shows while this is above 0).
 *   POST /api/team-admin/forum/export -> 200 ForumExportResult (status
 *        'done'); 409 { error, reason: 'busy' } while another run holds the
 *        lock (the api server's boot task, or a second click).
 *
 * Both this route and the api server's boot task call `exportForumArchive`
 * (packages/content/src/forum/export.ts); it is idempotent, so pressing the
 * button again only picks up what is left (a topic deferred because an
 * agent reply was still in flight). No LLM or embedding work: the pages are
 * exempt from extraction and the filed files are metadata-only.
 */
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { countUnexportedForumTopics, exportForumArchive } from '@mantle/content';
import { errorMessage } from '@mantle/std';

export async function GET() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  return NextResponse.json({ unexported: await countUnexportedForumTopics(user.id) });
}

export async function POST() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  try {
    const result = await exportForumArchive(user.id);
    if (result.status === 'busy') {
      return NextResponse.json(
        { error: 'The forum export is already running. Try again in a minute.', reason: 'busy' },
        { status: 409 },
      );
    }
    return NextResponse.json(result);
  } catch (err) {
    console.error('[team-admin/forum/export]', errorMessage(err));
    return NextResponse.json(
      { error: 'The forum export failed. The server log has the details.' },
      { status: 500 },
    );
  }
}
