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
 *  - a surface that writes its own row for the call (an MCP connector
 *    call's `mcp.connector.*`, markCallAudited) is not written again.
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
import { systemDb } from './client';

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
  /** Whether the ref's own run writes, beside the calls in it (default
   *  yes): a recipe row writes only through its steps. */
  writesItself?: (ref: AuditedCall['ref']) => boolean;
  /** How a nested write is named in its outer call's row. */
  label: (call: Pick<AuditedCall, 'ref' | 'input'>) => string;
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

type Frame = { nested: string[]; closed: boolean; audited: boolean };
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
  finish: (value: T | null, threw: boolean) => Omit<AuditedCall, 'wrote' | 'nested'> | null,
): Promise<T> {
  const parent = frames.getStore();
  const frame: Frame = { nested: [], closed: false, audited: false };
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
  base: Omit<AuditedCall, 'wrote' | 'nested'>,
  threw: boolean,
): void {
  const a = spec;
  if (!a) return;
  const wrote =
    !threw &&
    base.policy.effect === 'write' &&
    (a.writesItself?.(base.ref) ?? true) &&
    a.succeeded(base.value);
  if (!wrote && frame.nested.length === 0) return;
  if (parent && !parent.closed) {
    if (wrote) parent.nested.push(a.label(base));
    parent.nested.push(...frame.nested);
    return;
  }
  if (frame.audited && frame.nested.length === 0) return;
  const call: AuditedCall = { ...base, wrote, nested: [...frame.nested] };
  const parts = a.describe(call);
  if (parts) writeRow(call, parts);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who writes a tool call's row. */
const AUDIT_ACTOR = systemActor('audit:tool-call');

/** The rows in flight, each until it settles (callAuditsSettled). */
const inFlight = new Set<Promise<void>>();

function writeRow(call: AuditedCall, parts: AuditRowParts): void {
  const w = writing;
  if (!w) return;
  const actor = call.caller.actor;
  const loginId = call.caller.loginId ?? (actor?.kind === 'login' ? actor.loginId : null);
  let meta: Meta | null = null;
  try {
    meta = w.meta?.() ?? null;
  } catch {
    meta = null;
  }
  if (w.sink) {
    w.sink({
      loginId,
      actorLabel: parts.actorLabel,
      method: parts.method,
      path: parts.path,
      meta,
      detail: parts.detail,
    });
    return;
  }
  // One statement: the login's email (the trail survives the login's
  // deletion). As the system, whatever the call ran as (a read-only actor
  // never writes here, an actor-less call is not refused for its row).
  const login = loginId && UUID_RE.test(loginId) ? loginId : null;
  const write = runAsActor(AUDIT_ACTOR, () =>
    systemDb.execute(
      sql`insert into audit_log (actor_id, actor_email, action, method, path, ip, user_agent, detail)
          select u.id, coalesce(u.email, ${parts.actorLabel}), 'api.write', ${parts.method},
                 ${parts.path}, ${meta?.ip ?? null}, ${meta?.userAgent ?? null},
                 ${JSON.stringify(parts.detail)}::jsonb
            from (select ${login}::uuid as id) l
            left join auth.users u on u.id = l.id`,
    ),
  ).then(
    () => undefined,
    (err: unknown) => {
      console.error(`[audit] failed to record a tool write (${String(parts.detail.tool)}):`, err);
    },
  );
  inFlight.add(write);
  void write.finally(() => inFlight.delete(write));
}

/** Tests: resolves once every row started has settled. */
export async function callAuditsSettled(): Promise<void> {
  while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}
