import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { assistantConversations } from '@/lib/assistant-inbox';

/**
 * GET /api/assistant/conversations — the inbox for the mobile companion: one row
 * per chat-capable agent with its latest-message preview and unread count.
 * Owner-gated, so it works with a mobile bearer token.
 */
export async function GET() {
  const owner = await getOwnerOr401();
  if (owner instanceof NextResponse) return owner;
  const conversations = await assistantConversations(owner.id);
  return NextResponse.json({ conversations });
}
