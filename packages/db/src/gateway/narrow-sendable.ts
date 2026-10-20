/**
 * The narrow system route's text check (plan v3.2 S7a): what a statement
 * sent on the narrow role may be (narrowSendable), read on the text with
 * its strings and comments blanked (sqlCode). A guard against mistakes, not
 * against deliberate code; narrow-route.ts sends what passes.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { RuntimeFaultError } from '@mantle/std';
import { runsOutsideTransaction, statementBody } from './actor-sql';

/** A statement the narrow route never sends: one Postgres refuses inside a
 *  transaction block (DDL, maintenance), or one that ends or opens a
 *  transaction (it would run past the role's transaction-local SET). */
export class NarrowRouteRefusedError extends RuntimeFaultError {
  constructor(what: string) {
    super(`narrow system route: ${what} is refused on the narrow role`);
    this.name = 'NarrowRouteRefusedError';
  }
}

/** A transaction-control verb at the start of any statement of the text
 *  (read with its literals and comments blanked, sqlCode). */
const TX_CONTROL =
  /(?:^|;)\s*(?:begin|commit|rollback|abort|end|start\s+transaction|prepare\s+transaction|savepoint|release)\b/i;

/** A role change in any form, at the start of any statement (SET and RESET
 *  are statements of their own; the same words inside an UPDATE are a
 *  column): SET [SESSION | LOCAL] ROLE or SESSION AUTHORIZATION (the name
 *  bare or quoted, with or without a space before the quote), RESET ROLE,
 *  RESET SESSION AUTHORIZATION, RESET ALL.
 *  Read on the text with its strings blanked and its quoted identifiers
 *  kept (sqlCode). */
