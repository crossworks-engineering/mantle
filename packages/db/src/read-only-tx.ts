/**
 * The database's own bound under readSql (./read-sql.ts). readSql reads the
 * shape of text and refuses the built-in functions on its list; a deny list
 * stays open-ended (a function the list misses, or one the database defines,
 * may write), and readSql text may run on the system pool. So text that
 * readSql let through runs inside a READ ONLY transaction too: the first
 * statement is SET TRANSACTION READ ONLY, and Postgres then refuses a write
 * to a table or a sequence (25006), whatever function makes it.
 *
 * What READ ONLY stops: INSERT, UPDATE, DELETE, MERGE, TRUNCATE, COPY FROM,
 * DDL, nextval and setval, a row lock (FOR UPDATE and its kind), and the
 * same done inside any function the text calls (ts_rewrite's query text
 * among them). What it does not stop (each measured on pg18): advisory
 * locks (a session lock outlives the transaction), set_config (with
 * is_local false the setting outlives it), pg_notify, the stats writers
 * (pg_restore_relation_stats and pg_clear_relation_stats rewrite pg_class),
 * brin_summarize_new_values, and the server and file functions. Those stay
 * on readSql's list (WRITE_FUNCTIONS), the only bound there.
 */
import { sql } from 'drizzle-orm';
import { readTransaction } from './gateway/scope';

/** The transaction handle readTransaction gives its callback. */
type ReadTx = Parameters<Parameters<typeof readTransaction>[0]>[0];

/**
 * Run `fn` in a READ ONLY transaction on the reads' handle (readTransaction:
 * a turn or request scope's own pool and settings, else the system pool;
 * the same pool a `db.execute` read takes there). Inside a scope's own
 * transaction (withScope) it is a savepoint, and the rest of that
 * transaction stays read only after it: refused, not let through.
 */
export function readOnlyTransaction<T>(fn: (tx: ReadTx) => Promise<T>): Promise<T> {
  return readTransaction(async (tx) => {
    await tx.execute(sql`set transaction read only`);
    return fn(tx);
  });
}
