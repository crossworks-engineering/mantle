/**
 * Repair folder-share drift (folder audit 2026-09-30, Y1): rows whose stored
 * nodes.inherited_level differs from what migration 0204's rule gives
 * (mantle_inherited_level). The triggers keep it true for every ordinary
 * write; this catches what a race between an unshare and an insert into the
 * same folder can leave (each statement reads the other's work under its own
 * snapshot), and anything a future writer gets wrong. A row read at a share
 * nobody set any more fails OPEN, so the nightly sweep repairs and reports.
 * Plain SQL, no model, idempotent: a no-op once clean.
 *
 * The same for what embeds follow (migration 0208): the embed edges are put
 * back to what the stored pages, drawings and notes say, then every
 * nodes.embedded_level that differs from its rule (mantle_embedded_level) is
 * repaired. An edge or a level a trigger missed (a write while a trigger was
 * off, a race between two changes to one embed's embedders) fails open or
 * closed; both are counted. A row deleted while the repair runs drops out
 * of it; it never fails the sweep.
 */
import { sql } from 'drizzle-orm';
import { db, withDeadlockRetry, withHeads } from '@mantle/db';

type Exec = Pick<typeof db, 'execute'>;

/** How many rows (or edge ends) one repair transaction takes (W4b fix round
 *  1, L5): each batch is its own short transaction with its own heads, so a
 *  big repair never holds every head and row lock of the brain at once. */
export const REPAIR_BATCH = 500;

/** `ids` in batches of at most `size`. */
export function repairBatches<T>(ids: readonly T[], size = REPAIR_BATCH): T[][] {
  const step = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += step) out.push(ids.slice(i, i + step));
  return out;
}

/** Run a repair write with the heads of `ids` first (the level bridge,
 *  0251, rewrites the grants of every row whose level it changes; what
 *  follows from it, the bridge locks itself). Nothing to do: no write. */
async function withRepairHeads(ids: readonly string[], fn: (tx: Exec) => Promise<unknown>) {
  if (ids.length === 0) return;
  await withDeadlockRetry(() => withHeads(ids, 'update', (tx) => fn(tx)));
}

/** A repair over `ids`, one transaction per batch, each with its batch's
 *  heads first. */
async function inRepairBatches(
  ids: readonly string[],
  size: number,
  fn: (tx: Exec, batch: string[]) => Promise<unknown>,
): Promise<void> {
  for (const batch of repairBatches(ids, size)) {
    await withRepairHeads(batch, (tx) => fn(tx, batch));
  }
}

const uuids = (ids: readonly string[]) => `{${ids.join(',')}}`;

const idsOf = (rows: unknown) => (rows as Array<{ id: string }>).map((r) => r.id);

export type ShareDriftResult = {
  /** Rows found drifted (all owners). */
  drifted: number;
  /** Rows repaired (0 on a dry run). */
  repaired: number;
  /** Of the drifted, how many were read MORE openly than the rule allows. */
  openedTooFar: number;
  /** Embed edges missing or left over against the stored data. */
  edgesDrifted: number;
  /** Rows whose embedded level differs from its rule (after the edges are
   *  put right, on a repair). */
  embeddedDrifted: number;
  /** Of those, how many were read MORE openly than the rule allows. */
  embeddedOpenedTooFar: number;
};

/** The edges the stored data gives: pages, drawings and notes. */
const EXPECTED = sql`(
    select p.node_id as from_id, t as to_id from pages p
     cross join lateral unnest(mantle_embed_targets(p.node_id, mantle_page_embed_refs(p.doc))) t
    union
    select d.node_id, t from draws d
     cross join lateral unnest(mantle_embed_targets(d.node_id, mantle_draw_embed_refs(d.scene, d.file_refs))) t
    union
    select n.id, t from nodes n
     cross join lateral unnest(mantle_embed_targets(n.id, mantle_note_embed_refs(n.data->>'content'))) t
     where n.type = 'note' and jsonb_typeof(n.data) = 'object' and n.data ? 'content')`;

/** The same edges, for the `from` ends in `froms` only. */
const expectedFrom = (froms: readonly string[]) => sql`(
    select p.node_id as from_id, t as to_id from pages p
     cross join lateral unnest(mantle_embed_targets(p.node_id, mantle_page_embed_refs(p.doc))) t
     where p.node_id = any(${uuids(froms)}::uuid[])
    union
    select d.node_id, t from draws d
     cross join lateral unnest(mantle_embed_targets(d.node_id, mantle_draw_embed_refs(d.scene, d.file_refs))) t
     where d.node_id = any(${uuids(froms)}::uuid[])
    union
    select n.id, t from nodes n
     cross join lateral unnest(mantle_embed_targets(n.id, mantle_note_embed_refs(n.data->>'content'))) t
     where n.type = 'note' and jsonb_typeof(n.data) = 'object' and n.data ? 'content'
       and n.id = any(${uuids(froms)}::uuid[]))`;

/** The rows whose embedded level can be wrong: those that hold one, or
 *  that something embeds. */
const embedCandidates = sql`(n.embedded_level is not null
  or exists (select 1 from node_embeds e where e.to_id = n.id))`;

