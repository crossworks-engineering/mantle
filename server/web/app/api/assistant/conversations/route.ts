import { NextResponse } from '@/server/http-compat';
import { chatLoginCaller } from '@/lib/auth';
import { assistantConversations } from '@/lib/assistant-inbox';
import { chatAgentIds } from '@/lib/assistant-chat';

/**
 * GET /api/assistant/conversations — the inbox for the mobile companion: one row
 * per agent the login may chat with, with ITS OWN thread's latest-message
 * preview and unread count. Any login (W7c): each user reads only their own
 * threads; a member or a client lists the assistants of its workspaces.
 */
export async function GET() {
  const login = chatLoginCaller();
  const conversations = await assistantConversations(
    login.ownerId,
    login.loginId,
    await chatAgentIds(login),
  );
  return NextResponse.json({ conversations });
}
