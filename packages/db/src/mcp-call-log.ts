/**
 * The MCP call log (Journal v3 J8, migration 0345): one `mcp_calls` row per
 * MCP tools/call. The one MCP gateway (@mantle/mcp-core gated-tools.ts)
 * shapes the row (call-log.ts: the redacted, capped arguments, the ids, the
 * sizes) and hands it here; nothing else writes the table.
 *
 * Fire and forget, as the tool call audit (call-audit.ts): the row never
 * fails, slows or changes the call it describes. At most MAX_IN_FLIGHT rows
 * are in flight; a row past that is dropped and counted, never queued. A
 * failed insert is counted and said on the console at most once every ten
 * minutes, never retried. Rows are written only in a process that turned
 * the tool call audit on at boot (startCallAudit: the web server and the
 * stdio MCP server), so unit tests write none.
 *
 * The work session (`session_id`) is read in the insert itself: the session
 * of the login's last call when that was within MCP_SESSION_GAP_MINUTES,
 * else a new one (one indexed lookup, mcp_calls_login_created_idx). A
 * client fires calls in parallel, so one login's rows are written one after
 * the other in a process (each waits for the login's row before it): the
 * first burst of a session lands in one session. Two processes (the web
 * server and a stdio server) writing for one login at the same instant may
 * still open two; a later reader merges by time if it cares.
 *
 * Reads (listMcpCalls) run on `db` in the caller's scope: the row rule of
 * 0345 gives a login its own rows and an Admin user's scope every row.
 */
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { UUID_RE } from '@mantle/std';
import { runAsActor, systemActor } from './actor';
import { callAuditStarted } from './call-audit';
import { db, systemDb } from './client';
import { mcpCalls, type McpCallRow } from './schema/mcp-calls';

/** A login's calls this close together are one work session. */
export const MCP_SESSION_GAP_MINUTES = 30;
/** Rows older than this go (the nightly `mcp-calls-reap` sweep). */
export const MCP_CALLS_RETENTION_DAYS = 90;
/** Rows in flight at once; past it a row is dropped and counted. */
export const MCP_CALL_LOG_MAX_IN_FLIGHT = 32;

/** One call, as the gateway shaped it (call-log.ts in @mantle/mcp-core). */
export type McpCallEntry = Readonly<{
  loginId: string | null;
  via: string;
  workspaceId: string | null;
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  error: string | null;
  durationMs: number;
  itemIds: readonly string[];
  resultBytes: number;
}>;

/** Who writes a row. */
const MCP_CALL_ACTOR = systemActor('audit:mcp-call');

const uuidOrNull = (v: string | null): string | null =>
  v && UUID_RE.test(v) ? v.toLowerCase() : null;

/** The session the row joins: the login's last call within the gap, else a
 *  new one. */
function sessionIdSql(loginId: string | null) {
  return sql`coalesce(
    (select c."session_id" from "public"."mcp_calls" c
      where c."login_id" = ${loginId}::uuid
        and c."created_at" > now() - make_interval(mins => ${MCP_SESSION_GAP_MINUTES})
      order by c."created_at" desc limit 1),
    gen_random_uuid())`;
}

/** The insert of one row (the default writer). */
async function insertRow(e: McpCallEntry): Promise<void> {
  const loginId = uuidOrNull(e.loginId);
  await runAsActor(MCP_CALL_ACTOR, () =>
    systemDb.insert(mcpCalls).values({
      loginId,
      via: e.via,
      workspaceId: uuidOrNull(e.workspaceId),
      sessionId: sessionIdSql(loginId),
      tool: e.tool,
      args: e.args,
      ok: e.ok,
      error: e.error,
      durationMs: Math.max(0, Math.round(e.durationMs)),
      itemIds: e.itemIds.filter((id) => UUID_RE.test(id)),
      resultBytes: Math.max(0, Math.round(e.resultBytes)),
    }),
  );
}

let write: (e: McpCallEntry) => Promise<void> = insertRow;

/** Tests: take each row instead of inserting it (null: insert again). */
export function setMcpCallWriter(fn: ((e: McpCallEntry) => Promise<void>) | null): void {
  write = fn ?? insertRow;
}

