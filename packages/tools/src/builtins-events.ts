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
  nodeUrl,
  updateEvent,
  type RecurFreq,
} from '@mantle/content';
import type { BuiltinToolDef, ToolHandlerResult, ToolPrecondition } from './types';
import { notFound } from './errors';

// Shared referential precondition (checked centrally in dispatch — see
// preconditions.ts): the id must name an EXISTING event the owner holds.
const EVENT_ID_PRE: readonly ToolPrecondition[] = [
  { kind: 'node_exists', param: 'id', nodeType: 'event', lookup: 'event_list' },
];

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
      tag: { type: 'string', description: 'Only return events carrying this tag.' },
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
    "For browsing/filtering events use `event_list`. " +
    'Returns a `url` permalink — link the event as a markdown `[title](url)` when you reference it to the user.',
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: "The event's id (UUID) — from `event_list` / `search_nodes`.",
      },
    },
    required: ['id'],
  },
  preconditions: EVENT_ID_PRE,
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const id = str(input.id);
    if (!id) return { ok: false, error: 'id required' };
    const row = await getEvent(ctx.ownerId, id);
    if (!row) return notFound('event', id, 'event_list');
    return { ok: true, output: { ...row, url: nodeUrl(row.id) } };
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
      title: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: "Short event title as shown in lists and reminders, e.g. 'Dentist appointment'.",
      },
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
      location: {
        type: 'string',
        maxLength: 200,
        description: "Where it happens — free text, e.g. 'Cape Town office' or a meeting link.",
      },
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
    "Update an existing event. Omitted fields stay unchanged EXCEPT `endsAt` and `location`, which are CLEARED when omitted — re-pass their current values to keep them. If you move `startsAt` or `remindMinutesBefore` and the new reminder time lands in the future, a previously-sent reminder fires again. `startsAt` / `endsAt` are UTC ISO 8601 instants. Set `recur` to make it repeat (or 'none' to stop repeating); `recurUntil` caps the series.",
  inputSchema: {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: "The event's id (UUID) — from `event_list` / `search_nodes`.",
      },
      title: {
        type: 'string',
        minLength: 1,
        maxLength: 200,
        description: 'New title; omit to keep current.',
      },
      startsAt: { type: 'string', description: 'UTC ISO 8601.' },
      endsAt: { type: 'string', description: 'UTC ISO 8601. Cleared when omitted.' },
      body: { type: 'string', description: 'New details / notes; omit to keep current.' },
      location: {
        type: 'string',
        maxLength: 200,
        description: 'Free-text place or meeting link. Cleared when omitted — re-pass to keep.',
      },
      remindMinutesBefore: {
        type: 'integer',
        minimum: 0,
        maximum: 60 * 24 * 30,
        description:
          'Minutes before startsAt to fire the Telegram reminder; omit to keep current.',
      },
      timezone: {
        type: 'string',
        description: 'IANA timezone for display in the reminder; omit to keep current.',
      },
      recur: {
        type: 'string',
        enum: ['none', 'daily', 'weekly', 'monthly', 'yearly'],
        description: "Repeat frequency; 'none' turns recurrence off.",
      },
      recurUntil: {
        type: 'string',
        description: 'Optional UTC ISO 8601 end-of-series cutoff.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: "Replaces the whole tag list, e.g. ['work']; omit to keep current.",
      },
    },
    required: ['id'],
  },
  preconditions: EVENT_ID_PRE,
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
      if (!row) return notFound('event', id, 'event_list');
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
    properties: {
      id: {
        type: 'string',
        description: "The event's id (UUID) — from `event_list` / `search_nodes`.",
      },
    },
    required: ['id'],
  },
  preconditions: EVENT_ID_PRE,
  handler: async (input, ctx): Promise<ToolHandlerResult> => {
    const id = str(input.id);
    if (!id) return { ok: false, error: 'id required' };
    const ok = await deleteEvent(ctx.ownerId, id);
    ctx.step?.setMeta({ eventId: id, deleted: ok });
    return ok
      ? { ok: true, output: { deleted: true, id } }
      : notFound('event', id, 'event_list');
  },
};

export const EVENT_TOOLS: readonly BuiltinToolDef[] = [
  event_list,
  event_get,
  event_create,
  event_update,
  event_delete,
];