async function repairEmbedDrift(
  dryRun: boolean,
  batchSize: number,
): Promise<Pick<ShareDriftResult, 'edgesDrifted' | 'embeddedDrifted' | 'embeddedOpenedTooFar'>> {
  const [edges] = (await db.execute(sql`
    select (select count(*) from ${EXPECTED} x
             where not exists (select 1 from node_embeds e
                                where e.from_id = x.from_id and e.to_id = x.to_id))::int
         + (select count(*) from node_embeds e
             where not exists (select 1 from ${EXPECTED} x
                                where x.from_id = e.from_id and x.to_id = e.to_id))::int
           as n`)) as unknown as Array<{ n: number }>;
  const edgesDrifted = Number(edges?.n ?? 0);
  if (!dryRun && edgesDrifted > 0) {
    // The drifted edges (missing or left over), read once; then fixed in
    // batches, each with the heads of its edges' ends first.
    const pairs = (await db.execute(sql`
        select x.from_id::text as f, x.to_id::text as t from ${EXPECTED} x
         where not exists (select 1 from node_embeds e
                            where e.from_id = x.from_id and e.to_id = x.to_id)
        union
        select e.from_id::text, e.to_id::text from node_embeds e
         where not exists (select 1 from ${EXPECTED} x
                            where x.from_id = e.from_id and x.to_id = e.to_id)`)) as unknown as Array<{
      f: string;
      t: string;
    }>;
    for (const batch of repairBatches(pairs, Math.max(1, Math.floor(batchSize / 2)))) {
      const fl = uuids(batch.map((p) => p.f));
      const tl = uuids(batch.map((p) => p.t));
      const froms = [...new Set(batch.map((p) => p.f))];
      const ends = idsOf(
        await db.execute(sql`
          select distinct n.id from nodes n
           where n.id = any(${fl}::uuid[]) or n.id = any(${tl}::uuid[])`),
      );
      await withRepairHeads(ends, async (tx) => {
        // Through the table, so the edge triggers refresh what the fix reaches.
        await tx.execute(sql`
        delete from node_embeds e
         using unnest(${fl}::uuid[], ${tl}::uuid[]) p(f, t)
         where e.from_id = p.f and e.to_id = p.t
           and not exists (select 1 from ${expectedFrom(froms)} x
                            where x.from_id = e.from_id and x.to_id = e.to_id)`);
        // Only the missing edges, each with both ends locked. The sweep runs
        // against a live brain: a row deleted after this statement's snapshot
        // read it would fail the foreign key and with it the whole sweep. Under
        // the lock such a row drops out instead (read committed skips a locked
        // row that turns out deleted), and a delete that comes later waits.
        await tx.execute(sql`
        insert into node_embeds (from_id, to_id)
        select x.from_id, x.to_id from ${expectedFrom(froms)} x
          join unnest(${fl}::uuid[], ${tl}::uuid[]) p(f, t) on p.f = x.from_id and p.t = x.to_id
          join nodes a on a.id = x.from_id
          join nodes b on b.id = x.to_id
         where not exists (select 1 from node_embeds e
                            where e.from_id = x.from_id and e.to_id = x.to_id)
           for key share of a, b
        on conflict do nothing`);
      });
    }
  }
  const rule = sql`mantle_embedded_level(n.owner_id, n.id, n.type)`;
  const [count] = (await db.execute(sql`
    select count(*)::int as drifted,
           count(*) filter (where d.stored is not null
                             and (d.rule is null or (d.stored = 'client' and d.rule = 'team')))::int
             as opened
      from (select n.embedded_level as stored, ${rule} as rule from nodes n
             where ${embedCandidates} and n.embedded_level is distinct from ${rule}) d`)) as unknown as Array<{
    drifted: number;
    opened: number;
  }>;
  const embeddedDrifted = Number(count?.drifted ?? 0);
  if (!dryRun && embeddedDrifted > 0) {
    const ids = idsOf(
      await db.execute(sql`
        select n.id from nodes n
         where ${embedCandidates} and n.embedded_level is distinct from ${rule}`),
    );
    await inRepairBatches(ids, batchSize, (tx, batch) =>
      tx.execute(sql`
        update nodes n set embedded_level = ${rule}
         where n.id = any(${uuids(batch)}::uuid[])
           and n.embedded_level is distinct from ${rule}`),
    );
  }
  return {
    edgesDrifted,
    embeddedDrifted,
    embeddedOpenedTooFar: Number(count?.opened ?? 0),
  };
}

/** The only rows that can drift: those that hold a share, or could take one
 *  (workspace kinds under a shareable root). Email, tasks and the rest are
 *  never read, so the nightly scan stays small (review F13). */
const candidates = sql`(n.inherited_level is not null
  or (mantle_workspace_kind(n.type) and nlevel(n.path) > 1
      and subpath(n.path, 0, 1)::text in ('files', 'notes', 'pages', 'draw', 'tables', 'formulas', 'apps')))`;

export async function repairShareDrift(
  opts: {
    dryRun?: boolean;
    /** Rows per repair transaction (REPAIR_BATCH); edges take half as many,
     *  each has two ends. For tests. */
    batchSize?: number;
  } = {},
): Promise<ShareDriftResult> {
  const batchSize = opts.batchSize ?? REPAIR_BATCH;
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
  let repaired = 0;
  if (!opts.dryRun && drifted > 0) {
    // Shares first: what embeds are read through follows them (0208 trigger).
    const ids = idsOf(await db.execute(sql`select d.id from (${drift}) d`));
    await inRepairBatches(ids, batchSize, async (tx, batch) => {
      const done = (await tx.execute(sql`
        update nodes n
           set inherited_level = mantle_inherited_level(n.owner_id, n.path, n.type)
         where n.id = any(${uuids(batch)}::uuid[])
           and n.inherited_level is distinct from mantle_inherited_level(n.owner_id, n.path, n.type)
        returning n.id`)) as unknown as unknown[];
      repaired += done.length;
    });
  }
  return { drifted, repaired, openedTooFar, ...(await repairEmbedDrift(!!opts.dryRun, batchSize)) };
}
