/**
 * Recall builtins — the time-travel half of the brain. Where `search_nodes`
 * and the `entity_*` tools answer "what do I know about X" cheaply (one vector
 * query over summaries/facts), these answer "take me back to what was actually
 * said" — they replay the raw dialogue losslessly from the permanent message
 * archive.
 *
 * Two tools, used in sequence by the `remy` recall agent:
 *
 *   find_window(topic, from?, to?)  → candidate time windows (from conversation
 *                                     digests; digests are the routing directory)
 *   recall_window(from, to)         → the raw turns in that window, chronological
 *
 * Design notes:
 * - The archive already exists: raw turns live permanently in
 *   `telegram_messages` (`sent_at`) and `assistant_messages` (`created_at`);
 *   digests summarise but never delete. So this is a read layer, nothing new
 *   to store.
 * - recall_window replays the DIALOGUE only — not the model's hidden working
 *   state (reasoning / tool results). Traces capture some of that separately.
 */

import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import {
  assistantMessages,
  db,
  nodes,
  telegramChats,
  telegramMessages,
} from '@mantle/db';
import { embed } from '@mantle/embeddings';
import type { BuiltinToolDef } from './types';

// ─── pure helpers (unit-tested in builtins-recall.test.ts) ──────────────────

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a user-supplied window bound. Accepts a bare calendar date
 * (`YYYY-MM-DD`) — widened to the whole UTC day so "2026-05-20 → 2026-05-20"
 * covers that entire day — or a full ISO datetime, taken as-is. Returns null
 * on anything unparseable so callers can fail with a clear message.
 *
 * `edge` only matters for the date-only form: 'start' → 00:00:00.000Z,
 * 'end' → 23:59:59.999Z.
 */
