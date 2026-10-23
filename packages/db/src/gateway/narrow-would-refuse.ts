/**
 * The would-refuse count's reading of calls (no blind spot for a refused
 * EXECUTE): with the switch off, a statement the narrow route would take is
 * read for its mantle_* calls, and each function the narrow role may not
 * EXECUTE (the catalog's answer) is noted as narrow-would-refuse
 * `fn:<name> EXECUTE`, beside the database's own count of refused writes
 * (0320). narrowRouteClient (narrow-route.ts) calls it off the route.
 */
import type postgres from 'postgres';
import { TtlCache } from '@mantle/std';
import { actorSetting, currentActor, noteNarrowWouldRefuse } from '../actor';
import { NARROW_ROLE } from '../runtime-role';
import { sqlCode } from '../sql-text';
import { sendOrNote } from './narrow-denial';

type PgSql = ReturnType<typeof postgres>;

/** A call of a `mantle_*` function by name in a statement's text (literals
 *  blanked), bare or as public.mantle_* (quoted or not): the one call
 *  pattern the would-refuse count, the switch-on measurement and the static
 *  scan (test-support/narrow-write-scan.ts) read. A name after any other
 *  schema's dot is not read. Global: take a copy (`new RegExp(CALLED_FN)`)
 *  where `exec` is looped. */
export const CALLED_FN = /(?<![\w.$"])(?:"?public"?\s*\.\s*)?"?(mantle_[a-z0-9_]+)"?\s*\(/gi;

/** Which mantle_* functions the narrow role may EXECUTE, by name, read
 *  from the catalog (its grants and PUBLIC's), kept ten minutes (a migrate
 *  changes it). */
const narrowExec = new TtlCache<'can', ReadonlyMap<string, boolean>>({ ttlMs: 10 * 60_000 });
let narrowExecLoad: Promise<ReadonlyMap<string, boolean> | null> | null = null;

/** The catalog's answer, loaded on the system pool (no actor: a catalog
 *  read). Empty when the role is not there; null when the catalog could
 *  not be read (not kept: the next statement tries again). */
function narrowExecutable(base: PgSql): Promise<ReadonlyMap<string, boolean> | null> {
  const kept = narrowExec.get('can');
  if (kept) return Promise.resolve(kept);
  narrowExecLoad ??= (async () => {
    try {
      const rows = (await base.unsafe(
        `select p.proname::text as name, bool_or(has_function_privilege($1, p.oid, $2)) as ok
           from pg_catalog.pg_proc p
           join pg_catalog.pg_namespace n on n.oid = p.pronamespace
           join pg_catalog.pg_roles r on r.rolname = $1
          where n.nspname = 'public' and p.proname like 'mantle\\_%'
          group by 1`,
        [NARROW_ROLE, 'EXECUTE'],
      )) as unknown as { name: string; ok: boolean }[];
      const can = new Map(rows.map((r) => [r.name, r.ok] as const));
      narrowExec.set('can', can);
      return can;
    } catch {
      // Not an empty answer: the caller counts every call it read as
      // unread, so a failed load never reads as nothing refused.
      return null;
    } finally {
      narrowExecLoad = null;
    }
  })();
  return narrowExecLoad;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * The mantle_* functions a statement calls by name, read on its code (the
 * literals blanked). A statement with no `mantle_` anywhere is not lexed
 * (most of a turn's statements: well under a microsecond each); one that
 * has it costs a few microseconds (measured per path in
 * a2a-round-trips.db.test.ts, the scan cost cell).
 */
export function calledMantleFunctions(query: string): ReadonlySet<string> {
  if (!/mantle_/i.test(query)) return NONE;
  const names = new Set<string>();
  for (const m of sqlCode(query).code.matchAll(CALLED_FN)) names.add(m[1]!.toLowerCase());
  return names;
}

/**
 * A statement the narrow route would take, sent off it (the switch off):
 * each mantle_* function it calls by name that the narrow role may not
 * EXECUTE is noted as narrow-would-refuse `fn:<name> EXECUTE`, beside the
 * database's own count of refused writes (0320). Read on the code (the
 * literals blanked), as the switch-on measurement reads it. Never holds
 * the statement back.
 */
export function noteWouldRefuseCalls(base: PgSql, query: string): void {
  const names = calledMantleFunctions(query);
  if (names.size === 0) return;
  const actor = currentActor();
  const who = actor ? actorSetting(actor) : 'none';
  void narrowExecutable(base).then((can) => {
    for (const name of names) {
      if (can === null) noteNarrowWouldRefuse(who, `fn:${name} UNREAD`);
      else if (can.get(name) === false) noteNarrowWouldRefuse(who, `fn:${name} EXECUTE`);
    }
  });
}

/**
 * A statement the narrow route would take, sent off it (the switch off):
 * the text check the route runs first is run here too and a refusal
 * counted as narrow-would-refuse `text:<what>` (sendOrNote, the one helper
 * for both switch states), then its calls (noteWouldRefuseCalls). Never
 * holds the statement back. `tagged`: a tagged template's text, its values
 * joined as `$1` (as narrowTxClient reads it).
 */
export function noteWouldRefuseStatement(base: PgSql, query: string, tagged = false): void {
  sendOrNote(query, tagged, false);
  noteWouldRefuseCalls(base, query);
}

/** A transaction's client whose statements are read by
 *  noteWouldRefuseStatement (the switch off, on a route that would be
 *  narrow), tagged templates and savepoints included. */
export function wouldRefuseTx(tx: PgSql, base: PgSql): PgSql {
  return new Proxy(tx, {
    apply(target, thisArg, args: unknown[]) {
      const first = args[0] as { raw?: unknown } | undefined;
      if (Array.isArray(first) && 'raw' in first) {
        noteWouldRefuseStatement(base, (first as string[]).join('$1'), true);
      }
      return Reflect.apply(target as unknown as (...a: unknown[]) => unknown, thisArg, args);
    },
    get(target, prop, receiver) {
      if (prop === 'unsafe') {
        return (query: string, args?: unknown[], opts?: unknown) => {
          noteWouldRefuseStatement(base, query);
          return target.unsafe(query, args as never[], opts as never);
        };
      }
      if (prop === 'savepoint') {
        const savepoint = (target as unknown as { savepoint: (...a: unknown[]) => unknown })
          .savepoint;
        return (...args: unknown[]) => {
          const last = args[args.length - 1];
          if (typeof last !== 'function') return savepoint.apply(target, args);
          const inner = last as (t: PgSql) => unknown;
          return savepoint.call(target, ...args.slice(0, -1), (t: PgSql) =>
            inner(wouldRefuseTx(t, base)),
          );
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
