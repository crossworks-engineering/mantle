/**
 * Web assistant facade — Sarah-on-the-web, the web doorway onto the unified
 * per-(owner, agent) conversation stream (docs/conversation.md).
 *
 * The turn-execution path (resolveAssistantAgent + runAssistantTurn) now lives
 * in @mantle/assistant-runtime so it can run OUTSIDE the Next.js request — from
 * the durable apps/api runner as well as this route — and is re-exported here so
 * existing `@/lib/assistant` importers stay unchanged. What remains below is the
 * web-only read side: the timeline queries the /assistant page and its scroll-up
 * pager use, plus the agent-selector list.
 */

import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { db, agents, assistantMessages, type Agent } from '@mantle/db';
import {
  CHATTABLE_ROLES,
  resolveAssistantAgent as resolveAssistantAgentRuntime,
} from '@mantle/assistant-runtime';
import { getAssignedAgent } from './agents';
import type { SessionUser } from './auth';

export {
  runAssistantTurn,
  resolveAssistantAgent,
  type AssistantTurnResult,
} from '@mantle/assistant-runtime';
import type { AssistantAgentOption, AssistantTimelineRow } from '@mantle/client-types';
import type { ToolOutcomeStatsRow } from '@mantle/client-types';
export type { ToolOutcomeStatsRow };
export type { AssistantAgentOption, AssistantTimelineRow };

/**
 * `resolveAssistantAgent`, but aware of WHICH LOGIN is asking.
 *
 * The runtime resolver only ever sees the anchor owner id — by design; it runs
 * outside the request, from the durable runner as well as a route, and must not
 * learn about logins. But since migration 0111 several logins share that anchor,
 * so they all resolved to the same agent and their turns interleaved in one
 * thread. Migration 0143 lets a login own an agent; this resolves it, at the
 * HTTP boundary where `actor.id` is known.
 *
 * Order: an explicit slug always wins (the picker is the user's own choice) →
 * the login's assigned assistant → today's brain-wide default. Every step falls
 * through, so a brain with no assignments behaves exactly as before.
 */
export async function resolveAgentForActor(
  user: SessionUser,
  slug?: string,
): Promise<Agent | null> {
  if (!slug) {
    // Returns the row, so this is one query — not a lookup followed by a
    // re-fetch of the same agent by slug.
    const assigned = await getAssignedAgent(user.id, user.actor.id);
    if (assigned) return assigned;
  }
  return resolveAssistantAgentRuntime(user.id, slug);
}

/** Pull a persisted thought trail out of a row's `data` jsonb, defensively. */
function thoughtsFromData(data: unknown): AssistantTimelineRow['thoughts'] {
  const t = (data as { thoughts?: unknown } | null)?.thoughts;
  if (!Array.isArray(t) || t.length === 0) return undefined;
  return t
    .filter(
      (s): s is { kind: string; label: string; elapsedMs?: number } =>
        Boolean(s) && typeof (s as { label?: unknown }).label === 'string',
    )
    .map((s) => ({ kind: String(s.kind ?? 'tool'), label: s.label, elapsedMs: s.elapsedMs }));
}

/** True when the row carries the supersede stamp (`data.superseded_by`). */
function supersededFromData(data: unknown): boolean {
  return Boolean((data as { superseded_by?: unknown } | null)?.superseded_by);
}

/** Pull the persisted tool-outcome tally out of a row's `data` jsonb. */
function toolStatsFromData(data: unknown): ToolOutcomeStatsRow | undefined {
  const t = (data as { toolStats?: unknown } | null)?.toolStats;
  if (!t || typeof t !== 'object') return undefined;
  const s = t as Record<string, unknown>;
  if (typeof s.calls !== 'number' || s.calls <= 0) return undefined;
  return {
    calls: s.calls,
    succeeded: typeof s.succeeded === 'number' ? s.succeeded : 0,
    failed: typeof s.failed === 'number' ? s.failed : 0,
    skipped: typeof s.skipped === 'number' ? s.skipped : 0,
    queued: typeof s.queued === 'number' ? s.queued : 0,
    failures: Array.isArray(s.failures)
      ? (s.failures as Array<{ slug?: unknown; error?: unknown }>)
          .filter((f) => typeof f?.slug === 'string')
          .map((f) => ({ slug: String(f.slug), error: String(f.error ?? '') }))
      : [],
  };
}