export function parseWindowBound(value: string, edge: 'start' | 'end'): Date | null {
  const v = value.trim();
  if (!v) return null;
  if (DATE_ONLY.test(v)) {
    const iso = edge === 'start' ? `${v}T00:00:00.000Z` : `${v}T23:59:59.999Z`;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export type RecallTurn = {
  surface: 'telegram' | 'web';
  /** inbound = the user spoke; outbound = an agent (Saskia) replied. */
  direction: 'inbound' | 'outbound';
  /** Convenience label derived from direction. */
  speaker: 'user' | 'assistant';
  /** ISO timestamp. */
  at: string;
  text: string;
  /** Telegram inbound only: the sender's display name, when known. */
  from?: string;
};

/** Merge turns from multiple surfaces into one chronological transcript. */
export function mergeAndSortTurns(turns: RecallTurn[]): RecallTurn[] {
  return [...turns].sort((a, b) => a.at.localeCompare(b.at));
}

// ─── input coercion (mirrors builtins.ts helpers) ───────────────────────────

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function strOpt(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function num(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

const MAX_TURNS = 500;
const MAX_WINDOWS = 25;

// ─── find_window ────────────────────────────────────────────────────────────

const find_window: BuiltinToolDef = {
  slug: 'find_window',
  name: 'Find a conversation window',
  description:
    "Locate WHEN a past topic was discussed. Semantic search over conversation digests (the rolled-up summaries of older chats), returning candidate time windows each with a topic, summary, and period_start/period_end. Use this first when the user vaguely remembers discussing something ('last week we talked about a Bible topic') but not exactly when — then call `recall_window` with the best window's dates to read the actual turns. Optional `from`/`to` (YYYY-MM-DD or ISO) narrow to a rough date range; omit them to search all of time.",
  inputSchema: {
    type: 'object',
    properties: {
      topic: {
        type: 'string',
        description: "what to look for, e.g. 'the Bible discussion about Romans 8'",
      },
      from: { type: 'string', description: 'optional rough lower bound (YYYY-MM-DD or ISO)' },
      to: { type: 'string', description: 'optional rough upper bound (YYYY-MM-DD or ISO)' },
      limit: { type: 'integer', minimum: 1, maximum: 25, default: 8 },
    },
    required: ['topic'],
  },
  handler: async (input, ctx) => {
    const topic = str(input.topic).trim();
    if (!topic) return { ok: false, error: 'topic is required' };
    const limit = Math.min(num(input.limit, 8), MAX_WINDOWS);

    const fromRaw = strOpt(input.from);
    const toRaw = strOpt(input.to);
    const from = fromRaw ? parseWindowBound(fromRaw, 'start') : null;
    const to = toRaw ? parseWindowBound(toRaw, 'end') : null;
    if (fromRaw && !from) return { ok: false, error: 'from must be YYYY-MM-DD or ISO datetime' };
    if (toRaw && !to) return { ok: false, error: 'to must be YYYY-MM-DD or ISO datetime' };

    let queryVec: number[];
    try {
      queryVec = await embed(ctx.ownerId, topic);
    } catch (err) {
      return { ok: false, error: `embed failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    const vec = JSON.stringify(queryVec);

    const conds = [
      eq(nodes.ownerId, ctx.ownerId),
      eq(nodes.type, 'note'),
      sql`${nodes.tags} @> ARRAY['conversation-digest']::text[]`,
      sql`${nodes.embedding} is not null`,
    ];
    // Keep digests whose [period_start, period_end] overlaps the rough range.
    if (to) {
      conds.push(sql`(${nodes.data}->>'period_start')::timestamptz <= ${to.toISOString()}::timestamptz`);
    }
    if (from) {
      conds.push(sql`(${nodes.data}->>'period_end')::timestamptz >= ${from.toISOString()}::timestamptz`);
    }

    const rows = await db
      .select({
        nodeId: nodes.id,
        title: nodes.title,
        data: nodes.data,
        dist: sql<number>`${nodes.embedding} <=> ${vec}::vector`,
      })
      .from(nodes)
      .where(and(...conds))
      .orderBy(sql`${nodes.embedding} <=> ${vec}::vector`)
      .limit(limit);

    const windows = rows.map((r) => {
      const d = (r.data ?? {}) as Record<string, unknown>;
      return {
        node_id: r.nodeId,
        topic: typeof d.topic === 'string' ? d.topic : r.title,
        summary: typeof d.summary === 'string' ? d.summary : null,
        period_start: typeof d.period_start === 'string' ? d.period_start : null,
        period_end: typeof d.period_end === 'string' ? d.period_end : null,
        surface: typeof d.source === 'string' ? d.source : null,
        similarity: Number((1 - r.dist).toFixed(4)),
      };
    });

    ctx.step?.setOutput({ count: windows.length });
    return {
      ok: true,
      output: {
        query: topic,
        count: windows.length,
        windows,
        next:
          windows.length > 0
            ? 'Pick the best window and call recall_window with its period_start and period_end to read the raw turns.'
            : 'No matching digests. Conversations are only digested once a chat passes the summarize threshold, so very recent discussion may not be here yet — try recall_window directly with a rough date range.',
      },
    };
  },
};

// ─── recall_window ──────────────────────────────────────────────────────────

const recall_window: BuiltinToolDef = {
  slug: 'recall_window',
  name: 'Recall a conversation window',
  description:
    "Replay the actual raw turns of past conversations within a date range, chronological and lossless (the real words, not a summary). Use after `find_window` has pinned a window, or directly when the user gives a date ('what did we say on Tuesday?'). `from`/`to` accept a bare date (YYYY-MM-DD, widened to the whole day) or a full ISO datetime. `surface` filters to 'telegram', 'web', or 'all' (default). If the window is larger than `limit` the result is truncated — narrow the range or pull it in sub-ranges and reason over each.",
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'window start (YYYY-MM-DD or ISO datetime)' },
      to: { type: 'string', description: 'window end (YYYY-MM-DD or ISO datetime)' },
      surface: {
        type: 'string',
        enum: ['telegram', 'web', 'all'],
        default: 'all',
        description: 'which conversation surface to pull from',
      },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
    },
    required: ['from', 'to'],
  },
  handler: async (input, ctx) => {
    const fromRaw = str(input.from);
    const toRaw = str(input.to);
    if (!fromRaw || !toRaw) return { ok: false, error: 'from and to are required' };
    const from = parseWindowBound(fromRaw, 'start');
    const to = parseWindowBound(toRaw, 'end');
    if (!from) return { ok: false, error: 'from must be YYYY-MM-DD or ISO datetime' };
    if (!to) return { ok: false, error: 'to must be YYYY-MM-DD or ISO datetime' };
    if (from > to) return { ok: false, error: 'from is after to' };

    const surface = (strOpt(input.surface) ?? 'all') as 'telegram' | 'web' | 'all';
    const limit = Math.min(num(input.limit, 200), MAX_TURNS);

    const turns: RecallTurn[] = [];

    if (surface === 'all' || surface === 'telegram') {
      const tg = await db
        .select({
          text: telegramMessages.text,
          sentAt: telegramMessages.sentAt,
          direction: telegramMessages.direction,
          fromName: telegramMessages.fromName,
        })
        .from(telegramMessages)
        .innerJoin(telegramChats, eq(telegramMessages.chatId, telegramChats.id))
        .where(
          and(
            eq(telegramChats.userId, ctx.ownerId),
            gte(telegramMessages.sentAt, from),
            lte(telegramMessages.sentAt, to),
          ),
        )
        .orderBy(asc(telegramMessages.sentAt))
        .limit(limit + 1);
      for (const r of tg) {
        turns.push({
          surface: 'telegram',
          direction: r.direction,
          speaker: r.direction === 'inbound' ? 'user' : 'assistant',
          at: r.sentAt.toISOString(),
          text: r.text,
          ...(r.direction === 'inbound' && r.fromName ? { from: r.fromName } : {}),
        });
      }
    }

    if (surface === 'all' || surface === 'web') {
      const web = await db
        .select({
          text: assistantMessages.text,
          createdAt: assistantMessages.createdAt,
          direction: assistantMessages.direction,
        })
        .from(assistantMessages)
        .where(
          and(
            eq(assistantMessages.ownerId, ctx.ownerId),
            gte(assistantMessages.createdAt, from),
            lte(assistantMessages.createdAt, to),
          ),
        )
        .orderBy(asc(assistantMessages.createdAt))
        .limit(limit + 1);
      for (const r of web) {
        const outbound = r.direction === 'outbound';
        turns.push({
          surface: 'web',
          direction: outbound ? 'outbound' : 'inbound',
          speaker: outbound ? 'assistant' : 'user',
          at: r.createdAt.toISOString(),
          text: r.text,
        });
      }
    }

    const sorted = mergeAndSortTurns(turns);
    const truncated = sorted.length > limit;
    const out = truncated ? sorted.slice(0, limit) : sorted;

    ctx.step?.setOutput({ count: out.length, truncated, surface });
    return {
      ok: true,
      output: {
        window: { from: from.toISOString(), to: to.toISOString() },
        surface,
        count: out.length,
        truncated,
        ...(truncated
          ? {
              note: 'This window has more turns than the limit returns. Narrow the date range (or raise limit) and pull it in sub-ranges, reasoning over each, rather than trusting a partial slice.',
            }
          : {}),
        turns: out,
      },
    };
  },
};

export const RECALL_TOOLS: BuiltinToolDef[] = [find_window, recall_window];
