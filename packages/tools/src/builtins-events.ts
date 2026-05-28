/**
 * Builtin event tools — Saskia's calendar surface.
 *
 * Mirrors the MCP event tools in apps/mcp/src/server.ts so Saskia
 * (responder / assistant) can read and write to the same events
 * Claude Code can, without going through MCP. Same underlying
 * @mantle/content helpers; same data shape.
 *
 * Per the operator's decision in the rollout conversation: none of
 * these require_confirm. The reasoning is that event_create /
 * event_update produce easily reversible state, and event_delete is
 * only "irreversible-ish" (pending reminders won't fire). Operators
 * who want approval gates can flip requires_confirm on the row in
 * the tools table via the UI, per-call.
 *
 * Time-aware behaviour: event_create reads the owner's profile
 * timezone when the caller doesn't pass one, so Saskia can omit it
 * and trust the system to pick the right default. The startsAt
 * field is ALWAYS a UTC ISO instant — the system-prompt time
 * context tells her to compute that herself before calling.
 */

import {
  createEvent,
  deleteEvent,
  getEvent,
  listEvents,
  loadProfilePreferences,
  updateEvent,
  type RecurFreq,
} from '@mantle/content';
import type { BuiltinToolDef, ToolHandlerResult } from './types';

const RECUR_VALUES: readonly RecurFreq[] = ['none', 'daily', 'weekly', 'monthly', 'yearly'];

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
function strOpt(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function num(v: unknown, dflt?: number): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return dflt;
}
function strArr(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((s): s is string => typeof s === 'string');
  return out.length > 0 ? out : undefined;
}
/** Validated RecurFreq, or undefined to leave unchanged on update. */
function recurOpt(v: unknown): RecurFreq | undefined {
  return typeof v === 'string' && (RECUR_VALUES as readonly string[]).includes(v)
    ? (v as RecurFreq)
    : undefined;
}

