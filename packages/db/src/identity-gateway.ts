/**
 * The identity gateway's catalog check (migration 0321): a session sets the mantle.* identity settings itself (the
 * login, the scope, the workspaces, the acting login, the actor), so only
 * the gateway's SQL readers may read them, and on the narrow system role
 * they answer no identity. mantle_identity_leaks() lists every function
 * body, policy, trigger condition, column default, check constraint and
 * view of the app's schemas that reads one anywhere else; migrate fails on
 * any (afterMigrations), so a new function is covered with no list to keep.
 * Its list of non-identity keys, each with why, lives in the function.
 *
 * With it, mantle_acl_flag_leaks() (0326): the derivation's flag
 * (mantle.acl_internal) is signed by the functions that set it, so a body
 * that sets it or its mark itself, or decides from the bare flag, is a leak
 * too. A database before 0326 has no such check yet.
 */
import type { Sql } from 'postgres';

export type IdentityLeak = { kind: string; object: string; detail: string };

/** The leaks the catalog check finds now: none is the rule. */
export async function identityLeaks(sql: Sql): Promise<IdentityLeak[]> {
  const rows = await sql<IdentityLeak[]>`select kind, object, detail from mantle_identity_leaks()`;
  const [flag] = await sql<{ ok: boolean }[]>`
    select to_regprocedure('public.mantle_acl_flag_leaks()') is not null as ok`;
  const more = flag?.ok
    ? await sql<IdentityLeak[]>`select kind, object, detail from mantle_acl_flag_leaks()`
    : [];
  return [...rows, ...more].map((r) => ({ kind: r.kind, object: r.object, detail: r.detail }));
}

/** Whether the catalog check exists: a database migrated only part of the
 *  way (an old-migration cell's stop before 0321) has none yet. */
export async function identityGatewayPresent(sql: Sql): Promise<boolean> {
  const rows = await sql<{ ok: boolean }[]>`
    select to_regprocedure('public.mantle_identity_leaks()') is not null as ok`;
  return rows[0]?.ok === true;
}

/** Throw on any leak, naming each (migrate's after-step). On a database
 *  that has not reached 0321 there is no check to run: `log` says so and
 *  nothing is read (the migrate that reaches 0321 runs it). */
export async function assertNoIdentityLeaks(
  sql: Sql,
  log: (line: string) => void = () => {},
): Promise<void> {
  if (!(await identityGatewayPresent(sql))) {
    log('  identity gateway check skipped: mantle_identity_leaks() not made yet (before 0321)');
    return;
  }
  const leaks = await identityLeaks(sql);
  if (leaks.length === 0) return;
  throw new Error(
    `identity gateway (0321): ${leaks.length} read(s) of an identity setting outside the readers: ` +
      leaks.map((l) => `${l.kind} ${l.object}: ${l.detail}`).join('; ') +
      ' (packages/db src/identity-gateway.ts)',
  );
}
