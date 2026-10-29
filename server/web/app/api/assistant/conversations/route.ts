import { NextResponse } from '@/server/http-compat';
import { chatCaller } from '@/lib/auth';
import { assistantConversations } from '@/lib/assistant-inbox';
import { chatAgentIds } from '@/lib/assistant-chat';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'self', open: 'chat' },
});

/**
 * GET /api/assistant/conversations — the inbox for the mobile companion: one row
 * per agent the login may chat with, with ITS OWN thread's latest-message
 * preview and unread count. Any login: each user reads only their own
 * threads; a member or a client lists the assistants of its workspaces.
 */
export async function GET() {
  const login = chatCaller();
  const conversations = await assistantConversations(
    login.ownerId,
    login.loginId,
    await chatAgentIds(login),
  );
  return NextResponse.json({ conversations });
}