const ROLE_CHANGE =
  /(?:^|;)\s*(?:set(?:\s+|(?="))(?:(?:session|local)(?:\s+|(?=")))?(?:"?(?:role|session_authorization)"?(?![\w$])|session\s+authorization\b)|reset(?:\s+|(?="))(?:"?(?:role|session_authorization)"?(?![\w$])|all\b|session\s+authorization\b))/i;

/** A session-level SET or RESET at the start of any statement (outlives
 *  the transaction): SET without LOCAL (SET TRANSACTION and SET
 *  CONSTRAINTS are the transaction's own), and any RESET. */
const SESSION_SET =
  /(?:^|;)\s*(?:set(?:\s+(?!\s)|(?="))(?!local(?![\w$])|transaction\b|constraints\b)|reset(?![\w$]))/i;

/** A DO block at the start of any statement: its body is code the text
 *  check cannot read (it may leave the role and take it back before the
 *  hold check). */
const DO_BLOCK = /(?:^|;)\s*do\b/i;

/** pg_settings: an UPDATE of it is set_config(name, value, false) by its
 *  rule, so any statement naming it is refused (a read included). */
const PG_SETTINGS = /\bpg_settings\b/i;

/** A call of set_config, the name bare, quoted or schema-qualified. */
const SET_CONFIG_CALL = /(?<![\w$])"?set_config"?\s*\(/gi;

/** The one shape of a set_config argument a narrow statement may name: a
 *  plain literal (no concatenation, no parameter, no cast, no E'' string). */
const SETTING_LITERAL = /^'[a-z_][a-z0-9_]*(?:\.[a-z0-9_]+)*'$/i;

/**
 * The settings other than mantle.* a narrow statement may set
 * transaction-local, by SET LOCAL or set_config, each with its caller: none
 * can change the role.
 */
export const NARROW_LOCAL_SETTINGS: Readonly<Record<string, string>> = Object.freeze({
  lock_timeout:
    "share-lock.ts, app-broker.ts and oauth-lock.ts: a bounded wait for a lock, the transaction's own",
  statement_timeout: 'oauth-lock.ts: a bounded wait for the OAuth row lock',
  enable_sort: "search hnsw.ts: the planner's sort off for one vector read, put back after",
  'hnsw.ef_search': "search hnsw.ts: the vector index's candidate list for one read",
  'hnsw.iterative_scan': "search hnsw.ts: the vector index's filtered scan for one read",
});

/**
 * The gateway's own settings: who acts (the actor, its write mode, the
 * check mode, the route) and in whose scope (workspaces, moderated
 * workspaces, the acting login). A narrow statement that set one could hide
 * a write from the narrow write count or pick the login a definer acts
 * for, so only the gateway's own SET names them (gatewaySettings), never a
 * statement of narrow work.
 */
const GATEWAY_SETTING =
  /^mantle\.(?:actor|actor_check|write_mode|route|login_id|ws|mod_ws|scope_[a-z0-9_]+)$/;

/** The gateway's own SET is being sent (gatewaySettings). */
const gatewaySetting = new AsyncLocalStorage<true>();

/**
 * Send the gateway's own scope SET (system-tx.ts writeScopeSettings, the
 * one text that sets a login's scope on the system pool, pinned by
 * eslint-rules/scope-settings.mjs): on the narrow route it may name the
 * gateway's settings (GATEWAY_SETTING), which no other narrow statement may.
 */
export function gatewaySettings<T>(send: () => Promise<T>): Promise<T> {
  return gatewaySetting.run(true, send);
}

/** Whether a narrow statement may set this setting (its name lower case,
 *  unquoted): a mantle.* one but the gateway's own (those only inside
 *  gatewaySettings), or one of NARROW_LOCAL_SETTINGS. */
function narrowSettingAllowed(name: string): boolean {
  if (GATEWAY_SETTING.test(name)) return gatewaySetting.getStore() === true;
  if (/^mantle\.[a-z0-9_]+(?:\.[a-z0-9_]+)*$/.test(name)) return true;
  return Object.hasOwn(NARROW_LOCAL_SETTINGS, name);
}

/**
 * The top-level arguments of the set_config call whose `(` is at `open` in
 * `code` (the text with strings and comments blanked, same length as
 * `text`), cut from `text` (comments blanked, strings kept). Null when the
 * call does not close.
 */
function callArguments(code: string, text: string, open: number): string[] | null {
  const args: string[] = [];
  let depth = 0;
  let from = open + 1;
  for (let i = open + 1; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[') depth++;
    else if ((c === ')' || c === ']') && depth > 0) depth--;
    else if (c === ')') {
      args.push(text.slice(from, i).trim());
      return args;
    } else if (c === ',' && depth === 0) {
      args.push(text.slice(from, i).trim());
      from = i + 1;
    }
  }
  return null;
}

/**
 * Whether every set_config call of the text is one a narrow statement may
 * send: three arguments, the first a plain literal naming a setting
 * narrowSettingAllowed allows, the third the literal true. A
 * role name built by concatenation ('ro' || 'le'), a bound parameter or any
 * other expression as the name, and a session setting (false, or a
 * parameter) are not.
 */
function setConfigCallsSendable(query: string): boolean {
  const text = sqlCode(query, false);
  const code = sqlCode(query, true, false);
  for (const m of code.matchAll(SET_CONFIG_CALL)) {
    const args = callArguments(code, text, m.index + m[0].length - 1);
    if (!args || args.length !== 3) return false;
    const name = args[0]!;
    if (!SETTING_LITERAL.test(name)) return false;
    if (!narrowSettingAllowed(name.slice(1, -1).toLowerCase())) return false;
    if (args[2]!.toLowerCase() !== 'true') return false;
  }
  return true;
}

/**
 * The text with its comments blanked (`--`, `/* *\/`) and, with
 * `literals`, its string literals and dollar-quoted bodies blanked too (and
 * its quoted identifiers, unless `identifiers` is false), so a verb inside
 * a value is never read as one. The same length as the text: an offset in
 * one is the same place in the other.
 */
/** A character an identifier may go on with (Postgres: letters, digits,
 *  `_`, `$`). */
const IDENT_CHAR = /[\w$]/;

/** Whether the quote at `at` opens an E'' string (backslash escapes): the
 *  letter E right before it is a token of its own (date'...' and
 *  name'...' are a type's literal, no escapes). */
function escapeString(query: string, at: number): boolean {
  return (
    query[at] === "'" && /[eE]/.test(query[at - 1] ?? '') && !IDENT_CHAR.test(query[at - 2] ?? '')
  );
}

export function sqlCode(query: string, literals = true, identifiers = literals): string {
  let out = '';
  let i = 0;
  const n = query.length;
  const blank = (from: number, to: number, keep: string) =>
    to - from >= 2 ? keep + ' '.repeat(to - from - 2) + keep : ' '.repeat(to - from);
  while (i < n) {
    const c = query[i]!;
    const next = query[i + 1];
    if (c === '-' && next === '-') {
      // Postgres ends a line comment at a newline or a carriage return.
      const nl = query.indexOf('\n', i);
      const cr = query.indexOf('\r', i);
      const end = nl < 0 ? cr : cr < 0 ? nl : Math.min(nl, cr);
      const to = end < 0 ? n : end;
      out += ' '.repeat(to - i);
      i = to;
    } else if (c === '/' && next === '*') {
      const end = query.indexOf('*/', i + 2);
      const to = end < 0 ? n : end + 2;
      out += ' '.repeat(to - i);
      i = to;
    } else if ((literals && c === "'") || (identifiers && c === '"')) {
      const eString = escapeString(query, i);
      let j = i + 1;
      for (; j < n; j++) {
        if (query[j] === c) {
          if (query[j + 1] === c) j++;
          else break;
        }
        // An E'' string: a backslash escapes the next character.
        else if (c === "'" && query[j] === '\\' && eString) j++;
      }
      const to = Math.min(j + 1, n);
      out += blank(i, to, c);
      i = to;
    } else if (literals && c === '$' && !IDENT_CHAR.test(query[i - 1] ?? '')) {
      // A dollar quote never follows an identifier's character: in x$a$
      // the dollars are the identifier's own (Postgres reads one name).
      const tag = /^\$([A-Za-z_][\w]*)?\$/.exec(query.slice(i));
      if (tag) {
        const end = query.indexOf(tag[0], i + tag[0].length);
        const to = end < 0 ? n : end + tag[0].length;
        out += blank(i, to, "'");
        i = to;
      } else {
        out += c;
        i++;
      }
    } else if (c === "'" || c === '"') {
      // Kept: copied whole, so a quote inside never opens a comment.
      const eString = escapeString(query, i);
      let j = i + 1;
      for (; j < n; j++) {
        if (query[j] === c) {
          if (query[j + 1] === c) j++;
          else break;
        } else if (c === "'" && query[j] === '\\' && eString) j++;
      }
      const to = Math.min(j + 1, n);
      out += query.slice(i, to);
      i = to;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The first words a narrow statement may start with (any `(` before it
 *  read through): reads and row writes. SET only as SET LOCAL of a setting
 *  narrowSettingAllowed allows, or SET TRANSACTION (setStatementSendable). */
const NARROW_FIRST_WORDS: ReadonlySet<string> = new Set([
  'select',
  'insert',
  'update',
  'delete',
  'merge',
  'with',
  'values',
  'table',
  'show',
]);

/** Every word a Postgres statement starts with (18, and two named for the
 *  next releases): a tagged template's text that starts with none of them
 *  is a fragment of another statement, checked where it is used. */
const STATEMENT_WORDS: ReadonlySet<string> = new Set(
  (
    'abort alter analyse analyze begin call checkpoint close cluster comment commit copy ' +
    'create deallocate declare delete discard do drop end execute explain fetch grant ' +
    'import insert listen load lock merge move notify prepare reassign refresh reindex ' +
    'release repack reset revoke rollback savepoint security select set show start table ' +
    'truncate unlisten update vacuum values wait with'
  ).split(' '),
);

/** SET LOCAL of one setting, its name bare, dotted or quoted (a space
 *  before a quote or none), then `=` or TO. */
const SET_LOCAL =
  /^set\s+local(?:\s+|(?="))((?:"(?:[^"]|"")+"|[a-z_][\w$]*)(?:\s*\.\s*(?:"(?:[^"]|"")+"|[a-z_][\w$]*))*)\s*(?:=|to(?![\w$]))/i;

/** A setting's name as Postgres looks it up: each part unquoted, lower
 *  case (setting names are matched without regard to case). */
function settingName(written: string): string {
  return written
    .split(/\s*\.\s*/)
    .map((part) => (part.startsWith('"') ? part.slice(1, -1).replace(/""/g, '"') : part))
    .join('.')
    .toLowerCase();
}

/** Whether a statement starting with SET may be sent (`stmt` with its
 *  strings blanked and its quoted identifiers kept): SET TRANSACTION, or
 *  SET LOCAL of a setting narrowSettingAllowed allows. */
function setStatementSendable(stmt: string): boolean {
  if (/^set\s+transaction(?![\w$])/i.test(stmt)) return true;
  const m = SET_LOCAL.exec(stmt);
  return m !== null && narrowSettingAllowed(settingName(m[1]!));
}

/** The statements of `code` (the text with strings and identifiers
 *  blanked, sqlCode), each with its offset, empty ones left out. */
function statementsOf(code: string): { at: number; text: string }[] {
  const out: { at: number; text: string }[] = [];
  let from = 0;
  for (let i = 0; i <= code.length; i++) {
    if (i < code.length && code[i] !== ';') continue;
    const raw = code.slice(from, i);
    const text = raw.trim();
    if (text) out.push({ at: from + raw.length - raw.trimStart().length, text });
    from = i + 1;
  }
  return out;
}

/** A U& string or identifier (its escapes spell any name). */
const UNICODE_ESCAPE = /(?<![\w$])u&/i;

/** A tagged template's placeholder where a name is read: a called
 *  function (`$1(`, `x.$1(`) or a SET LOCAL's setting. An identifier
 *  helper or a fragment there is text the check never sees. A table named
 *  by a placeholder before its column list (`insert into $1 (`) is no
 *  call. */
const PLACEHOLDER_NAME = /(?<!\binto\s+)\$\d+\s*\(|^set\s+local\s+\$\d+/i;

/**
 * Refuse what the narrow route never sends (NarrowRouteRefusedError), on a
 * single statement and on every statement of a narrow transaction: one
 * Postgres runs only outside a transaction block; a transaction-control
 * statement (it would end the transaction its role is local to, and later
 * statements would run as the pool's own login); a role change, by SET,
 * RESET, set_config or pg_settings, whatever builds the name; a DO block
 * (code the text cannot read); a session-level SET, RESET or set_config (it
 * outlives the transaction); any set_config but a transaction-local one of
 * a literal name narrowSettingAllowed allows; a U& string or identifier;
 * and any statement whose first word is not a read or a row write
 * (NARROW_FIRST_WORDS) or an allowed SET LOCAL or SET TRANSACTION.
 *
 * `tagged`: the text of a tagged template, its values joined as `$1`. It
 * may be a fragment of another statement: its first statement may start
 * with a word that starts no statement (a fragment, checked where it is
 * used), never with a placeholder; and a placeholder may not stand where a
 * function or a setting is named (PLACEHOLDER_NAME).
 *
 * A guard against mistakes, not against deliberate code: a statement that
 * means to leave the role can be written past any text check. The design
 * that closes the class is a narrow pool that logs in as the narrow role
 * itself (plan v3.2 S7b): no other role in the session to go back to.
 */
export function narrowSendable(query: string, tagged = false): void {
  if (runsOutsideTransaction(query)) {
    throw new NarrowRouteRefusedError('a statement outside a transaction');
  }
  const body = statementBody(query, false);
  const code = sqlCode(body);
  const named = sqlCode(body, true, false);
  if (TX_CONTROL.test(code)) {
    throw new NarrowRouteRefusedError('a transaction-control statement');
  }
  if (ROLE_CHANGE.test(named) || PG_SETTINGS.test(named)) {
    throw new NarrowRouteRefusedError('a role change');
  }
  if (DO_BLOCK.test(code)) {
    throw new NarrowRouteRefusedError('a DO block');
  }
  if (SESSION_SET.test(code)) {
    throw new NarrowRouteRefusedError('a session-level setting');
  }
  if (UNICODE_ESCAPE.test(code)) {
    throw new NarrowRouteRefusedError('a U& string or identifier');
  }
  for (const [k, st] of statementsOf(code).entries()) {
    const first = /^[(\s]*([a-z_][\w$]*|\$\d+)?/i.exec(st.text)?.[1]?.toLowerCase() ?? '';
    const stmt = named.slice(st.at, st.at + st.text.length);
    if (tagged && PLACEHOLDER_NAME.test(stmt)) {
      throw new NarrowRouteRefusedError('a placeholder where a function or a setting is named');
    }
    if (NARROW_FIRST_WORDS.has(first)) continue;
    if (first === 'set' && setStatementSendable(stmt)) continue;
    if (tagged && k === 0 && !first.startsWith('$') && !STATEMENT_WORDS.has(first)) continue;
    throw new NarrowRouteRefusedError(
      first === 'set'
        ? 'a SET other than SET LOCAL of an allowed setting'
        : `a statement starting with ${first ? `"${first}"` : 'no word'}`,
    );
  }
  if (!setConfigCallsSendable(query)) {
    throw new NarrowRouteRefusedError('a set_config other than a local setting it may set');
  }
}
