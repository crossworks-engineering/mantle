import { NextResponse, type NextRequest } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { assistantMessagesBefore, resolveAssistantAgent } from '@/lib/assistant';

/**
 * Older page of assistant messages for scroll-up lazy loading. Returns up
 * to `limit` (default 100) messages before the `before` ISO cursor, scoped
 * to the selected agent's thread. Owner-scoped via getOwnerOr401 (a JSON API —
 * 401s an unauthenticated/expired client rather than redirecting to /login).
 */

const PAGE = 100;

export async function GET(req: NextRequest) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { searchParams } = new URL(req.url);

  // `before` is the load-older pagination cursor. Absent means "the latest page"
  // (syncLatest on mount / after a foreign turn), so default to now; only a
  // PRESENT-but-unparseable value is a 400.
  const beforeParam = searchParams.get('before');
  if (beforeParam && Number.isNaN(Date.parse(beforeParam))) {
    return NextResponse.json({ error: 'invalid `before` timestamp' }, { status: 400 });
  }
  const before = beforeParam ?? new Date().toISOString();
  const limitParam = Number.parseInt(searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : PAGE;
  const slug = searchParams.get('agent') ?? undefined;

  const agent = await resolveAssistantAgent(user.id, slug);
  if (!agent) return NextResponse.json({ messages: [] });

  // Per-agent thread — no cross-agent or legacy fold-in. See migration
  // 0049 + the assistant_messages schema header.
  const messages = await assistantMessagesBefore(user.id, agent.id, before, limit);
  return NextResponse.json({ messages }, { headers: { 'Cache-Control': 'no-store' } });
}