const inFlight = new Set<Promise<void>>();
/** Each login's last row in flight: its next row waits for it. */
const tails = new Map<string, Promise<void>>();
const stats = { written: 0, dropped: 0, failed: 0 };
let lastWarnAt = 0;
const WARN_EVERY_MS = 10 * 60_000;

/** A row lost (dropped, or its insert failed): counted, said at most once
 *  every ten minutes. */
function lost(what: string, err?: unknown): void {
  const now = Date.now();
  if (now - lastWarnAt < WARN_EVERY_MS) return;
  lastWarnAt = now;
  console.error(
    `[mcp-call-log] ${what} (dropped ${stats.dropped}, failed ${stats.failed} so far)`,
    err ?? '',
  );
}

/** A row lost before it reached recordMcpCall (the gateway could not shape
 *  it): counted as failed, said as a failed insert is. */
export function noteMcpCallLost(err: unknown): void {
  stats.failed += 1;
  lost('a call could not be shaped for the log', err);
}

/** Record one call: fire and forget, bounded. Never throws. */
export function recordMcpCall(entry: McpCallEntry): void {
  if (!callAuditStarted()) return;
  if (inFlight.size >= MCP_CALL_LOG_MAX_IN_FLIGHT) {
    stats.dropped += 1;
    lost('a call was not logged: too many rows in flight');
    return;
  }
  // After the login's row before it, so it reads that row's session.
  const key = entry.loginId ?? '';
  const prev = tails.get(key) ?? Promise.resolve();
  const p = prev.then(() => write(entry));
  const row = p.then(
    () => {
      stats.written += 1;
    },
    (err: unknown) => {
      stats.failed += 1;
      lost('a call was not logged: its insert failed', err);
    },
  );
  inFlight.add(row);
  tails.set(key, row);
  void row.finally(() => {
    inFlight.delete(row);
    if (tails.get(key) === row) tails.delete(key);
  });
}

/** The counts since the process started (tests, diagnostics). */
export function mcpCallLogStats(): Readonly<typeof stats> {
  return { ...stats };
}

/** Tests: resolves once every row started has settled. */
export async function mcpCallsSettled(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}

/** What a read of the log may narrow to. */
export type McpCallFilter = Readonly<{
  loginId?: string;
  sessionId?: string;
  tool?: string;
  /** Rows older than this (the next page). */
  before?: Date;
  limit?: number;
}>;

/** The newest rows the caller's scope reads (the row rule: its own, or
 *  every row in an Admin user's scope), newest first. */
export async function listMcpCalls(filter: McpCallFilter = {}): Promise<McpCallRow[]> {
  const limit = Math.min(Math.max(1, Math.floor(filter.limit ?? 50)), 200);
  return db
    .select()
    .from(mcpCalls)
    .where(
      and(
        filter.loginId ? eq(mcpCalls.loginId, filter.loginId) : undefined,
        filter.sessionId ? eq(mcpCalls.sessionId, filter.sessionId) : undefined,
        filter.tool ? eq(mcpCalls.tool, filter.tool) : undefined,
        filter.before ? lt(mcpCalls.createdAt, filter.before) : undefined,
      ),
    )
    .orderBy(desc(mcpCalls.createdAt), desc(mcpCalls.id))
    .limit(limit);
}

const REAP_BATCH = 10_000;

/** Delete the rows past the retention (the `mcp-calls-reap` sweep, plain
 *  SQL in batches, no model). `dryRun` counts without deleting. Idempotent. */
export async function reapMcpCalls(
  opts: { now?: Date; dryRun?: boolean } = {},
): Promise<{ deleted: number }> {
  const now = opts.now ?? new Date();
  const cutoff = new Date(
    now.getTime() - MCP_CALLS_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  if (opts.dryRun) {
    const [row] = (await db.execute(
      sql`select count(*)::int as n from "public"."mcp_calls" where created_at < ${cutoff}::timestamptz`,
    )) as unknown as { n: number }[];
    return { deleted: row?.n ?? 0 };
  }
  let deleted = 0;
  for (;;) {
    const gone = await db
      .delete(mcpCalls)
      .where(
        sql`${mcpCalls.id} in (
          select id from "public"."mcp_calls" where created_at < ${cutoff}::timestamptz limit ${REAP_BATCH})`,
      )
      .returning({ id: mcpCalls.id });
    deleted += gone.length;
    if (gone.length < REAP_BATCH) return { deleted };
  }
}
