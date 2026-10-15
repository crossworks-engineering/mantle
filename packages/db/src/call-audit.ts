/**
 * One audit row for every tool write, on every surface, written by the gate
 * (workspaces arch A5 step 6d; gateway survey finding 6). Before, only the
 * owner's web routes (their own `api.write` row per request) and an API
 * key's MCP writes left a row; an agent's tool writes (a web or Telegram
 * turn, a heartbeat, a run item, a recipe step, an approved call), an app
 * broker's and a login's own MCP builtin writes left none.
 *
 * enterCall runs a call of an audited ref kind (the tool kinds the tools
 * package registers: a builtin, a runtime row, an MCP tool) inside a frame.
 * After the call ran:
 *  - a call whose policy writes and that succeeded (the registered
 *    `succeeded`: not a refusal or a failed result) is a write;
 *  - a write nested in another audited call (a recipe's step, a delegated
 *    agent's call, an approved call run by `pending_approve`) is named in
 *    the outer call's row (`detail.nested`), not a row of its own, so one
 *    call is one row; the outer call writes a row when it wrote itself or
 *    any call in it did;
 *  - a surface that writes its own row for the call is not written again:
 *    one frame flag, set from inside the call (an MCP connector call's
 *    `mcp.connector.*` row, markCallAudited) or by its caller (an API
 *    key's MCP call, whose route writes its row: `facts.audit.byRoute`).
 * Reads leave no row. The row is fire and forget (callAuditsSettled for
 * tests): it never fails or slows the call it describes.
 *
 * Writing is off until a process turns it on at boot (startCallAudit): the
 * web server, its workers, the API process (Telegram, heartbeats, runs) and
 * the stdio MCP server. Unit tests that run tool calls write nothing.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import { runAsActor, systemActor, type Actor } from './actor';
import { afterOuterCommit, systemDb } from './client';
import { UUID_RE } from '@mantle/std';

/** One finished call, as the gate saw it (the caller bound, its ref and
 *  policy, the call's input, the value `fn` gave back). */
export type AuditedCall = Readonly<{
  caller: Readonly<{
    actor: Actor | null;
    via: string;
    loginId?: string | null;
    facts?: Readonly<Record<string, unknown>>;
  }>;
  ref: Readonly<{ kind: string; name: string; [k: string]: unknown }>;
  policy: Readonly<{ effect: 'read' | 'write' }>;
  input: Readonly<{ args?: Record<string, unknown>; context?: Readonly<Record<string, unknown>> }>;
  value: unknown;
  /** The call itself wrote and succeeded. */
  wrote: boolean;
  /** The writes nested in it (their labels), in the order they ran. */
  nested: readonly string[];
  /** What the call and the writes nested in it note for its row
   *  (CallAuditSpec.notes: an approved call's approver). */
  notes: Readonly<Record<string, unknown>>;
}>;

/** What the row says beyond its actor. */
export type AuditRowParts = Readonly<{
  method: string;
  path: string | null;
  detail: Record<string, unknown>;
  /** The actor label when the actor names no login with an email. */
  actorLabel: string;
}>;

/** How the tools package reads a call (registered once, at its import). */
export type CallAuditSpec = Readonly<{
  /** The ref kinds that are tool calls (a route is audited by its own
   *  guard, never here). */
  kinds: readonly string[];
  /** Whether `value` is a call that did its work (not a failed result). */
  succeeded: (value: unknown) => boolean;
  /** Whether the call's own run writes, beside the calls in it (default
   *  yes): a recipe row writes only through its steps; a routine write of
   *  internal state by its arguments (lows round, 6d L5). */
  writesItself?: (call: Pick<AuditedCall, 'ref' | 'input'>) => boolean;
  /** How a nested write is named in its outer call's row. */
  label: (call: Pick<AuditedCall, 'ref' | 'input'>) => string;
  /** What a call notes for the row it is written in (its own, or its
   *  outer call's when nested): an approved call's approver (A5 step 6d
   *  fix round 1), so the row of `pending_approve` names it too. */
  notes?: (call: Pick<AuditedCall, 'ref' | 'input' | 'caller'>) => Record<string, unknown> | null;
  /** The row's method, path, detail and actor label; null: no row. */
  describe: (call: AuditedCall) => AuditRowParts | null;
}>;

let spec: CallAuditSpec | null = null;

/** Register how tool calls are audited (the tools package, at import). The
 *  same spec again is a no-op; another throws, as a narrower does. */
export function registerCallAudit(next: CallAuditSpec): void {
  if (spec === next) return;
  if (spec) throw new Error('registerCallAudit: a call audit is registered already');
  spec = next;
}

/** Tests only: forget the registered spec. */
export function resetCallAudit(): void {
  spec = null;
}

type Meta = { ip: string | null; userAgent: string | null };

/** A row as the gate would write it (startCallAudit's `sink`, tests). */
export type CallAuditRow = Readonly<{
  loginId: string | null;
  actorLabel: string;
  method: string;
  path: string | null;
  meta: Meta | null;
  detail: Record<string, unknown>;
}>;

let writing: {
  meta: (() => Meta | null) | null;
  sink: ((row: CallAuditRow) => void) | null;
} | null = null;

/** Turn the rows on (each process main, at boot). `meta`: the request's
 *  ip and user agent, where the process serves requests (the web server's
 *  request context); none elsewhere. `enabled: false` keeps them off (the
 *  web server in detached dev, which has no local database). */
export function startCallAudit(
  opts: {
    meta?: () => Meta | null;
    enabled?: boolean;
    /** Tests: take each row instead of writing it. */
    sink?: (row: CallAuditRow) => void;
  } = {},
): void {
  writing = opts.enabled === false ? null : { meta: opts.meta ?? null, sink: opts.sink ?? null };
}

