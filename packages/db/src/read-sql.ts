/**
 * Read text that code composes (a catalog query a module shares as a
 * string, a query sent on the simple protocol with its values inlined).
 * The raw write ban (eslint-rules/no-raw-write-sql.mjs) cannot read such
 * text, so it counts every `.unsafe(x)`, `sql.raw(x)` and `.execute(x)` of
 * it unless `x` is `readSql(...)` imported from @mantle/db: the check
 * moves here, to the moment the text runs.
 *
 * What readSql guarantees: it answers the text unchanged only when the
 * text, read on its code (./sql-text.ts: comments, strings, dollar quotes
 * and quoted names blanked), is exactly one statement that starts with
 * SELECT, WITH, VALUES or TABLE; whose every CTE body starts with SELECT,
 * VALUES, WITH or TABLE (a nested WITH read the same way); that holds no
 * INSERT, UPDATE, DELETE or MERGE where a statement can start (the text's
 * start or after an opening parenthesis), no INTO (SELECT INTO makes a
 * table), no row lock (FOR UPDATE, FOR SHARE and their KEY forms) and no
 * call of a built-in function that writes or changes the session
 * (WRITE_FUNCTIONS: set_config, the advisory locks, sequences, pg_notify,
 * large objects, dblink and the rest). Anything else throws NotReadSqlError:
 * a second statement, COPY, GRANT, REVOKE, SET, EXPLAIN (ANALYZE runs its
 * statement), CALL, DO, DDL, a comment, string or quote that never closes,
 * and text PostgreSQL may read otherwise (sqlCode `ambiguous`).
 *
 * What it does not guarantee: what a function the text calls does. A
 * function the database defines (a definer among them) may write, and
 * readSql cannot see into it; the role the statement runs as is the bound
 * there. A read that needs a row lock or an advisory lock stays literal
 * text, where the lint reads it.
 */
import { firstWord, sqlCode, sqlStatements, withParts } from './sql-text';

export class NotReadSqlError extends Error {
  constructor(why: string) {
    super(`readSql: ${why}; read text only (a write is a typed write or a definer call).`);
    this.name = 'NotReadSqlError';
  }
}

/** Built-in functions a read never calls: each writes, takes a lock, or
 *  changes the session or the server. Matched as a call (`name(`, quoted
 *  or schema-qualified too) on the text's code, so a value never matches. */
export const WRITE_FUNCTIONS: readonly string[] = Object.freeze([
  'set_config',
  'setseed',
  'pg_advisory_\\w+',
  'pg_try_advisory_\\w+',
  'nextval',
  'setval',
  'pg_notify',
  'lo_\\w+',
  'lowrite',
  'dblink\\w*',
  'pg_terminate_backend',
  'pg_cancel_backend',
  'pg_reload_conf',
  'pg_rotate_logfile',
  'pg_switch_wal',
  'pg_promote',
  'pg_create_restore_point',
  'pg_stat_reset\\w*',
  'pg_\\w*replication_slot\\w*',
  'pg_replication_origin_\\w+',
  'pg_logical_\\w+',
  'pg_wal_replay_\\w+',
  'pg_file_\\w+',
  'pg_import_system_collations',
  'pg_log_backend_memory_contexts',
  'binary_upgrade_\\w+',
  'query_to_xml\\w*',
  'cursor_to_xml\\w*',
  'ts_stat',
]);

const WRITE_FUNCTION_CALL = new RegExp(
  `(?<![\\w$])"?(?:${WRITE_FUNCTIONS.join('|')})"?\\s*\\(`,
  'i',
);

/** A data-modifying statement where one may start: the text's start, or
 *  after an opening parenthesis (a CTE body, a subquery). */
const WRITE_AT_START = /(?:^|\()\s*(?:insert|update|delete|merge)\b/i;
const INTO = /\binto\b/i;
const ROW_LOCK = /\bfor\s+(?:no\s+key\s+update|update|key\s+share|share)\b/i;

const READ_STARTS = new Set(['select', 'with', 'values', 'table']);
const BODY_STARTS = new Set(['select', 'values', 'table']);

/** Why the statement `code` (blanked) is not a read, or null. */
function notARead(code: string): string | null {
  const word = firstWord(code);
  if (!READ_STARTS.has(word)) return `a statement that starts with ${word || 'no word'}`;
  if (word !== 'with') return null;
  const parts = withParts(code.replace(/^[\s(]*/, ''));
  if (!parts.walked) return 'a WITH this reader cannot walk';
  for (const body of parts.ctes) {
    const inner = firstWord(body);
    if (!READ_STARTS.has(inner)) return `a CTE that starts with ${inner || 'no word'}`;
    if (inner === 'with') {
      const why = notARead(body);
      if (why) return why;
    }
  }
  const rest = firstWord(parts.rest);
  return BODY_STARTS.has(rest) ? null : `a WITH whose statement starts with ${rest || 'no word'}`;
}

/** Why `text` is not one statement that reads (see the top), or null. */
export function notReadSqlReason(text: string): string | null {
  const { code, unterminated, ambiguous } = sqlCode(text);
  if (unterminated) return 'a comment, string or quote that never closes';
  if (ambiguous) return 'text PostgreSQL may read otherwise';
  const statements = sqlStatements(code).filter((s) => s.trim() !== '');
  if (statements.length === 0) return 'no statement';
  if (statements.length > 1) return 'more than one statement';
  const statement = statements[0]!;
  const why = notARead(statement);
  if (why) return why;
  if (WRITE_AT_START.test(statement)) return 'a data-modifying statement';
  if (INTO.test(statement)) return 'an INTO';
  if (ROW_LOCK.test(statement)) return 'a row lock';
  if (WRITE_FUNCTION_CALL.test(statement)) return 'a call of a function that writes';
  return null;
}

export function readSql(text: string): string {
  const why = notReadSqlReason(text);
  if (why) throw new NotReadSqlError(why);
  return text;
}
