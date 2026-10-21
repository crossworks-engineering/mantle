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
 *
 * patches/postgres@3.4.9.patch is REQUIRED; this lease is the second
 * layer. Only the patch rejects the statements queued on a reservation
 * when its connection closes (behind a statement with parameters, every
 * drizzle write: unpatched they never settle), refuses a statement on a
 * connection that died silently (no statement of the lease saw it, so the
 * lease cannot know: `end()` would write to the null socket), and keeps a
 * transaction (`begin`) from writing its ROLLBACK to a dead connection.
 * The lease adds what the driver cannot know: a connection the caller
 * ended on purpose is never handed back, and nothing more is sent on one a
 * statement saw die.
 *
 * The rule: a lease whose connection is gone is never handed back and
 * takes no more statements. It is gone once one of its own statements
 * (sent through `watch`) failed with a connection error (connectionGone),
 * or once the caller ended it on purpose (`end`). An error from anything
 * else (the caller's own code) says nothing about the connection. Not handing it back is safe: postgres.js has already
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
import { BusyError } from './pg-error';

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
  /** Await a statement on this lease; a connection error marks it gone.
   *  The only way the lease learns its connection died. */
  watch<T>(statement: PromiseLike<T>): Promise<T>;
  /**
   * End the session on purpose (it may hold settings that must not reach
   * the pool): never handed back. Sends nothing on a connection already
   * gone. Never throws.
   */
  end(): Promise<void>;
  /** Back to the pool, once, and only when not gone. */
  release(): void;
}

/** How long a reserve waits for a connection of its pool before it fails
 *  as busy (reserveLease): a pool held by stuck work, or a reserve the
 *  driver never answers, becomes an error, never a hang. */
export const RESERVE_WAIT_MS = 15_000;
let reserveWaitMs = RESERVE_WAIT_MS;

/** Tests only (not in index.ts): the default wait; null restores it. */
export function setReserveWaitForTests(ms: number | null): void {
  reserveWaitMs = ms ?? RESERVE_WAIT_MS;
}

/** No connection of the pool within the wait. Busy: the API answers it as
 *  one (isBusy, 409), and it is logged. */
export class PoolBusyError extends BusyError {
  constructor() {
    super('The server is busy; try again in a moment.');
    this.name = 'PoolBusyError';
  }
}

/** The one log line of a pool's bounded wait running out: `what` names
 *  the pool and the wait (the write pool's own, role-tx.ts). */
export function logPoolBusy(what: string): void {
  console.error(`[db] ${what}`);
}

function poolBusy(ms: number): PoolBusyError {
  logPoolBusy(`no reserved connection of the pool within ${ms} ms`);
  return new PoolBusyError();
}

/** The wait of one reserve: how long, and the error it fails with. */
export interface ReserveWait {
  ms?: number;
  busy?: () => Error;
}

/**
 * Reserve one connection of `pool` as a lease, waiting at most `wait.ms`
 * (RESERVE_WAIT_MS unless given): every reserve of this package, on every
 * pool, goes through here. A connection that comes after the wait is handed
 * back at once (nothing was sent on it). Two layers against a reserve that
 * never settles: patches/postgres@3.4.9.patch keeps a reserve queued when a
 * connection of a full pool closes (postgres.js 3.4.9 dropped it), and this
 * wait turns any other into a busy error, so the caller, and closeDb behind
 * it, never hangs on one.
 */
export async function reserveLease<S extends ReservedSql>(
  pool: { reserve(): Promise<S> },
  wait: ReserveWait = {},
): Promise<Lease<S>> {
  const ms = wait.ms ?? reserveWaitMs;
  let late = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reserved = pool.reserve();
  const waited = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      late = true;
      reject(wait.busy ? wait.busy() : poolBusy(ms));
    }, ms);
    timer.unref?.();
  });
  let sql: S;
  try {
    sql = await Promise.race([reserved, waited]);
  } finally {
    clearTimeout(timer);
    if (late)
      void reserved.then(
        (c) => c.release(),
        () => undefined,
      );
  }
  let gone = false;
  let released = false;
  return {
    sql,
    get gone() {
      return gone;
    },
    watch: <T>(statement: PromiseLike<T>) =>
      new Promise<T>((ok, bad) => {
        statement.then(ok, (err: unknown) => {
          if (connectionGone(err)) gone = true;
          bad(err);
        });
      }),
    async end() {
      if (gone) return;
      gone = true;
      // The result is not read: a session may always end itself (the same
      // role, its own pid), and a failure here means the connection is
      // already going (its close is what the pool sees). Either way it is
      // never handed back.
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

/** Run `fn` on a lease of `pool`; the lease goes back after, when usable.
 *  Only `fn`'s statements sent through `lease.watch` can mark it gone. */
export async function withLease<S extends ReservedSql, T>(
  pool: { reserve(): Promise<S> },
  fn: (lease: Lease<S>) => Promise<T>,
  wait: ReserveWait = {},
): Promise<T> {
  const lease = await reserveLease(pool, wait);
  try {
    return await fn(lease);
  } finally {
    lease.release();
  }
}
