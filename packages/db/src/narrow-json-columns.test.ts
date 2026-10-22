/**
 * Every JSON column the narrow login may write (access-matrix.ts
 * NARROW_WRITES: an UPDATE column, or any JSON column of a table it may
 * INSERT into), each with its decision (the narrow login part b2, round 13b,
 * item C: a prompt-bearing or limit key in a narrow-writable JSON column
 * is either held by a row rule or the column leaves the narrow list).
 * A new JSON column on the list fails here until it is decided.
 */
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { NARROW_WRITES } from './access-matrix';
import * as schema from './schema';

/** column -> its decision. */
const DECIDED: Readonly<Record<string, string>> = {
  'public.agents.avatar':
    'update: the avatar style, seed and parts (a picture), no prompt and no limit key',
  'public.assistant_messages.data':
    "insert and update: 0322's guard: a pending row is the turn's own until it settles; a settled row gains only the follow-up suggestion (suggestion, suggestedAt), every other key kept",
  'public.assistant_messages.attachments':
    "insert only: the media of the turn's own new row (0322: its assistant, workspace and login checked); never rewritten once settled",
  'public.assistant_messages.external_ref':
    "insert only: the transport's ids of the turn's own new row (reply threading), no prompt",
  'public.app_access_log.detail': 'insert only: an access log line, read by no model',
  'public.audit_log.detail': 'insert only: an audit line, read by no model',
  'public.calendar_accounts.sync_state':
    "insert only: a new feed's sync cursor (the owner's feed, NARROW_REINSERT_HELD), no prompt",
  'public.heartbeat_fires.state_before': "insert only: a fire's log row, after the fire",
  'public.heartbeat_fires.state_after': "insert only: a fire's log row, after the fire",
  'public.heartbeat_fires.reply_surface_ref': "insert only: a fire's log row, after the fire",
  'public.pending_tool_calls.result':
    "update: a decided call's outcome (status, result: round 8); the narrow login holds no INSERT of a call nor a write of its tool or arguments",
  'public.trace_steps.input': "insert only: a trace's step log (observability), read by no turn",
  'public.trace_steps.output': "insert and update: a trace's step log, read by no turn",
  'public.trace_steps.meta': "insert and update: a trace's step log, read by no turn",
  'public.traces.data': "insert and update: a trace's summary (observability), read by no turn",
  'public.turn_stream_buffer.event':
    "insert only (round 13b, item G): a turn's live stream event, replayed to the browser of the turn's owner, never a prompt",
};

/** Taken off the narrow list in round 13b (their edits run at skill-text):
 *  nearly every key is a prompt or a limit, and a kept-key list would leave
 *  a new key open. */
const OFF_THE_LIST = [
  'public.agents.memory_config',
  'public.agents.params',
  'public.ai_workers.params',
];

function narrowJsonColumns(): string[] {
  const tables = new Map<string, ReturnType<typeof getTableConfig>>();
  for (const v of Object.values(schema)) {
    try {
      const c = getTableConfig(v as PgTable);
      tables.set(`${c.schema ?? 'public'}.${c.name}`, c);
    } catch {
      // not a table
    }
  }
  const out: string[] = [];
  for (const [t, w] of Object.entries(NARROW_WRITES)) {
    const c = tables.get(t);
    if (!c) continue;
    for (const col of c.columns) {
      if (!/json/i.test(col.getSQLType())) continue;
      const up = Array.isArray(w.update) && w.update.includes(col.name);
      if (up || w.insert) out.push(`${t}.${col.name}`);
    }
  }
  return out.sort();
}

describe('the narrow login`s JSON columns (round 13b, item C)', () => {
  it('every one the narrow login may write is decided, and none more', () => {
    expect(narrowJsonColumns()).toEqual(Object.keys(DECIDED).sort());
  });

  it('the limit and prompt columns are off the list', () => {
    const cols = new Set(narrowJsonColumns());
    for (const c of OFF_THE_LIST) expect(cols.has(c), c).toBe(false);
  });
});
