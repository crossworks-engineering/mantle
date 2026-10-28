/**
 * The MCP call log's row (Journal v3 J8): what one tools/call through the
 * one gateway (gated-tools.ts registerGatedTool) leaves in `mcp_calls`. The
 * gateway calls logMcpCall once per call, whatever the tool, the transport
 * or the login kind; @mantle/db mcp-call-log.ts writes the row, fire and
 * forget.
 *
 * Kept: the arguments with secrets redacted (a value under a key that reads
 * as a secret, every value of a `secret_*` tool) and capped at about 4 KB;
 * the refusal or thrown text, capped at about 1 KB; the item ids the
 * arguments and the top-level reply name (at most 50); the reply's size.
 * Never the reply itself. The row is shaped after the reply went out
 * (setImmediate), and only in a process that writes rows (callAuditStarted).
 */
import { callAuditStarted, recordMcpCall, type McpCallEntry } from '@mantle/db';
import { UUID_RE, errorMessage } from '@mantle/std';
import { WORKSPACE_ARG, replyItemIds } from './create-home';

/** The arguments as stored, at most (serialised). */
export const ARGS_MAX_BYTES = 4096;
/** The error text as stored, at most. */
export const ERROR_MAX_BYTES = 1024;
/** Item ids kept per call. */
export const ITEM_IDS_MAX = 50;
/** A reply text longer than this is not read for ids. */
const REPLY_PARSE_MAX = 256 * 1024;
/** A string argument longer than this is cut. */
const STRING_MAX = 500;
/** How deep the arguments are kept and read for ids. */
const DEPTH_MAX = 4;

export const REDACTED = '[redacted]';

/** A key whose value is never kept. */
const SECRET_KEY =
  /pass(word|phrase)?|secret|token|api[_-]?key|authori[sz]ation|cookie|credential|private[_-]?key|bearer/i;

/** A tool whose every argument value is never kept (secret_create). */
const SECRET_TOOL = /^secret_/;

/** `s` cut to at most `max` bytes of UTF-8. */
function clipBytes(s: string, max: number): string {
  if (Buffer.byteLength(s) <= max) return s;
  return Buffer.from(s).subarray(0, max).toString('utf8');
}

function redactValue(v: unknown, depth: number): unknown {
  if (typeof v === 'string') return v.length > STRING_MAX ? `${v.slice(0, STRING_MAX)}…` : v;
  if (v === null || typeof v !== 'object') {
    return typeof v === 'number' || typeof v === 'boolean' ? v : v === null ? null : String(v);
  }
  if (depth >= DEPTH_MAX) return '[…]';
  if (Array.isArray(v)) {
    const out = v.slice(0, 50).map((x) => redactValue(x, depth + 1));
    if (v.length > 50) out.push(`[${v.length - 50} more]`);
    return out;
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? REDACTED : redactValue(x, depth + 1);
  }
  return out;
}

/** The arguments as the log keeps them: secrets redacted, capped. */
export function redactArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  if (SECRET_TOOL.test(tool)) {
    return { redacted: true, keys: Object.keys(args).slice(0, 50) };
  }
  const kept = redactValue(args, 0) as Record<string, unknown>;
  const text = JSON.stringify(kept);
  if (Buffer.byteLength(text) <= ARGS_MAX_BYTES) return kept;
  // Too big: the top-level keys and the start of the (redacted) JSON.
  return {
    truncated: true,
    keys: Object.keys(args).slice(0, 50),
    json: clipBytes(text, ARGS_MAX_BYTES - 512),
  };
}

/** The UUIDs an argument value names, at any depth up to DEPTH_MAX. */
export function argItemIds(tool: string, args: Record<string, unknown>): string[] {
  if (SECRET_TOOL.test(tool)) return [];
  const out = new Set<string>();
  const walk = (v: unknown, key: string, depth: number) => {
    if (out.size >= ITEM_IDS_MAX || depth > DEPTH_MAX || SECRET_KEY.test(key)) return;
    if (typeof v === 'string') {
      if (UUID_RE.test(v)) out.add(v.toLowerCase());
    } else if (Array.isArray(v)) {
      for (const x of v.slice(0, ITEM_IDS_MAX)) walk(x, key, depth + 1);
    } else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, k, depth + 1);
    }
  };
  walk(args, '', 0);
  return [...out];
}

