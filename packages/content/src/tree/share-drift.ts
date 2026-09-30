/**
 * Repair folder-share drift (folder audit 2026-09-30, Y1): rows whose stored
 * nodes.inherited_level differs from what migration 0204's rule gives
 * (mantle_inherited_level). The triggers keep it true for every ordinary
 * write; this catches what a race between an unshare and an insert into the
 * same folder can leave (each statement reads the other's work under its own
 * snapshot), and anything a future writer gets wrong. A row read at a share
 * nobody set any more fails OPEN, so the nightly sweep repairs and reports.
 * Plain SQL, no model, idempotent: a no-op once clean.
 */
import { sql } from 'drizzle-orm';
import { db } from '@mantle/db';

export type ShareDriftResult = {
  /** Rows found drifted (all owners). */
  drifted: number;
  /** Rows repaired (0 on a dry run). */
  repaired: number;
  /** Of the drifted, how many were read MORE openly than the rule allows. */
  openedTooFar: number;
};

/** The only rows that can drift: those that hold a share, or could take one
 *  (workspace kinds under a shareable root). Email, tasks and the rest are
 *  never read, so the nightly scan stays small (review F13). */
const candidates = sql`(n.inherited_level is not null
  or (mantle_workspace_kind(n.type) and nlevel(n.path) > 1
      and subpath(n.path, 0, 1)::text in ('files', 'notes', 'pages', 'draw', 'tables', 'formulas', 'apps')))`;

export async function repairShareDrift(opts: { dryRun?: boolean } = {}): Promise<ShareDriftResult> {
  const drift = sql`
    select n.id, n.inherited_level as stored,
           mantle_inherited_level(n.owner_id, n.path, n.type) as rule
      from nodes n
     where ${candidates}
       and n.inherited_level is distinct from mantle_inherited_level(n.owner_id, n.path, n.type)`;
  const [count] = (await db.execute(sql`
    select count(*)::int as drifted,
           count(*) filter (where d.stored is not null
                             and (d.rule is null or (d.stored = 'client' and d.rule = 'team')))::int
             as opened
      from (${drift}) d`)) as unknown as Array<{ drifted: number; opened: number }>;
  const drifted = Number(count?.drifted ?? 0);
  const openedTooFar = Number(count?.opened ?? 0);
  if (opts.dryRun || drifted === 0) return { drifted, repaired: 0, openedTooFar };
  const done = (await db.execute(sql`
    update nodes n
       set inherited_level = mantle_inherited_level(n.owner_id, n.path, n.type)
     where ${candidates}
       and n.inherited_level is distinct from mantle_inherited_level(n.owner_id, n.path, n.type)
    returning n.id`)) as unknown as unknown[];
  return { drifted, repaired: done.length, openedTooFar };
}
