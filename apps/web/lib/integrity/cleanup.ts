/**
 * Scoped teardown for a probe run (or all probe data).
 *
 * Order, and why:
 *   1. Delete the probe nodes via their *real* delete paths — file nodes
 *      through `deleteFileById` (also removes disk bytes), the rest by id.
 *      This fires the same FK cascade + reaper triggers (0058 mentioned_in
 *      edges, 0059 kind-aware facts) the real delete path does — so the sweep
 *      itself exercises the cleanup machinery.
 *   2. Delete the traces whose subject is a probe node (traces have no reaper;
 *      trace_steps cascade from traces).
 *   3. Sweep now-orphaned probe entities (zero edges, zero facts) matching the
 *      fixtures' distinctive vocabulary — node deletion reaps edges but never
 *      the entities, so without this they'd accumulate run over run.
 *
 * Everything is owner-scoped and tag-scoped; passing no tag cleans ALL probe
 * data for the user.
 */
import { db, traces, emailAccounts } from '@mantle/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { deleteFileById } from '@mantle/files';

import { PROBE_BASE_TAG } from './types';
import { PROBE_EMAIL_ADDRESS } from './fixtures';

/** Invented, collision-proof names the fixtures use. Deliberately NOT the
 *  generic tokens the probe text also mentions (e.g. "Thelby", "MGN12") — those
 *  could match a real entity, and although the orphan guard below protects any
 *  *referenced* entity, a real but freshly-created (not-yet-extracted) entity
 *  with that name would have no edges/facts yet and could be wrongly swept. We
 *  trade a little cleanup completeness (a stray "Thelby" probe entity may
 *  linger harmlessly) for zero real-data-loss risk. */
const PROBE_ENTITY_PATTERNS = ['vorthelm%', 'quintus bramblewick'];

export type CleanupResult = {
  tag: string;
  nodesDeleted: number;
  filesDeleted: number;
  tracesDeleted: number;
  entitiesDeleted: number;
};

function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: T[] }).rows ?? [])) as T[];
}

export async function cleanupProbes(ownerId: string, tag?: string): Promise<CleanupResult> {
  const scopeTag = tag ?? PROBE_BASE_TAG;

  // 1. Find the probe nodes for this scope.
  const nodeRows = rowsOf<{ id: string; type: string }>(
    await db.execute(sql`
      SELECT id, type::text AS type FROM nodes
      WHERE owner_id = ${ownerId} AND ${scopeTag} = ANY(tags)
    `),
  );
  const ids = nodeRows.map((n) => n.id);

  let nodesDeleted = 0;
  let filesDeleted = 0;
  let tracesDeleted = 0;

  if (ids.length) {
    // 2. Traces first (no FK to nodes; steps cascade from traces).
    const delTraces = await db
      .delete(traces)
      .where(and(eq(traces.ownerId, ownerId), inArray(traces.subjectId, ids)))
      .returning({ id: traces.id });
    tracesDeleted = delTraces.length;

    // 3. Nodes via real delete paths.
    for (const n of nodeRows) {
      if (n.type === 'file') {
        const res = await deleteFileById({ ownerId, fileId: n.id });
        if (res.ok) {
          filesDeleted++;
          nodesDeleted++;
        }
      } else {
        await db.execute(sql`DELETE FROM nodes WHERE id = ${n.id} AND owner_id = ${ownerId}`);
        nodesDeleted++;
      }
    }
  }

  // 4. Orphaned probe entities (zero edges, zero facts, distinctive names).
  const nameFilter = sql.join(
    PROBE_ENTITY_PATTERNS.map((p) => sql`lower(e.name) LIKE ${p}`),
    sql` OR `,
  );
  const delEnts = rowsOf<{ id: string }>(
    await db.execute(sql`
      DELETE FROM entities e
      WHERE e.owner_id = ${ownerId}
        AND (${nameFilter})
        AND NOT EXISTS (SELECT 1 FROM entity_edges ed WHERE ed.source_id = e.id OR ed.target_id = e.id)
        AND NOT EXISTS (SELECT 1 FROM facts f WHERE f.entity_id = e.id)
      RETURNING e.id
    `),
  );

  // 5. On a FULL clean (no run tag), drop the reusable probe email account too
  //    (cascades any stray emails rows). Per-run cleans leave it — it's shared
  //    scaffolding, recreated on the next email fixture.
  if (!tag) {
    await db
      .delete(emailAccounts)
      .where(and(eq(emailAccounts.userId, ownerId), eq(emailAccounts.address, PROBE_EMAIL_ADDRESS)));
  }

  return {
    tag: scopeTag,
    nodesDeleted,
    filesDeleted,
    tracesDeleted,
    entitiesDeleted: delEnts.length,
  };
}
