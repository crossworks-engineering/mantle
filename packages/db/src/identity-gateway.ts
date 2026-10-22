/**
 * The identity gateway's catalog check (migration 0321, plan v3.2 S7b part
 * b2 round 13): a session sets the mantle.* identity settings itself (the
 * login, the scope, the workspaces, the acting login, the actor), so only
 * the gateway's SQL readers may read them, and on the narrow system role
 * they answer no identity. mantle_identity_leaks() lists every function
 * body, policy, trigger condition, column default, check constraint and
 * view of the app's schemas that reads one anywhere else; migrate fails on
 * any (afterMigrations), so a new function is covered with no list to keep.
 * Its list of non-identity keys, each with why, lives in the function.
 */
import type { Sql } from 'postgres';

export type IdentityLeak = { kind: string; object: string; detail: string };

/** The leaks the catalog check finds now: none is the rule. */
export async function identityLeaks(sql: Sql): Promise<IdentityLeak[]> {
  const rows = await sql<IdentityLeak[]>`select kind, object, detail from mantle_identity_leaks()`;
  return rows.map((r) => ({ kind: r.kind, object: r.object, detail: r.detail }));
}

/** Throw on any leak, naming each (migrate's after-step). */
export async function assertNoIdentityLeaks(sql: Sql): Promise<void> {
  const leaks = await identityLeaks(sql);
  if (leaks.length === 0) return;
  throw new Error(
    `identity gateway (0321): ${leaks.length} read(s) of an identity setting outside the readers: ` +
      leaks.map((l) => `${l.kind} ${l.object}: ${l.detail}`).join('; ') +
      ' (packages/db src/identity-gateway.ts)',
  );
}