const event_list: BuiltinToolDef = {
  slug: 'event_list',
  name: 'List calendar events',
  description:
    "List the user's calendar events, **date-windowed**. `window` defaults to 'upcoming' — pass 'past' to look back or 'all' to include both. `query` substring-matches title/body/location/summary; `tag` narrows to events with that tag. Returns full event rows. " +
    "**Use this for any time-based event question** — 'what's on this week', 'next meeting with X', 'past events about Y'. For topic/semantic search across events ('any event mentioning the contract') use `search_nodes` with `type='event'` — that's similarity-ranked, not date-windowed. For a single event's full body use `event_get`.",
  inputSchema: {
    type: 'object',
    properties: {
      window: {
        type: 'string',
        enum: ['upcoming', 'past', 'all'],
        description: "Defaults to 'upcoming' — events whose startsAt is now-or-later.",
      },
      query: {
        type: 'string',
        description: 'Optional substring filter against title/body/location.',
      },
      tag: { type: 'string' },
    },
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    try {
      const rows = await listEvents(ctx.ownerId, {
        window: input.window as 'upcoming' | 'past' | 'all' | undefined,
        query: strOpt(input.query),
        tag: strOpt(input.tag),
      });
      ctx.step?.setMeta({ count: rows.length });
      return { ok: true, output: { events: rows, count: rows.length } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const event_get: BuiltinToolDef = {
  slug: 'event_get',
  name: 'Get a calendar event',
  description:
    "Read one event by id — full row including body, location, starts_at, ends_at. " +
    "Use after `event_list` or `search_nodes` returns the id you want details on. " +
    "For browsing/filtering events use `event_list`.",
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const id = str(input.id);
    if (!id) return { ok: false, error: 'id required' };
    const row = await getEvent(ctx.ownerId, id);
    if (!row) return { ok: false, error: `event ${id} not found` };
    return { ok: true, output: row };
  },
};

const event_create: BuiltinToolDef = {
  slug: 'event_create',
  name: 'Schedule a calendar event',
  description:
    "Create a calendar event. `startsAt` MUST be a UTC ISO 8601 instant (e.g. '2026-05-20T15:00:00Z') — convert from the user's natural-language reference using the timezone from the system-prompt time context. `remindMinutesBefore` controls when a Telegram reminder fires (default 0 = right at start; set higher for advance notice). `timezone` defaults to the user's profile timezone — only override when the event is in a DIFFERENT timezone (e.g. a travel meeting).",
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      startsAt: {
        type: 'string',
        description: "UTC ISO 8601 instant. e.g. '2026-05-20T15:00:00Z'.",
      },
      endsAt: {
        type: 'string',
        description: 'Optional UTC ISO 8601. Omit for an instantaneous event.',
      },
      body: {
        type: 'string',
        description: 'Optional details / description / notes for the event.',
      },
      location: { type: 'string', maxLength: 200 },
      remindMinutesBefore: {
        type: 'integer',
        minimum: 0,
        maximum: 60 * 24 * 30,
        description:
          'Minutes before startsAt to fire the Telegram reminder. 0 = at start. 60 = an hour before. Defaults to 0.',
      },
      timezone: {
        type: 'string',
        description:
          "IANA timezone for display in the reminder. Defaults to the user's profile timezone.",
      },
      recur: {
        type: 'string',
        enum: ['none', 'daily', 'weekly', 'monthly', 'yearly'],
        description:
          "How often the event repeats. Defaults to 'none' (one-shot). A recurring event re-arms its reminder for the next occurrence after each ping.",
      },
      recurUntil: {
        type: 'string',
        description:
          'Optional UTC ISO 8601 cutoff — the series stops once the next occurrence would fall after this. Only meaningful with recur set.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional tag list — e.g. [\'work\', \'meeting\'].',
      },
    },
    required: ['title', 'startsAt'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const title = str(input.title).trim();
    const startsAt = str(input.startsAt);
    if (!title || !startsAt) {
      return { ok: false, error: 'title + startsAt required' };
    }
    // Default timezone from the owner's profile when caller omits.
    // Saskia normally won't pass one — the prompt time context tells
    // her she's converting to UTC, and the user's profile knows
    // which tz to display in.
    let timezone = strOpt(input.timezone);
    if (!timezone) {
      const prefs = await loadProfilePreferences(ctx.ownerId);
      timezone = prefs.timezone;
    }
    try {
      const row = await createEvent(ctx.ownerId, {
        title,
        startsAt,
        body: strOpt(input.body),
        endsAt: strOpt(input.endsAt) ?? null,
        location: strOpt(input.location) ?? null,
        remindMinutesBefore: num(input.remindMinutesBefore, 0),
        recur: recurOpt(input.recur),
        recurUntil: strOpt(input.recurUntil) ?? null,
        timezone,
        tags: strArr(input.tags),
      });
      ctx.step?.setMeta({ eventId: row.id, title, startsAt, timezone });
      return { ok: true, output: row };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const event_update: BuiltinToolDef = {
  slug: 'event_update',
  name: 'Update a calendar event',
  description:
    "Update an existing event. Any field omitted stays unchanged. If you move `startsAt` or `remindMinutesBefore` forward and the new reminder time is still in the future, a previously-sent reminder fires again. `startsAt` / `endsAt` are UTC ISO 8601 instants. Set `recur` to make it repeat (or 'none' to stop repeating); `recurUntil` caps the series.",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      title: { type: 'string', minLength: 1, maxLength: 200 },
      startsAt: { type: 'string', description: 'UTC ISO 8601.' },
      endsAt: { type: 'string', description: 'UTC ISO 8601.' },
      body: { type: 'string' },
      location: { type: 'string', maxLength: 200 },
      remindMinutesBefore: { type: 'integer', minimum: 0, maximum: 60 * 24 * 30 },
      timezone: { type: 'string' },
      recur: {
        type: 'string',
        enum: ['none', 'daily', 'weekly', 'monthly', 'yearly'],
        description: "Repeat frequency; 'none' turns recurrence off.",
      },
      recurUntil: {
        type: 'string',
        description: 'Optional UTC ISO 8601 end-of-series cutoff.',
      },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['id'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const id = str(input.id);
    if (!id) return { ok: false, error: 'id required' };
    try {
      const row = await updateEvent(ctx.ownerId, id, {
        title: strOpt(input.title),
        startsAt: strOpt(input.startsAt),
        endsAt: strOpt(input.endsAt) ?? null,
        body: strOpt(input.body),
        location: strOpt(input.location) ?? null,
        remindMinutesBefore: num(input.remindMinutesBefore),
        timezone: strOpt(input.timezone),
        recur: recurOpt(input.recur),
        // Omit → leave unchanged (don't clobber an existing cutoff).
        recurUntil: strOpt(input.recurUntil),
        tags: strArr(input.tags),
      });
      if (!row) return { ok: false, error: `event ${id} not found` };
      ctx.step?.setMeta({ eventId: id });
      return { ok: true, output: row };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};

const event_delete: BuiltinToolDef = {
  slug: 'event_delete',
  name: 'Delete a calendar event',
  description:
    "Delete an event by id. Pending reminders won't fire. Confirm with the user before calling unless they explicitly asked to delete this specific event — the action is mostly-reversible (you can recreate from memory) but the original id and any deeplinks are gone.",
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const id = str(input.id);
    if (!id) return { ok: false, error: 'id required' };
    const ok = await deleteEvent(ctx.ownerId, id);
    ctx.step?.setMeta({ eventId: id, deleted: ok });
    return ok
      ? { ok: true, output: { deleted: true, id } }
      : { ok: false, error: `event ${id} not found` };
  },
};

export const EVENT_TOOLS: readonly BuiltinToolDef[] = [
  event_list,
  event_get,
  event_create,
  event_update,
  event_delete,
];
