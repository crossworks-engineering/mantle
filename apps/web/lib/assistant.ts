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
import {
  db,
  agents,
  assistantMessages,
  type ConversationAttachment,
} from '@mantle/db';
import { CHATTABLE_ROLES } from '@mantle/assistant-runtime';

export {
  runAssistantTurn,
  resolveAssistantAgent,
  type AssistantTurnResult,
} from '@mantle/assistant-runtime';

export type AssistantTimelineRow = {
  id: string;
  direction: 'inbound' | 'outbound';
  text: string;
  model: string | null;
  /** Transport the turn arrived/left on — drives the channel badge in the UI.
   *  'web' for native /assistant turns; 'telegram' (etc.) for turns that came
   *  in on another surface and now show in the unified stream. */
  channel: string;
  /** Execution state (migration 0105). 'complete' for every historical/inbound
   *  row; an outbound row is 'pending' while the durable runner works and
   *  'failed' if it errored — so a reload mid-turn renders a live "thinking…"
   *  bubble (or the error) instead of nothing. See docs/live-turn-streaming.md. */
  status: 'pending' | 'complete' | 'failed';
  /** Human-readable failure reason for a 'failed' turn; null otherwise. */
  error: string | null;
  /** Persisted media (images, voice notes, docs) so the turn renders its
   *  attachments on load — no bytes, just node/file references. */
  attachments: ConversationAttachment[];
  /** Persisted thought trail (grounded action labels), present on an outbound
   *  row when the brain has trail-persistence on — lets the "Thought process"
   *  record survive a reload. Undefined when not persisted. */
  thoughts?: Array<{ kind: string; label: string; elapsedMs?: number }>;
  /** Deterministic tool-outcome tally for the turn — the runtime's own
   *  ledger, persisted at finalize. Drives the "N tool calls · M failed"
   *  footer so the record is independent of the reply's claims. */
  toolStats?: ToolOutcomeStatsRow;
  createdAt: string;
};

export type ToolOutcomeStatsRow = {
  calls: number;
  succeeded: number;
  failed: number;
  skipped: number;
  /** Confirm-gated calls parked behind operator approval — not yet run. */
  queued: number;
  failures: Array<{ slug: string; error: string }>;
};

/** Pull a persisted thought trail out of a row's `data` jsonb, defensively. */
function thoughtsFromData(data: unknown): AssistantTimelineRow['thoughts'] {
  const t = (data as { thoughts?: unknown } | null)?.thoughts;
  if (!Array.isArray(t) || t.length === 0) return undefined;
  return t
    .filter((s): s is { kind: string; label: string; elapsedMs?: number } =>
      Boolean(s) && typeof (s as { label?: unknown }).label === 'string',
    )
    .map((s) => ({ kind: String(s.kind ?? 'tool'), label: s.label, elapsedMs: s.elapsedMs }));
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
    .where(
      and(eq(assistantMessages.ownerId, ownerId), eq(assistantMessages.agentId, agentId)),
    )
    .orderBy(desc(assistantMessages.createdAt))
    .limit(limit);
  return rows
    .reverse()
    .map((r) => ({
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
  return rows
    .reverse()
    .map((r) => ({
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
      createdAt: r.createdAt.toISOString(),
    }));
}

export type AssistantAgentOption = {
  id: string;
  slug: string;
  name: string;
  role: string;
  model: string;
};

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
  return rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, role: r.role as string, model: r.model }));
}
