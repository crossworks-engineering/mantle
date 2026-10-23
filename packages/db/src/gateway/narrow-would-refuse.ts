/**
 * The would-refuse count's reading of calls (no blind spot for a refused
 * EXECUTE): with the switch off, a statement the narrow route would take is
 * read for its mantle_* calls, and each function the narrow role may not
 * EXECUTE (the catalog's answer) is noted as narrow-would-refuse
 * `fn:<name> EXECUTE`, beside the database's own count of refused writes
 * (0319). narrowRouteClient (narrow-route.ts) calls it off the route.
 */
import type postgres from 'postgres';
import { TtlCache } from '@mantle/std';
import { actorSetting, currentActor, noteNarrowWouldRefuse } from '../actor';
import { NARROW_ROLE } from '../runtime-role';
import { sqlCode } from '../sql-text';
import { CALLED_FN } from './narrow-route';

type PgSql = ReturnType<typeof postgres>;

/** Which mantle_* functions the narrow role may EXECUTE, by name, read
 *  from the catalog (its grants and PUBLIC's), kept ten minutes (a migrate
 *  changes it). */
const narrowExec = new TtlCache<'can', ReadonlyMap<string, boolean>>({ ttlMs: 10 * 60_000 });
let narrowExecLoad: Promise<ReadonlyMap<string, boolean>> | null = null;

/** The catalog's answer, loaded on the system pool (no actor: a catalog
 *  read). Empty when the role is not there. */
function narrowExecutable(base: PgSql): Promise<ReadonlyMap<string, boolean>> {
  const kept = narrowExec.get('can');
  if (kept) return Promise.resolve(kept);
  narrowExecLoad ??= (async () => {
    try {
      const rows = (await base.unsafe(
        `select p.proname::text as name, bool_or(has_function_privilege($1, p.oid, $2)) as ok
           from pg_catalog.pg_proc p
           join pg_catalog.pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname like 'mantle\\_%'
          group by 1`,
        [NARROW_ROLE, 'EXECUTE'],
      )) as unknown as { name: string; ok: boolean }[];
      const can = new Map(rows.map((r) => [r.name, r.ok] as const));
      narrowExec.set('can', can);
      return can;
    } catch {
      return new Map<string, boolean>();
    } finally {
      narrowExecLoad = null;
    }
  })();
  return narrowExecLoad;
}

/**
 * A statement the narrow route would take, sent off it (the switch off):
 * each mantle_* function it calls by name that the narrow role may not
 * EXECUTE is noted as narrow-would-refuse `fn:<name> EXECUTE`, beside the
 * database's own count of refused writes (0319). Read on the code (the
 * literals blanked), as the switch-on measurement reads it. Never holds
 * the statement back.
 */
export function noteWouldRefuseCalls(base: PgSql, query: string): void {
  if (!/mantle_/i.test(query)) return;
  const names = new Set<string>();
  for (const m of sqlCode(query).code.matchAll(CALLED_FN)) names.add(m[1]!.toLowerCase());
  if (names.size === 0) return;
  const actor = currentActor();
  const who = actor ? actorSetting(actor) : 'none';
  void narrowExecutable(base).then((can) => {
    for (const name of names) {
      if (can.get(name) === false) noteNarrowWouldRefuse(who, `fn:${name} EXECUTE`);
    }
  });
}

/** A transaction's client whose statements are read by noteWouldRefuseCalls
 *  (the switch off, on a route that would be narrow), savepoints included. */
export function wouldRefuseTx(tx: PgSql, base: PgSql): PgSql {
  return new Proxy(tx, {
    get(target, prop, receiver) {
      if (prop === 'unsafe') {
        return (query: string, args?: unknown[], opts?: unknown) => {
          noteWouldRefuseCalls(base, query);
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
