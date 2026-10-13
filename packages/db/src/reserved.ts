/**
 * A reserved postgres.js connection that goes back to the pool only while
 * it is usable: the one way this package holds a connection of its own
 * (`sql.reserve()`). Every reserve in packages/db goes through here.
 *
 * Why (hotfix after v0.300.13): in postgres.js 3.4.9 a connection the
 * server closes (pg_terminate_backend, a restart, a dropped network) gets
 * `socket = null` and moves to the pool's closed queue, but a reservation
 * of it still works on it. Its `release()` puts the dead connection back in
 * the open queue, and the next statement on it (the pool's next query, or
 * one more on the reservation) is written to the null socket from a
 * setImmediate, outside every promise: "Cannot read properties of null
 * (reading 'write')", an uncaught exception, in a server a crash.
 * patches/postgres@3.4.9.patch fixes that at the source; this module does
 * not rely on it.
 *
 * The rule: a lease whose connection is gone is never handed back and
 * takes no more statements. It is gone once a statement on it failed with
 * a connection error (connectionGone), or once the caller ended it on
 * purpose (`end`). Not handing it back is safe: postgres.js has already
 * moved a closed connection to its closed queue (and cleared its
 * reservation), and the pool opens a closed connection again when it next
 * needs one.
 *
 * The reverse risk is a live connection judged gone: it would stay
 * reserved for good, one pool slot fewer, and the pool's `end()` (closeDb)
 * would never finish. So the test is strict: only the driver's own
 * connection errors, socket errors, and a FATAL or PANIC from the server
 * (the server ends the session after one). A leak would show as a backend
 * idle in pg_stat_activity that no query reaches, and as closeDb hanging.
 */
import type { ReservedSql } from 'postgres';

/** postgres.js's own connection errors (src/errors.js, Errors.connection):
 *  the socket closed (CONNECTION_CLOSED), the connection was destroyed
 *  (CONNECTION_DESTROYED), the pool is ending (CONNECTION_ENDED), or the
 *  connect timed out (CONNECT_TIMEOUT). */
const DRIVER_GONE = new Set([
  'CONNECTION_CLOSED',
  'CONNECTION_DESTROYED',
  'CONNECTION_ENDED',
  'CONNECT_TIMEOUT',
]);

/** Socket errors postgres.js passes on as they are (the socket's 'error'
 *  event): Node destroys a socket after each, so its close follows. */
const SOCKET_GONE = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ECONNABORTED',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'ENETUNREACH',
  'ENETDOWN',
  'ENOTCONN',
  'ERR_SOCKET_CLOSED',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
]);

/**
 * Whether `err`, from a statement on a connection, means that connection is
 * gone. Only the error itself is read (never a wrapped cause): the lease
 * sees the driver's errors, not drizzle's.
 */
export function connectionGone(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const { code, severity } = err as { code?: unknown; severity?: unknown };
  if (typeof code === 'string' && (DRIVER_GONE.has(code) || SOCKET_GONE.has(code))) return true;
  return severity === 'FATAL' || severity === 'PANIC';
}

/** Ends the session with the server: a ROLLBACK first, so a connection
 *  left in an aborted transaction block (where every other statement
 *  fails) still runs it. Simple protocol, one send. */
export const END_SESSION_SQL = 'rollback; select pg_terminate_backend(pg_backend_pid())';

export interface Lease<S extends ReservedSql = ReservedSql> {
  /** The reserved connection. Send through `watch` what may fail. */
  readonly sql: S;
  /** True once the connection is gone, or ended on purpose. */
  readonly gone: boolean;
  /** Await a statement on this lease; a connection error marks it gone. */
  watch<T>(statement: PromiseLike<T>): Promise<T>;
  /** A failure seen on this lease: a connection error marks it gone. */
  note(err: unknown): void;
  /**
   * End the session on purpose (it may hold settings that must not reach
   * the pool): never handed back. Sends nothing on a connection already
   * gone. Never throws.
   */
  end(): Promise<void>;
  /** Back to the pool, once, and only when not gone. */
  release(): void;
}

/** Reserve one connection of `pool` as a lease. */
export async function reserveLease<S extends ReservedSql>(pool: {
  reserve(): Promise<S>;
}): Promise<Lease<S>> {
  const sql = await pool.reserve();
  let gone = false;
  let released = false;
  const note = (err: unknown) => {
    if (connectionGone(err)) gone = true;
  };
  return {
    sql,
    get gone() {
      return gone;
    },
    note,
    watch: <T>(statement: PromiseLike<T>) =>
      new Promise<T>((ok, bad) => {
        statement.then(ok, (err: unknown) => {
          note(err);
          bad(err);
        });
      }),
    async end() {
      if (gone) return;
      gone = true;
      await Promise.resolve()
        // END_SESSION_SQL, as a literal (the heads lint reads it).
        .then(() => sql.unsafe('rollback; select pg_terminate_backend(pg_backend_pid())').simple())
        .catch(() => {});
    },
    release() {
      if (released) return;
      released = true;
      if (!gone) sql.release();
    },
  };
}

/** Run `fn` on a lease of `pool`; the lease goes back after (when usable). */
export async function withLease<S extends ReservedSql, T>(
  pool: { reserve(): Promise<S> },
  fn: (lease: Lease<S>) => Promise<T>,
): Promise<T> {
  const lease = await reserveLease(pool);
  try {
    return await fn(lease);
  } catch (err) {
    lease.note(err);
    throw err;
  } finally {
    lease.release();
  }
}
