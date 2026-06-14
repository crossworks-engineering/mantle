import { NextResponse } from 'next/server';
import { requireOwner } from '@/lib/auth';
import { assistantConversations } from '@/lib/assistant-inbox';

/**
 * GET /api/assistant/conversations — the inbox for the mobile companion: one row
 * per chat-capable agent with its latest-message preview and unread count.
 * Owner-gated, so it works with a mobile bearer token.
 */
export async function GET() {
  const user = await requireOwner();
  const conversations = await assistantConversations(user.id);
  return NextResponse.json({ conversations });
}
