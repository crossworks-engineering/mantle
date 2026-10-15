/**
 * How a tool call is audited (A5 step 6d; gateway survey finding 6): the
 * spec the gate's call audit reads (@mantle/db call-audit.ts). The gate
 * writes one `api.write` row for every tool write that succeeded, on every
 * surface, after it ran: a builtin (`tool`), a runtime row (`runtime-tool`:
 * an http, recipe, shell or connector row) and a tool of the owner MCP
 * surface (`mcp-tool`). An app broker's `app-tool` ref is the judgement
 * around the call's own ref, so it is not audited itself.
 *
 * An API key's MCP call keeps the row its route writes (its caller says so:
 * `facts.audit.byRoute`), and an MCP connector call its `mcp.connector.*`
 * row (markCallAudited): both set the one frame flag the gate reads, so no
 * call has two. A /api/v1 route's call writes the route's own row (the
 * request) and the gate's (the tool write), as the dev console and an app
 * broker do.
 *
 * The row: the login (its email; else the actor's kind and the entry), the
 * method (`MCP` on an MCP connection, else `TOOL`) and `/api/mcp` for an
 * HTTP MCP connection, the request's ip and user agent where the process
 * serves requests, and in `detail` the tool, the entry and how it came in,
 * the surface, the ids of the items it named or made, the writes nested in
 * it, and for a peer or an OAuth client its id.
 */
import {
  registerCallAudit,
  type AuditedCall,
  type AuditRowParts,
  type CallAuditSpec,
} from '@mantle/db';
import { currentToolCaller, mcpVia } from './gate-callers';
import { namedToolPolicy } from './tool-policy';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The most item ids and nested writes a row names. */
const MAX_IDS = 20;
const MAX_NESTED = 50;

/** The tool's name as a row names it: a builtin row's slug, a runtime
 *  row's, an MCP tool's listed name. */
function toolName(ref: AuditedCall['ref']): string {
  const slug = typeof ref.slug === 'string' ? ref.slug : ref.name;
  return slug.slice(0, 100);
}

/** The builtin a ref runs, when it runs one. */
function builtinOf(ref: AuditedCall['ref']): string | null {
  if (ref.kind === 'tool') return ref.name;
  if (ref.kind === 'mcp-tool') return typeof ref.builtin === 'string' ? ref.builtin : ref.name;
  return null;
}

/** Whether a call's value is a call that did its work: a tool's result
 *  that is not `ok: false`, an MCP reply that is not an error. */
function succeeded(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const v = value as { ok?: unknown; isError?: unknown };
  return v.ok !== false && v.isError !== true;
}

/** The item ids a call named (its policy's item arguments) and made (its
 *  output's id), at most MAX_IDS. */
function targetsOf(call: AuditedCall): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    for (const x of Array.isArray(v) ? v : [v]) {
      if (typeof x === 'string' && UUID_RE.test(x.trim())) out.add(x.trim().toLowerCase());
    }
  };
  const builtin = builtinOf(call.ref);
  const policy = builtin ? namedToolPolicy(builtin)?.policy : null;
  const args = call.input.args ?? {};
  if (policy && Array.isArray(policy.items)) {
    for (const item of policy.items) add(args[item.param]);
  }
  const output = (call.value as { output?: { id?: unknown } } | null)?.output;
  if (output && typeof output === 'object') add(output.id);
  return [...out].slice(0, MAX_IDS);
}

/** The entry a call came in by (gate-callers.ts ToolCallerEntry), or its
 *  via for a call outside dispatch (an MCP definition's body). */
function entryOf(via: string): string {
  const caller = currentToolCaller();
  if (caller) return caller.entry;
  return mcpVia({ via: via as never }) ? 'mcp' : via;
}

