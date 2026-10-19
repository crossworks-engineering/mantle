/**
 * Who chats with which assistant (workspaces W7c, plan section 4; the owner's
 * answer of 2026-10-11). Every login chats with the assistant of each
 * workspace it is a user of, each in its own thread, and reads only its own
 * threads. The chat routes (/api/assistant/*) resolve the agent here, after
 * getChatLoginOr401:
 *
 *  - an Admin user keeps the owner surface's choice (an explicit slug, else
 *    its assigned assistant, else the brain's default chattable agent), with
 *    one rule more: an assistant of a workspace other than Admin answers only
 *    a user of that workspace;
 *  - a member reaches only the assistants of its own workspaces other than
 *    Admin (its oldest workspace's first, defaultWorkspaceAssistant): never
 *    the Admin assistant, never a helper;
 *  - a client has no chat at all (W7c fix round 1, M4): clients do not exist
 *    as chat users yet, so every chat route answers as if there were no
 *    assistant.
 *
 * `turnEngine` says which engine runs a turn: 'owner' (runAssistantTurn: the
 * Admin assistant and the owner's helpers, with the Journal and "About the
 * user") or 'workspace' (runTeamTurn: an assistant of another workspace, no
 * Journal, no "About the user", the member turn ledger's limits).
 */
import { eq } from 'drizzle-orm';
import { agents, db, workspaces, type Agent } from '@mantle/db';
import { chatTextsForReader, workspaceAssistants, type WorkspaceAssistant } from '@mantle/content';
import type { AssistantAgentOption } from '@mantle/client-types';
import type { ChatLogin } from './auth';
import { listAssistantAgents, resolveAgentForActor } from './assistant';

export type ChatAgent = Agent & { turnEngine: 'owner' | 'workspace' };

/** The agent row by id (enabled, this brain's). */
async function agentById(ownerId: string, id: string): Promise<Agent | null> {
  const [row] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
  return row && row.ownerId === ownerId && row.enabled ? row : null;
}

/** Whether an agent answers in a workspace other than Admin. */
async function inOtherWorkspace(agent: Agent): Promise<boolean> {
  if (!agent.workspaceId) return false;
  const [ws] = await db
    .select({ isAdmin: workspaces.isAdmin })
    .from(workspaces)
    .where(eq(workspaces.id, agent.workspaceId))
    .limit(1);
  return ws ? !ws.isAdmin : false;
}

/** The assistants a non-Admin login may chat with: those of its workspaces
 *  other than Admin, its oldest workspace's first (the order of
 *  workspaceAssistants; the first is defaultWorkspaceAssistant's pick). */
async function memberAssistants(login: ChatLogin): Promise<WorkspaceAssistant[]> {
  return (await workspaceAssistants(login.ownerId, login.loginId)).filter((a) => !a.isAdmin);
}

/**
 * The agent this login's chat request addresses (`slug`, else its default),
 * or null when it may not chat with it (or there is none). Never another
 * workspace's assistant for a login that is not a user there.
 */
export async function resolveChatAgent(
  login: ChatLogin,
  slug?: string | null,
): Promise<ChatAgent | null> {
  if (login.kind === 'admin') {
    const agent = await resolveAgentForActor(login.user, slug ?? undefined);
    if (!agent) return null;
    if (!(await inOtherWorkspace(agent))) return { ...agent, turnEngine: 'owner' };
    // An assistant of another workspace: only for a user of it.
    const mine = await workspaceAssistants(login.ownerId, login.loginId);
    if (!mine.some((a) => a.id === agent.id)) return null;
    return { ...agent, turnEngine: 'workspace' };
  }
  const options = await memberAssistants(login);
  const pick = slug ? options.find((a) => a.slug === slug) : options[0];
  if (!pick) return null;
  const agent = await agentById(login.ownerId, pick.id);
  return agent ? { ...agent, turnEngine: 'workspace' } : null;
}