type Reply = {
  content?: Array<{ type?: string; text?: unknown; data?: unknown }>;
  isError?: boolean;
};

/** What the log reads of a reply: ok, its error text, its size, the ids
 *  its top level names, the workspace a create landed in. */
export function readReply(reply: unknown): {
  ok: boolean;
  error: string | null;
  bytes: number;
  itemIds: string[];
  landedIn: string | null;
} {
  const r = (reply ?? {}) as Reply;
  const content = Array.isArray(r.content) ? r.content : [];
  let bytes = 0;
  for (const c of content) {
    if (typeof c?.text === 'string') bytes += Buffer.byteLength(c.text);
    if (typeof c?.data === 'string') bytes += c.data.length;
  }
  const first = content[0]?.type === 'text' ? content[0].text : undefined;
  const text = typeof first === 'string' ? first : null;
  if (r.isError === true) {
    return { ok: false, error: text, bytes, itemIds: [], landedIn: null };
  }
  let itemIds: string[] = [];
  let landedIn: string | null = null;
  if (text && text.length <= REPLY_PARSE_MAX && /^\s*[[{]/.test(text)) {
    try {
      const parsed: unknown = JSON.parse(text);
      itemIds = replyItemIds(Array.isArray(parsed) ? { items: parsed } : parsed);
      const home =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as { landedIn?: { id?: unknown } }).landedIn
          : undefined;
      if (home && typeof home.id === 'string' && UUID_RE.test(home.id)) landedIn = home.id;
    } catch {
      // Not JSON: no ids.
    }
  }
  return { ok: true, error: null, bytes, itemIds, landedIn };
}

/** One finished call, as the gateway saw it. */
export type McpCallSeen = Readonly<{
  loginId: string | null | undefined;
  via: string;
  tool: string;
  args: unknown;
  /** The reply, when the handler returned one. */
  reply: unknown;
  /** The error, when the handler threw. */
  thrown: unknown;
  threw: boolean;
  durationMs: number;
}>;

/** The row for `call`. */
export function mcpCallEntry(call: McpCallSeen): McpCallEntry {
  const args =
    call.args && typeof call.args === 'object' && !Array.isArray(call.args)
      ? (call.args as Record<string, unknown>)
      : {};
  const seen = call.threw
    ? {
        ok: false,
        error: errorMessage(call.thrown),
        bytes: 0,
        itemIds: [] as string[],
        landedIn: null,
      }
    : readReply(call.reply);
  const asked = args[WORKSPACE_ARG];
  const workspaceId =
    typeof asked === 'string' && UUID_RE.test(asked) ? asked.toLowerCase() : seen.landedIn;
  const ids = new Set([...argItemIds(call.tool, args), ...seen.itemIds]);
  return {
    loginId: call.loginId ?? null,
    via: call.via,
    workspaceId,
    tool: call.tool,
    args: redactArgs(call.tool, args),
    ok: seen.ok,
    error: seen.error === null ? null : clipBytes(seen.error, ERROR_MAX_BYTES),
    durationMs: call.durationMs,
    itemIds: [...ids].slice(0, ITEM_IDS_MAX),
    resultBytes: seen.bytes,
  };
}

/** Log one finished call: shaped after the reply went out, written fire and
 *  forget. Never throws, never waits. */
export function logMcpCall(call: McpCallSeen): void {
  if (!callAuditStarted()) return;
  setImmediate(() => {
    try {
      recordMcpCall(mcpCallEntry(call));
    } catch (err) {
      console.error('[mcp-call-log] a call could not be shaped for the log:', err);
    }
  });
}