/**
 * Recent transcript for one (owner, agent) thread, chronological
 * (oldest → newest). `agentId` is required — there is no
 * cross-agent / "all messages" view: each agent owns its own
 * forever-thread. The shared brain (nodes/facts/entities) is what
 * agents have in common; the conversation is not.
 */
export async function recentAssistantMessages(
  ownerId: string,
  agentId: string,
  limit = 100,
): Promise<AssistantTimelineRow[]> {
  const rows = await db
    .select({
      id: assistantMessages.id,
      direction: assistantMessages.direction,
      text: assistantMessages.text,
      model: assistantMessages.model,
      channel: assistantMessages.channel,
      status: assistantMessages.status,
      error: assistantMessages.error,
      attachments: assistantMessages.attachments,
      data: assistantMessages.data,
      createdAt: assistantMessages.createdAt,
    })
    .from(assistantMessages)
    .where(and(eq(assistantMessages.ownerId, ownerId), eq(assistantMessages.agentId, agentId)))
    .orderBy(desc(assistantMessages.createdAt))
    .limit(limit);
  return rows.reverse().map((r) => ({
    id: r.id,
    direction: r.direction as 'inbound' | 'outbound',
    text: r.text,
    model: r.model,
    channel: r.channel,
    status: r.status,
    error: r.error,
    attachments: r.attachments ?? [],
    ...(thoughtsFromData(r.data) ? { thoughts: thoughtsFromData(r.data) } : {}),
    ...(toolStatsFromData(r.data) ? { toolStats: toolStatsFromData(r.data) } : {}),
    ...(supersededFromData(r.data) ? { superseded: true } : {}),
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * Page of (owner, agent) thread messages OLDER than `before` (an ISO
 * timestamp), for scroll-up lazy loading. Same shape/order as
 * recentAssistantMessages (chronological, oldest→newest). Returns up to
 * `limit` rows; fewer than `limit` means the top of the thread is reached.
 */
export async function assistantMessagesBefore(
  ownerId: string,
  agentId: string,
  before: string,
  limit = 100,
): Promise<AssistantTimelineRow[]> {
  const rows = await db
    .select({
      id: assistantMessages.id,
      direction: assistantMessages.direction,
      text: assistantMessages.text,
      model: assistantMessages.model,
      channel: assistantMessages.channel,
      status: assistantMessages.status,
      error: assistantMessages.error,
      attachments: assistantMessages.attachments,
      data: assistantMessages.data,
      createdAt: assistantMessages.createdAt,
    })
    .from(assistantMessages)
    .where(
      and(
        eq(assistantMessages.ownerId, ownerId),
        eq(assistantMessages.agentId, agentId),
        lt(assistantMessages.createdAt, new Date(before)),
      ),
    )
    .orderBy(desc(assistantMessages.createdAt))
    .limit(limit);
  return rows.reverse().map((r) => ({
    id: r.id,
    direction: r.direction as 'inbound' | 'outbound',
    text: r.text,
    model: r.model,
    channel: r.channel,
    status: r.status,
    error: r.error,
    attachments: r.attachments ?? [],
    ...(thoughtsFromData(r.data) ? { thoughts: thoughtsFromData(r.data) } : {}),
    ...(toolStatsFromData(r.data) ? { toolStats: toolStatsFromData(r.data) } : {}),
    ...(supersededFromData(r.data) ? { superseded: true } : {}),
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Enabled, chat-capable agents the /assistant selector can target. */
export async function listAssistantAgents(ownerId: string): Promise<AssistantAgentOption[]> {
  const rows = await db
    .select({
      id: agents.id,
      slug: agents.slug,
      name: agents.name,
      role: agents.role,
      model: agents.model,
    })
    .from(agents)
    .where(
      and(
        eq(agents.ownerId, ownerId),
        eq(agents.enabled, true),
        inArray(agents.role, CHATTABLE_ROLES),
      ),
    )
    .orderBy(desc(agents.priority));
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    role: r.role as string,
    model: r.model,
  }));
}