/**
 * resolveChatAgent for a chat WRITE (mark read, archive, a turn). Since plan
 * v3.2 S6 c3 an Admin user's write runs in its scope, as its reads did:
 * there an explicit slug of an assistant the scope does not read (another
 * workspace's, the user not in it) finds no row and would fall through to
 * the default agent, so the write would land on an agent it did not name.
 * On the system pool (before c3) that slug's row was found and refused
 * (another workspace's assistant, only for its users): "no agent". So an
 * explicit slug that does not resolve to itself answers null, as a
 * member's always did (memberAssistants: no fall-through). An unknown or
 * disabled slug fell through to the default before; it answers null now
 * too (narrower: the write names an agent it cannot reach).
 */
export async function resolveChatAgentToWrite(
  login: ChatLogin,
  slug?: string | null,
): Promise<ChatAgent | null> {
  const agent = await resolveChatAgent(login, slug);
  if (agent && slug && agent.slug !== slug) return null;
  return agent;
}

/** An agent by id, when this login may chat with it (an archived thread's
 *  agent, for instance), else null. */
export async function resolveChatAgentById(
  login: ChatLogin,
  agentId: string,
): Promise<ChatAgent | null> {
  const agent = await agentById(login.ownerId, agentId);
  if (!agent) return null;
  if (login.kind === 'admin') {
    if (!(await inOtherWorkspace(agent))) return { ...agent, turnEngine: 'owner' };
    const mine = await workspaceAssistants(login.ownerId, login.loginId);
    return mine.some((a) => a.id === agent.id) ? { ...agent, turnEngine: 'workspace' } : null;
  }
  const options = await memberAssistants(login);
  return options.some((o) => o.id === agent.id) ? { ...agent, turnEngine: 'workspace' } : null;
}

/** The agents this login may chat with, for the /assistant selector. */
export async function listChatAgents(login: ChatLogin): Promise<AssistantAgentOption[]> {
  if (login.kind === 'admin') {
    const [all, mine, others] = await Promise.all([
      listAssistantAgents(login.ownerId),
      workspaceAssistants(login.ownerId, login.loginId),
      workspaceAssistants(login.ownerId),
    ]);
    // An assistant of a workspace other than Admin is listed only for its
    // users; every other chattable agent as before.
    const otherIds = new Set(others.filter((a) => !a.isAdmin).map((a) => a.id));
    const mineIds = new Set(mine.map((a) => a.id));
    return all.filter((a) => !otherIds.has(a.id) || mineIds.has(a.id));
  }
  const options = await memberAssistants(login);
  if (options.length === 0) return [];
  const rows = await Promise.all(options.map((o) => agentById(login.ownerId, o.id)));
  return rows
    .filter((r): r is Agent => r !== null)
    .map((r) => ({ id: r.id, slug: r.slug, name: r.name, role: r.role as string, model: r.model }));
}

/** The ids of the agents this login may chat with (the inbox's rows). */
export async function chatAgentIds(login: ChatLogin): Promise<string[] | undefined> {
  // An Admin user's inbox lists every chattable agent it may reach.
  return (await listChatAgents(login)).map((a) => a.id);
}

/**
 * Chat messages as this login receives them (W7c fix round 1, M3; client
 * logins C6): for a login that is not an Admin user every picture in a text
 * points at its own routes, and only at an item it may read; never at an
 * admin route or an outside address. An Admin user's messages are as stored.
 * The image lookup runs in the reader's own scope (chatImagesFor): the
 * request already runs in it (a member's chat routes read in its scope), so
 * the helper's own scope adds nothing (A6b: it left the scope by
 * 'rule-in-query' only to enter the same one again).
 */
export async function messagesForReader<T extends { text: string }>(
  login: ChatLogin,
  messages: T[],
): Promise<T[]> {
  if (login.kind === 'admin' || messages.length === 0) return messages;
  const texts = await chatTextsForReader(
    login.ownerId,
    'team',
    login.loginId,
    messages.map((m) => m.text),
  );
  return messages.map((m, i) => ({ ...m, text: texts[i] ?? '' }));
}