function describe(call: AuditedCall): AuditRowParts | null {
  const via = call.caller.via;
  const entry = entryOf(via);
  const builtin = builtinOf(call.ref);
  const name = toolName(call.ref);
  const surface = (call.input.context?.surface as { kind?: unknown } | undefined)?.kind;
  const row = call.ref.kind === 'runtime-tool' ? (call.ref.row as { handler?: unknown }) : null;
  const rowKind = (row?.handler as { kind?: unknown } | undefined)?.kind;
  const ids = (call.caller.facts?.audit ?? {}) as {
    peerId?: string | null;
    oauthClientId?: string | null;
  };
  const targets = targetsOf(call);
  const http = via === 'oauth' || via === 'key' || via === 'peer';
  const detail: Record<string, unknown> = {
    tool: name,
    ...(builtin && builtin !== name ? { builtin } : {}),
    ...(typeof rowKind === 'string' ? { row: rowKind } : {}),
    entry,
    via,
    ...(typeof surface === 'string' ? { surface } : {}),
    ...(targets.length > 0 ? { targets } : {}),
    ...(call.nested.length > 0 ? { nested: call.nested.slice(0, MAX_NESTED) } : {}),
    // The call failed, after writes nested in it did their work.
    ...(succeeded(call.value) ? {} : { ok: false }),
    ...(ids.peerId ? { peerId: ids.peerId } : {}),
    ...(ids.oauthClientId ? { oauthClientId: ids.oauthClientId } : {}),
    // An approved call's approver (notes), here or in the outer call's row.
    ...call.notes,
  };
  const actor = call.caller.actor;
  return {
    method: mcpVia({ via: via as never }) ? 'MCP' : 'TOOL',
    path: http ? '/api/mcp' : null,
    detail,
    actorLabel: `${actor?.kind ?? 'none'} (${entry})`,
  };
}

/** What a call notes for its row: an approved pending call names its
 *  approver (A5 step 6d fix round 1), on every path that approves (the
 *  web, MCP `pending_approve`, a Telegram tap). The row's actor is whose
 *  rights the call ran with: its asker's, or for an elevated call its
 *  approver's. */
function notes(): Record<string, unknown> | null {
  const caller = currentToolCaller();
  if (caller?.entry !== 'pending' || !caller.approval) return null;
  const narrowed = caller.approval.narrowed ?? [];
  // A call the re-check judged in the scope it was asked in (A5 step 6c):
  // what its asker had then and no more, when anything.
  return {
    approver: caller.approval.approver,
    ...(narrowed.length > 0 ? { narrowed: [...narrowed] } : {}),
  };
}

/** Whether a call's own run is a write the row records: not a recipe row
 *  (it writes only through its steps), and not a builtin whose policy says
 *  its write is routine internal state (`auditRow`, A5 step 6d fix round 1;
 *  `{ unlessArg }` only when the call leaves that argument out, lows round
 *  6d L5: heartbeat_update_state inside a fire, on the firing heartbeat). */
function writesItself(call: Pick<AuditedCall, 'ref' | 'input'>): boolean {
  const ref = call.ref;
  if (ref.kind === 'runtime-tool') {
    return (ref.row as { handler?: { kind?: unknown } } | undefined)?.handler?.kind !== 'recipe';
  }
  const builtin = builtinOf(ref);
  const skip = builtin ? namedToolPolicy(builtin)?.policy.auditRow : undefined;
  if (skip === undefined) return true;
  if (skip === false) return false;
  const named = call.input.args?.[skip.unlessArg];
  return named !== undefined && named !== null && named !== '';
}

/** The spec (one object, so registering it again is a no-op). */
export const TOOL_CALL_AUDIT: CallAuditSpec = Object.freeze({
  kinds: Object.freeze(['tool', 'runtime-tool', 'mcp-tool']),
  succeeded,
  writesItself,
  label: (call: Pick<AuditedCall, 'ref' | 'input'>) => toolName(call.ref),
  notes,
  describe,
});

/** Register the spec (gate-narrowers.ts, with the narrowers). */
export function registerToolCallAudit(): void {
  registerCallAudit(TOOL_CALL_AUDIT);
}
