/**
 * The MCP call log's row (Journal v3 J8): what one tools/call through the
 * one gateway (gated-tools.ts registerGatedTool) leaves in `mcp_calls`. The
 * gateway calls logMcpCall once per call, whatever the tool, the transport
 * or the login kind; @mantle/db mcp-call-log.ts writes the row, fire and
 * forget.
 *
 * Kept: the arguments with secrets redacted (a value under a key that reads
 * as a secret, a field the builtin marks sensitive, the value of a header
 * pair named as a secret, a token or key inside a string, every value of a
 * `secret_*` tool) and capped at about 4 KB; the refusal or thrown text,
 * its tokens redacted, capped at about 1 KB; the item ids the
 * arguments and the top-level reply name (at most 50); the reply's size.
 * Never the reply itself. The row is shaped after the reply went out
 * (setImmediate), and only in a process that writes rows (callAuditStarted).
 */
import { callAuditStarted, noteMcpCallLost, recordMcpCall, type McpCallEntry } from '@mantle/db';
import { UUID_RE, errorMessage, maskKeyLiterals } from '@mantle/std';
import { getBuiltinRedactFields } from '@mantle/tools';
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

/** A word of a key name that makes its value a secret. */
const SECRET_WORDS = new Set([
  'pass',
  'password',
  'passwd',
  'passphrase',
  'secret',
  'secrets',
  'token',
  'apikey',
  'authorization',
  'authorisation',
  'cookie',
  'credential',
  'credentials',
  'privatekey',
  'bearer',
]);
/** A word run together with one of these at its end, or `secret` at its
 *  start, is a secret too (PGPASSWORD, DBPASS, ACCESSTOKEN, SECRETKEY). */
const SECRET_RUN_TOGETHER = /(?:password|passwd|pass|token|secret)$|^secret/;
/** Words that only look run together. */
const NOT_SECRET_WORDS = new Set([
  'compass',
  'encompass',
  'bypass',
  'surpass',
  'trespass',
  'overpass',
  'underpass',
  'secretary',
  'secretariat',
]);
const isSecretWord = (w: string): boolean =>
  SECRET_WORDS.has(w) || (!NOT_SECRET_WORDS.has(w) && SECRET_RUN_TOGETHER.test(w));
/** `<word>_key` is a secret for these words (api_key, private_key). */
const KEY_OWNERS = new Set(['api', 'private', 'access', 'secret']);
/** A key that ends in one of these names a secret, never holds one
 *  (secret_ref is a vault reference, token_url an endpoint). */
const NOT_SECRET_LAST = new Set(['ref', 'url', 'uri']);

/** Does a key name read as a secret? By its words, and a word run
 *  together that ends in a secret's name: `pass` is not `passage` or
 *  `compass`, `token` is not `max_tokens`. */
export function isSecretKey(key: string): boolean {
  const words = key
    .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  const last = words[words.length - 1];
  if (last === undefined || NOT_SECRET_LAST.has(last)) return false;
  if (words.length === 1 && last === 'key') return true;
  return words.some(
    (w, i) => isSecretWord(w) || (w === 'key' && i > 0 && KEY_OWNERS.has(words[i - 1]!)),
  );
}

/** A tool whose every argument value is never kept: secret_create, the
 *  vault's api_key_set and api_key_import (a value sent in the wrong field
 *  is still never kept), and a connector's mcp_<conn>_secret_set or
 *  mcp_<conn>_get_secret. */
const SECRET_TOOL = /^secret_|^api_key_(?:set|import)$|^mcp_.*(?:_secret_|_secret$)/;

/** Secrets inside a string that @mantle/std maskKeyLiterals (the key
 *  prefixes, `Bearer`, `token=`, bare keys) does not know; each keeps its
 *  lead (the scheme and user of a URL, `password=`, `?sig=`, the prefix)
 *  and loses the rest. Run first, so a JWT is still whole. */
