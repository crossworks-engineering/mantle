import { NextResponse, type NextRequest } from 'next/server';
import { requireOwner } from '@/lib/auth';
import { assistantMessagesBefore, resolveAssistantAgent } from '@/lib/assistant';

/**
 * Older page of assistant messages for scroll-up lazy loading. Returns up
 * to `limit` (default 100) messages before the `before` ISO cursor, scoped
 * to the selected agent's thread. Owner-scoped via requireOwner.
 */
export const dynamic = 'force-dynamic';

const PAGE = 100;

export async function GET(req: NextRequest) {
  const user = await requireOwner();
  const { searchParams } = new URL(req.url);

  const before = searchParams.get('before');
  if (!before || Number.isNaN(Date.parse(before))) {
    return NextResponse.json({ error: 'valid `before` timestamp required' }, { status: 400 });
  }
  const limitParam = Number.parseInt(searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : PAGE;
  const slug = searchParams.get('agent') ?? undefined;

  const agent = await resolveAssistantAgent(user.id, slug);
  if (!agent) return NextResponse.json({ messages: [] });

  // Mirror the page's thread-scoping: default assistant/responder also
  // includes legacy (pre-agentId) rows; custom agents get a clean thread.
  const includeLegacy = agent.role === 'assistant' || agent.role === 'responder';
  const messages = await assistantMessagesBefore(user.id, before, limit, {
    agentId: agent.id,
    includeLegacy,
  });
  return NextResponse.json({ messages }, { headers: { 'Cache-Control': 'no-store' } });
}
