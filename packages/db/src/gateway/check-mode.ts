/**
 * The box's actor check mode on the system pool: the reads that keep it
 * current, the drift between a check's triggers and its box mode, and the
 * checks' floor note. One owner for the mode read's state (the pool it reads
 * and its first read).
 */
import type postgres from 'postgres';
import { noteBoxActorCheckMode } from '../actor';
import { noteCheckFloor } from '../check-floor';

type PgSql = ReturnType<typeof postgres>;

/** The tag on the actor's own statements (the mode read, a login read now,
 *  the write wrapper's RESET): the round-trip test
 *  (a2a-round-trips.db.test.ts) proves the check off sends none, and counts
 *  their round trips as the actor's cost in warn. */
export const ACTOR_SQL_TAG = '/* mantle:actor */';

/** The tag on the narrow system route's own statements (its BEGIN, its one
 *  SET, the hold check, its COMMIT: gateway/narrow-route.ts), sent the same
 *  in every check mode: the round-trip test counts them as the route's,
 *  never as the actor's cost (plan v3.2 S7a). */
export const NARROW_SQL_TAG = '/* mantle:narrow */';

/** The pool whose box mode a timer reads (refreshActorCheckMode). */
let actorModePool: PgSql | null = null;

/**
 * The pool's first mode read while it is out, else null (the startup
 * race). Until it answers, a write or a transaction that has an actor waits
 * for it, so a process's first writes never go out as off on a box that is
 * warn or on. Reads never wait. A failed read is tried again after 1 s,
 * then 2 s, 4 s ..., but nothing waits longer than
 * FIRST_MODE_WAIT_MS: then the process goes on with MANTLE_ACTOR_CHECK as
 * the floor. A one-time cost at a process's start, no statement of its own.
 */
let firstModeRead: Promise<void> | null = null;

/** The longest a write waits for the pool's first mode read. */
const FIRST_MODE_WAIT_MS = 3_000;

/** An unref'd sleep: it never keeps a process alive. */
const quietSleep = (ms: number) =>
  new Promise<void>((r) => {
    setTimeout(r, ms).unref();
  });

/**
 * Read the box's actor check mode when the pool opens, then each minute on
 * an unref'd timer: never inside a statement's path, so a request runs no
 * new query for it (a statement's path gains no query). Until the
 * first read lands the process uses MANTLE_ACTOR_CHECK alone (off unless
 * set) as a floor: a read runs as before, and a write or a transaction
 * with an actor waits for that first read (firstModeRead). Exported for
 * actor-client.test.ts only (not in index.ts).
 */
export function refreshActorCheckMode(base: PgSql): void {
  if (actorModePool === base) return;
  actorModePool = base;
  /** One read; true when the mode is known after it. */
  const read = (): Promise<boolean> => {
    if (actorModePool !== base) return Promise.resolve(true);
    return base
      .unsafe(`${ACTOR_SQL_TAG} select "public"."mantle_actor_check_mode"() as m`)
      .then((rows) => {
        // A pool closed (closeDb) while the read was out: its answer is
        // not the next pool's.
        if (actorModePool !== base) return true;
        noteBoxActorCheckMode((rows[0] as { m?: string } | undefined)?.m ?? null);
        return true;
      })
      .catch((err: unknown) => {
        // A database without 0275 yet (the function is missing): off. Any
        // other failure (a dropped connection, a busy pool) keeps the last
        // mode read.
        if (actorModePool === base && (err as { code?: string } | null)?.code === '42883') {
          noteBoxActorCheckMode(null);
          return true;
        }
        return false;
      });
  };
  /** The first read, tried again with backoff until it lands (L5). Then,
   *  once per pool, the triggers against the box mode (warnActorCheckDrift). */
  const warm = async () => {
    for (let delay = 1_000; !(await read()) && actorModePool === base; delay *= 2) {
      await quietSleep(Math.min(delay, 30_000));
    }
    if (actorModePool === base) {
      warnActorCheckDrift(base);
      // Below on, loudly (0301, check-floor.ts).
      noteCheckFloor(base, ACTOR_SQL_TAG);
    }
  };
  const first: Promise<void> = Promise.race([warm(), quietSleep(FIRST_MODE_WAIT_MS)]).finally(
    () => {
      if (firstModeRead === first) firstModeRead = null;
    },
  );
  firstModeRead = first;
  const timer = setInterval(() => {
    if (actorModePool !== base) clearInterval(timer);
    else {
      void read();
      noteCheckFloor(base, ACTOR_SQL_TAG);
    }
  }, 60_000);
  timer.unref();
}