const SECRET_IN_TEXT: readonly RegExp[] = [
  /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+(?=@)/gi,
  /\b((?:password|passwd|pwd)\s*=\s*)[^;&\s"']+/gi,
  /\b(eyJ)[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g,
  /\b(AKIA)[0-9A-Z]{16}\b/g,
  /([?&](?:key|token|api_key|apikey|access_token|sig|signature)=)[^&#\s"']+/gi,
];

/** `s` with the tokens and keys it carries redacted. */
export function redactText(s: string): string {
  let out = s;
  for (const re of SECRET_IN_TEXT) out = out.replace(re, `$1${REDACTED}`);
  return maskKeyLiterals(out, REDACTED);
}

/** `s` cut to at most `max` UTF-16 units, never inside a surrogate pair
 *  (a lone surrogate is refused by jsonb, and the row with it). */
function clipChars(s: string, max: number): string {
  if (s.length <= max) return s;
  const c = s.charCodeAt(max - 1);
  return s.slice(0, c >= 0xd800 && c <= 0xdbff ? max - 1 : max);
}

/** `s` cut to at most `max` bytes of UTF-8, at a character's start. */
function clipBytes(s: string, max: number): string {
  const buf = Buffer.from(s);
  if (buf.length <= max) return s;
  let end = max;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}

/** `s` redacted and cut to `max` units. Only the start is read (a 6 MB
 *  upload is not scanned), and a little past the cut, so a token at the
 *  edge is redacted whole before the cut. */
function redactClip(s: string, max: number): { text: string; cut: boolean } {
  const text = redactText(clipChars(s, max + 256));
  if (text.length > max) return { text: clipChars(text, max), cut: true };
  return { text, cut: s.length > max + 256 };
}

/** An object's label when it is a name/value pair ({name, value}, the
 *  shape of a header list). */
function pairLabel(o: Record<string, unknown>): string | null {
  for (const k of ['name', 'key', 'header']) {
    const v = o[k];
    if (typeof v === 'string') return v;
  }
  return null;
}

function redactValue(v: unknown, depth: number): unknown {
  if (typeof v === 'string') {
    const { text, cut } = redactClip(v, STRING_MAX);
    return cut ? `${text}…` : text;
  }
  if (v === null || typeof v !== 'object') {
    return typeof v === 'number' || typeof v === 'boolean' ? v : v === null ? null : String(v);
  }
  if (depth >= DEPTH_MAX) return '[…]';
  if (Array.isArray(v)) {
    const out = v.slice(0, 50).map((x) => redactValue(x, depth + 1));
    if (v.length > 50) out.push(`[${v.length - 50} more]`);
    return out;
  }
  const o = v as Record<string, unknown>;
  const label = pairLabel(o);
  const secretPair = label !== null && isSecretKey(label);
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) {
    out[k] = isSecretKey(k) || (secretPair && k === 'value') ? REDACTED : redactValue(x, depth + 1);
  }
  return out;
}

/** The arguments as the log keeps them: secrets redacted, capped. */
export function redactArgs(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  if (SECRET_TOOL.test(tool)) {
    return { redacted: true, keys: Object.keys(args).slice(0, 50) };
  }
  const kept = redactValue(args, 0) as Record<string, unknown>;
  // The fields the builtin itself marks sensitive (what the tool loop
  // redacts before trace_steps).
  for (const f of getBuiltinRedactFields(tool)) {
    if (f in kept) kept[f] = REDACTED;
  }
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
    if (out.size >= ITEM_IDS_MAX || depth > DEPTH_MAX || isSecretKey(key)) return;
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
  // The items, not the workspace the call named or landed in.
  const ids = new Set([...argItemIds(call.tool, args), ...seen.itemIds]);
  if (workspaceId) ids.delete(workspaceId);
  return {
    loginId: call.loginId ?? null,
    via: call.via,
    workspaceId,
    tool: call.tool,
    args: redactArgs(call.tool, args),
    ok: seen.ok,
    error:
      seen.error === null
        ? null
        : clipBytes(redactClip(seen.error, ERROR_MAX_BYTES).text, ERROR_MAX_BYTES),
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
      noteMcpCallLost(err);
    }
  });
}