/** Tests only: turn the rows off again. */
export function stopCallAudit(): void {
  writing = null;
}

/** Whether rows are written in this process. */
export function callAuditStarted(): boolean {
  return writing !== null;
}

type Frame = {
  nested: string[];
  notes: Record<string, unknown>;
  closed: boolean;
  audited: boolean;
};
const frames = new AsyncLocalStorage<Frame>();

/** A surface wrote its own row for the call it runs in (an MCP connector
 *  call's `mcp.connector.*` row): the gate writes none for it. */
export function markCallAudited(): void {
  const f = frames.getStore();
  if (f && !f.closed) f.audited = true;
}

/** Whether a call of `kind` is audited (a tool kind, once registered). */
export function auditsKind(kind: string): boolean {
  return spec !== null && spec.kinds.includes(kind);
}

/**
 * Run one audited call (`run`: the gate's steps from the pre-run checks to
 * the end of the call) in its frame, then write or hand on what it wrote.
 * `finish` gives the call as the gate saw it, or null when it did not run
 * (a refusal, a throw).
 */
export async function inCallAuditFrame<T>(
  run: () => Promise<T>,
  finish: (
    value: T | null,
    threw: boolean,
  ) => Omit<AuditedCall, 'wrote' | 'nested' | 'notes'> | null,
  /** The surface writes the call's row itself (an API key's MCP call: its
   *  route's row): the gate writes none, as markCallAudited marks it from
   *  inside the call. */
  opts: { audited?: boolean } = {},
): Promise<T> {
  const parent = frames.getStore();
  const frame: Frame = { nested: [], notes: {}, closed: false, audited: opts.audited === true };
  let value: T | null = null;
  let threw = false;
  try {
    value = await frames.run(frame, run);
    return value;
  } catch (err) {
    threw = true;
    throw err;
  } finally {
    frame.closed = true;
    try {
      const call = finish(value, threw);
      if (call) settle(frame, parent, call, threw);
    } catch (err) {
      console.error('[audit] a tool call audit failed:', err);
    }
  }
}

function settle(
  frame: Frame,
  parent: Frame | undefined,
  base: Omit<AuditedCall, 'wrote' | 'nested' | 'notes'>,
  threw: boolean,
): void {
  const a = spec;
  if (!a) return;
  const wrote =
    !threw &&
    base.policy.effect === 'write' &&
    (a.writesItself?.(base) ?? true) &&
    a.succeeded(base.value);
  if (!wrote && frame.nested.length === 0) return;
  const notes = { ...frame.notes, ...(a.notes?.(base) ?? {}) };
  if (parent && !parent.closed) {
    if (wrote) parent.nested.push(a.label(base));
    parent.nested.push(...frame.nested);
    Object.assign(parent.notes, notes);
    return;
  }
  // The surface wrote the call's row itself (markCallAudited, or the
  // caller's `byRoute`): none here, nested writes and all, as before.
  if (frame.audited) return;
  const call: AuditedCall = { ...base, wrote, nested: [...frame.nested], notes };
  const parts = a.describe(call);
  if (parts) writeRow(call, parts);
}

/** Who writes a tool call's row. */
const AUDIT_ACTOR = systemActor('audit:tool-call');

/** The rows in flight, each until it settles (callAuditsSettled). */
const inFlight = new Set<Promise<void>>();

/** The request's ip and user agent, where the process serves requests;
 *  null when it does not, or the read fails. */
function requestMeta(w: NonNullable<typeof writing>): Meta | null {
  try {
    return w.meta?.() ?? null;
  } catch {
    return null;
  }
}

function writeRow(call: AuditedCall, parts: AuditRowParts): void {
  const w = writing;
  if (!w) return;
  const actor = call.caller.actor;
  const loginId = call.caller.loginId ?? (actor?.kind === 'login' ? actor.loginId : null);
  const row: CallAuditRow = {
    loginId,
    actorLabel: parts.actorLabel,
    method: parts.method,
    path: parts.path,
    meta: requestMeta(w),
    detail: parts.detail,
  };
  // Once the transaction the call's writes joined commits (a request's
  // write transaction, a scope's): a call whose writes roll back with it
  // leaves no row (A5 step 6d fix round 1). Outside one (a turn's per-query
  // transactions, a process's own call) the writes have committed: now.
  void afterOuterCommit(() => startRow(w, row)).catch((err: unknown) => {
    console.error(`[audit] failed to record a tool write (${String(parts.detail.tool)}):`, err);
  });
}

function startRow(w: NonNullable<typeof writing>, row: CallAuditRow): void {
  if (w.sink) {
    w.sink(row);
    return;
  }
  // One statement: the login's email (the trail survives the login's
  // deletion). As the system, whatever the call ran as (a read-only actor
  // never writes here, an actor-less call is not refused for its row).
  const login = row.loginId && UUID_RE.test(row.loginId) ? row.loginId : null;
  const write = runAsActor(AUDIT_ACTOR, () =>
    systemDb.execute(
      sql`insert into audit_log (actor_id, actor_email, action, method, path, ip, user_agent, detail)
          select u.id, coalesce(u.email, ${row.actorLabel}), 'api.write', ${row.method},
                 ${row.path}, ${row.meta?.ip ?? null}, ${row.meta?.userAgent ?? null},
                 ${JSON.stringify(row.detail)}::jsonb
            from (select ${login}::uuid as id) l
            left join auth.users u on u.id = l.id`,
    ),
  ).then(
    () => undefined,
    (err: unknown) => {
      console.error(`[audit] failed to record a tool write (${String(row.detail.tool)}):`, err);
    },
  );
  inFlight.add(write);
  void write.finally(() => inFlight.delete(write));
}

/** Tests: resolves once every row started has settled. */
export async function callAuditsSettled(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}