/**
 * The actor check's triggers against the box mode (0277): one row when they differ. Off wants every mantle_actor_check
 * trigger disabled, warn and on want all enabled. A bare ALTER DATABASE or
 * a restore (scripts/db-restore.sh) can leave them apart. Any role may run
 * it (mantle_actor_check_mode and pg_trigger are readable). The integrity
 * row actor_check_drift and the boot warning read it.
 */
export const ACTOR_CHECK_DRIFT_SQL = checkDriftSql(
  `"public"."mantle_actor_check_mode"()`,
  `g.tgname = 'mantle_actor_check'`,
);

/** The same for the edit check (0280): its box mode and every
 *  trigger named mantle_edit_check or mantle_edit_check_* (the matrix's
 *  and the read-only refusal). The integrity row edit_check_drift and the
 *  boot warning read it. */
export const EDIT_CHECK_DRIFT_SQL = checkDriftSql(
  `"public"."mantle_check_box_mode"('edit_check')`,
  `(g.tgname = 'mantle_edit_check' OR g.tgname LIKE 'mantle\\_edit\\_check\\_%')`,
);

/** One row when the triggers `triggers` picks do not follow the mode
 *  `mode` reads: off wants them all disabled, warn and on all enabled. */
function checkDriftSql(mode: string, triggers: string): string {
  return `
  SELECT m.mode, t.enabled::int AS enabled, t.total::int AS total
    FROM (SELECT ${mode} AS mode) m,
         (SELECT count(*) FILTER (WHERE g.tgenabled <> 'D') AS enabled, count(*) AS total
            FROM pg_catalog.pg_trigger g
           WHERE ${triggers} AND NOT g.tgisinternal) t
   WHERE NOT ((m.mode = 'off' AND t.enabled = 0) OR (m.mode <> 'off' AND t.enabled = t.total))`;
}

/** One warning at a pool's start when a check's triggers and its box mode
 *  differ (never each minute), for the actor check and the edit check. The
 *  app does not fix it: no DDL from the app. A database before a check's
 *  migration answers an error, ignored. */
function warnActorCheckDrift(base: PgSql): void {
  for (const [check, drift, setter] of [
    ['actor check', ACTOR_CHECK_DRIFT_SQL, 'mantle_set_actor_check'],
    ['edit check', EDIT_CHECK_DRIFT_SQL, 'mantle_set_edit_check'],
  ] as const) {
    base
      .unsafe(`${ACTOR_SQL_TAG} ${drift}`)
      .then((rows) => {
        const r = rows[0] as { mode?: string; enabled?: number; total?: number } | undefined;
        if (!r || typeof r.total !== 'number') return;
        console.warn(
          `[db] ${check}: the box mode is ${r.mode} but ${r.enabled} of ${r.total} ` +
            `triggers are enabled. As the superuser that runs migrations: ` +
            `select ${setter}('${r.mode}'); (docs/update-prod.md)`,
        );
      })
      .catch(() => {});
  }
}

/** The pool's first mode read while it is out, else null (firstModeRead). */
export function firstModeReadNow(): Promise<void> | null {
  return firstModeRead;
}

/** closeDb: the next pool reads its database's actor check mode afresh. */
export function forgetActorCheckModePool(): void {
  actorModePool = null;
  firstModeRead = null;
}
