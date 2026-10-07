/**
 * The HTTP side of "New chat" and "Continue from this" (chat archive,
 * docs/conversation.md §6c): one place that runs archiveAgentChat and maps its
 * errors to responses, so the routes stay thin and agree.
 */
import { NextResponse } from '@/server/http-compat';
import {
  ChatArchiveBusyError,
  ChatThreadNotFoundError,
  archiveAgentChat,
} from '@mantle/runtime/agent';
import type { ChatArchiveResponse } from '@mantle/client-types';
import { chatThreadRow } from './chat-threads';

export async function archiveResponse(o: {
  ownerId: string;
  agentId: string;
  archivedBy: string;
  continueFrom?: string | null;
}): Promise<Response> {
  try {
    const r = await archiveAgentChat(o);
    const body: ChatArchiveResponse = {
      archived: r.archived ? await chatThreadRow(o.ownerId, r.archived) : null,
      open: r.open ? await chatThreadRow(o.ownerId, r.open) : null,
    };
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    if (err instanceof ChatArchiveBusyError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof ChatThreadNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    throw err;
  }
}
