/**
 * The narrow system route's text check (plan v3.2 S7a): what a statement
 * sent on the narrow role may be (narrowSendable), read on the text's code
 * (sql-text.ts sqlCode, the repo's one SQL text reader: comments, strings
 * and dollar quotes blanked as Postgres's lexer reads them, quoted names
 * kept as their name characters). A guard against mistakes, not against
 * deliberate code; narrow-route.ts sends what passes.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { RuntimeFaultError } from '@mantle/std';
import { SQL_TEXT_RUNNERS } from '../read-sql';
import { sqlCode } from '../sql-text';
import { runsOutsideTransaction } from './actor-sql';

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
 *  (read on its code). */
const TX_CONTROL =
  /(?:^|;)\s*(?:begin|commit|rollback|abort|end|start\s+transaction|prepare\s+transaction|savepoint|release)\b/i;

/** A role change in any form, at the start of any statement (SET and RESET
 *  are statements of their own; the same words inside an UPDATE are a
 *  column): SET [SESSION | LOCAL] ROLE or SESSION AUTHORIZATION (the name
 *  bare or quoted, with or without a space before the quote), RESET ROLE,
 *  RESET SESSION AUTHORIZATION, RESET ALL.
 *  Read on the text's code, where a quoted name keeps its name characters
 *  (a quoted "role" reads as itself). */
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

/**
 * A call of a function that runs its text argument as SQL (shared with
 * readSql: read-sql.ts SQL_TEXT_RUNNERS): the text is a string the check
 * blanks, so a role change inside it is never read. query_to_xml and its
 * kin, ts_stat and ts_rewrite run a query, pg-boss's job_table_run its
 * command, dblink a remote one. The name bare, quoted or schema-qualified.
 */
const SQL_TEXT_RUNNER_CALL = new RegExp(
  String.raw`(?<![\w$])"?(?:${SQL_TEXT_RUNNERS.join('|')})"?\s*\(`,
  'i',
);

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
  /^mantle\.(?:actor|actor_check|write_mode|route|login_id|ws|mod_ws|scope_[a-z0-9_]+|create_ws|private_ws|create_stamp)$/;

/** The gateway's own SET is being sent (gatewaySettings). */
const gatewaySetting = new AsyncLocalStorage<true>();

/**
 * Send the gateway's own SET: a login's scope on the system pool
 * (system-tx.ts writeScopeSettings, pinned by
 * eslint-rules/scope-settings.mjs) or where a create lands (system-tx.ts
 * systemPoolTx's home settings). On the narrow route it may name the
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
 * `code` (the text's code, sqlCode), each cut from `text` (the same text
 * with only its comments blanked: a literal as written). Null when the call
 * does not close.
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
function setConfigCallsSendable(code: string, text: string): boolean {
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
 *  before a quote or none), then `=` or TO. Read on the statement's code
 *  (a quoted name's other characters read as `_` there; the name itself is
 *  read from the text at the same place). */
const SET_LOCAL =
  /^set\s+local(?:\s+|(?="))((?:"[^"]+"|[a-z_\u0080-\uffff][\w$\u0080-\uffff]*)(?:\s*\.\s*(?:"[^"]+"|[a-z_\u0080-\uffff][\w$\u0080-\uffff]*))*)\s*(?:=|to(?![\w$\u0080-\uffff]))/di;

/** A setting's name as Postgres looks it up: each part unquoted, lower
 *  case (setting names are matched without regard to case). */
function settingName(written: string): string {
  const parts: string[] = [];
  for (const m of written.matchAll(/"((?:[^"]|"")*)"|([^\s."]+)/g)) {
    parts.push(m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2]!);
  }
  return parts.join('.').toLowerCase();
}

/** Whether a statement starting with SET may be sent (`stmt` its code,
 *  `text` the same statement with only its comments blanked): SET
 *  TRANSACTION, or SET LOCAL of a setting narrowSettingAllowed allows. */
function setStatementSendable(stmt: string, text: string): boolean {
  if (/^set\s+transaction(?![\w$\u0080-\uffff])/i.test(stmt)) return true;
  const m = SET_LOCAL.exec(stmt);
  if (m === null) return false;
  const [from, to] = m.indices![1]!;
  return narrowSettingAllowed(settingName(text.slice(from, to)));
}

/** The statements of `code` (the text's code, sqlCode), each with its
 *  offset, empty ones left out. */
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
 * a call of a function that runs its text argument as SQL
 * (SQL_TEXT_RUNNER_CALL); text that never closes or that Postgres may read
 * otherwise (sqlCode's `unterminated` and `ambiguous`); and any statement
 * whose first word is not a read or a row write (NARROW_FIRST_WORDS) or an
 * allowed SET LOCAL or SET TRANSACTION.
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
 * itself (plan v3.2 S7b): no other role in the session to go back to. Not
 * read at all: a fragment a tagged template takes from another postgres.js
 * client (another pool's `sql`), whose text this client never sees.
 */
export function narrowSendable(query: string, tagged = false): void {
  if (runsOutsideTransaction(query)) {
    throw new NarrowRouteRefusedError('a statement outside a transaction');
  }
  const { code, uncommented: text, unterminated, ambiguous } = sqlCode(query);
  if (unterminated) {
    throw new NarrowRouteRefusedError('a comment, string or quoted name that never closes');
  }
  if (ambiguous) {
    throw new NarrowRouteRefusedError(
      'text Postgres may read otherwise (a backslash before a quote in a plain string, a U& name)',
    );
  }
  if (TX_CONTROL.test(code)) {
    throw new NarrowRouteRefusedError('a transaction-control statement');
  }
  if (ROLE_CHANGE.test(code) || PG_SETTINGS.test(code)) {
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
  if (SQL_TEXT_RUNNER_CALL.test(code)) {
    throw new NarrowRouteRefusedError('a function that runs its text as SQL');
  }
  for (const [k, st] of statementsOf(code).entries()) {
    const first =
      /^[(\s]*([a-z_\u0080-\uffff][\w$\u0080-\uffff]*|\$\d+)?/i.exec(st.text)?.[1]?.toLowerCase() ??
      '';
    const stmt = st.text;
    if (tagged && PLACEHOLDER_NAME.test(stmt)) {
      throw new NarrowRouteRefusedError('a placeholder where a function or a setting is named');
    }
    if (NARROW_FIRST_WORDS.has(first)) continue;
    if (first === 'set' && setStatementSendable(stmt, text.slice(st.at, st.at + stmt.length)))
      continue;
    if (tagged && k === 0 && !first.startsWith('$') && !STATEMENT_WORDS.has(first)) continue;
    throw new NarrowRouteRefusedError(
      first === 'set'
        ? 'a SET other than SET LOCAL of an allowed setting'
        : `a statement starting with ${first ? `"${first}"` : 'no word'}`,
    );
  }
  if (!setConfigCallsSendable(code, text)) {
    throw new NarrowRouteRefusedError('a set_config other than a local setting it may set');
  }
}
