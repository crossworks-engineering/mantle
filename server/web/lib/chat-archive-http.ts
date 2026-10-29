/**
 * The HTTP side of "New chat" and "Continue from this" (chat archive,
 * docs/conversation.md §6c): one place that runs archiveAgentChat, so the
 * routes stay thin and agree; its errors answer by the one table.
 */
import { NextResponse } from '@/server/http-compat';
import { archiveAgentChat } from '@mantle/runtime/agent';
import type { ChatArchiveResponse } from '@mantle/client-types';
import { chatThreadRow } from './chat-threads';
import { inRuleInQuery } from '@/lib/auth/rule-in-query';
import { CACHE_CONTROL } from './cache-control';

export async function archiveResponse(o: {
  ownerId: string;
  agentId: string;
  /** The login whose chat is archived (0269): its own thread only. */
  loginId: string;
  archivedBy: string;
  continueFrom?: string | null;
}): Promise<Response> {
  // The login's own thread, named here: the archive and its summary note
  // are written on the system pool (the workspace role writes neither). A
  // reply still running (ChatArchiveBusyError, 409) and a thread not found
  // (ChatThreadNotFoundError, 404) answer by their rows in the one table.
  const r = await inRuleInQuery(() => archiveAgentChat(o));
  const body: ChatArchiveResponse = {
    archived: r.archived ? await chatThreadRow(o.ownerId, r.archived) : null,
    open: r.open ? await chatThreadRow(o.ownerId, r.open) : null,
  };
  return NextResponse.json(body, { headers: { 'Cache-Control': CACHE_CONTROL.none } });
}
