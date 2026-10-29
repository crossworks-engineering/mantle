import { NextResponse } from '@/server/http-compat';
import { chatCaller, type ChatCaller } from '@/lib/auth';
import { recentAssistantMessages } from '@/lib/assistant';
import {
  chatAdmin,
  listChatAgents,
  messagesForReader,
  resolveChatAgent,
} from '@/lib/assistant-chat';
import { openChatThread } from '@mantle/db';
import { getAssignedAgentSummary } from '@/lib/agents';
import { chatThreadRow, threadRange } from '@/lib/chat-threads';
import { getAgentExperience } from '@/lib/agent-experience';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'self', open: 'chat' },
});

/**
 * GET /api/assistant/thread[?agent=<slug>][&withMessages=0]: the /assistant
 * bundle: the agents this login may chat with, the selected one, the login's
 * OWN open thread with it (messages and thread row), and (an Admin user) its
 * assigned assistant and the agent's level badge.
 *
 * Any login (W7c, the owner's answer of 2026-10-11): each user has their own
 * thread with each assistant and reads only that. A member or a client
 * reaches the assistants of its workspaces other than Admin; an agent it may
 * not chat with answers as none (`agent: null`).
 */
export async function GET(req: Request) {
  const login = chatCaller();
  const params = new URL(req.url).searchParams;
  const slug = params.get('agent') ?? undefined;
  // Opt-OUT, so an absent/garbled param keeps the full bundle every existing
  // caller expects. Only the explicit falsy spellings skip the thread.
  const withMessages = !['0', 'false', 'no'].includes(
    (params.get('withMessages') ?? '').trim().toLowerCase(),
  );
  // Whether the login is an Admin user (adminFacts, asked of its scope).
  const admin = await chatAdmin(login);

  const [agents, agent, assigned] = await Promise.all([
    listChatAgents(login),
    resolveChatAgent(login, slug),
    // The login's own assigned assistant: agents of its workspaces (or none),
    // read in its scope.
    admin ? getAssignedAgentSummary(login.ownerId, login.loginId) : null,
  ]);
  const open = agent ? await openChatThread(login.ownerId, agent.id, login.loginId) : null;
  const [messages, experience, thread] = await Promise.all([
    agent && withMessages
      ? recentAssistantMessages(login.ownerId, agent.id, login.loginId, 100, threadRange(open))
      : [],
    // The header shows the active agent's level badge (an Admin user's view).
    // Counted over every login's turns by its definer, in the scope
    // (mantle_agent_experience, 0293).
    agent && admin ? getAgentExperience(login.ownerId, agent.id) : null,
    open ? chatThreadRow(login.ownerId, open) : null,
  ]);
  const agentOut = agent
    ? {
        id: agent.id,
        slug: agent.slug,
        name: agent.name,
        role: agent.role,
        model: agent.model,
        ...(admin ? notesForLogin(login, stripTurnEngine(agent)) : {}),
        experience,
      }
    : null;

  return NextResponse.json({
    agents,
    agent: agentOut,
    messages: await messagesForReader(login, messages),
    thread,
    assigned: assigned ? { slug: assigned.slug, assignedAt: assigned.assignedAt } : null,
  });
}

/** An Admin user's bundle keeps the full agent row it always had. */
/** Persona notes are learned from the anchor's own thread: the anchor
 *  login's only, any other login gets none. */
function notesForLogin<T extends { personaNotes?: unknown }>(login: ChatCaller, a: T): T {
  return login.loginId === login.ownerId ? a : { ...a, personaNotes: [] };
}

function stripTurnEngine<T extends { turnEngine: unknown }>(a: T): Omit<T, 'turnEngine'> {
  const { turnEngine: _engine, ...rest } = a;
  return rest;
}
