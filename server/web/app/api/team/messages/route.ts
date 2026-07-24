/**
 * GET /api/team/messages — the calling member's OWN thread window (ascending),
 * `?before=<iso>` pages older, `?limit=` caps the window. Serves both the /team
 * page and bearer API clients (the MS Teams adapter's read path). A member can
 * only ever read their own thread — the contact id comes from the credential,
 * never from a parameter.
 */
import { NextResponse } from '@/server/http-compat';
import { listTeamThread } from '@mantle/content';
import { resolveTeamChatCaller } from '@/lib/team-chat-gate';


export async function GET(req: Request) {
  const caller = await resolveTeamChatCaller(req);
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const url = new URL(req.url);
  const before = url.searchParams.get('before') ?? undefined;
  const limitRaw = Number(url.searchParams.get('limit'));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 50;

  const rows = await listTeamThread(caller.ownerId, caller.contactId, { before, limit });
  return NextResponse.json({
    messages: rows.map((m) => ({
      id: m.id,
      direction: m.direction,
      text: m.text,
      status: m.status,
      error: m.error,
      attachments: m.attachments,
      createdAt: m.createdAt.toISOString(),
    })),
  });
}
