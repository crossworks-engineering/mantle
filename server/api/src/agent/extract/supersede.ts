/**
 * Extractor: Superseding earlier versions of a re-uploaded file.
 *
 * Split out of extractor.ts on 2026-09-02 (audit, bloat B1) with behaviour
 * unchanged; the sequencer in ../extractor.ts calls into here.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db, nodes } from '@mantle/db';
import { step } from '@mantle/tracing';
import { fileFamilyKey } from '@mantle/content';
import { env } from '@mantle/config';

/** Salience for superseded file versions (older same-family exports). A
 *  re-ranking nudge — λ·(1−0.5)=+0.075 effective distance — not a hide.
 *  Set to 1 to disable version demotion entirely. */
const SUPERSEDED_FILE_SALIENCE = Math.min(
  1,
  Math.max(0, Number(env('MANTLE_SUPERSEDED_FILE_SALIENCE') ?? 0.5)),
);

/**
 * versioned-export supersede (file nodes): group same-family siblings
 * (fileFamilyKey) and down-weight every version but the newest (salience is a
 * re-ranking nudge, not a hide). Idempotent + self-healing — restores the
 * newest to 1.0 if a prior pass demoted it. Best-effort; the caller isolates it.
 */
export async function supersedeFileVersions(
  node: typeof nodes.$inferSelect,
  ownerId: string,
): Promise<void> {
  // Weekly dumps and "_version_NN" workbooks arrive as siblings whose
  // titles differ only by a date/version token; retrieval then hits
  // whichever version is cosine-closest — often stale. Group siblings by
  // fileFamilyKey and down-weight every version but the newest (salience
  // is a re-ranking nudge, λ·(1−salience), not a hide), stamping the
  // superseded_by lineage edge (reason 'version') so retrieval annotates
  // hits with the living successor. Idempotent and self-healing: the
  // newest is restored (salience 1, edge cleared) if a prior pass demoted
  // it — but ONLY when this heuristic owns the mark; manual 'corrected' /
  // 'migrated' edges are never touched. Best-effort — a failure here must
  // not fail the extraction.
  await step(
    { name: 'supersede_file_versions', kind: 'compute', input: { title: node.title } },
    async (h) => {
      const familyKey = fileFamilyKey(node.title);
      if (!familyKey) {
        h.setOutput({ family: null });
        return;
      }
      const siblings = await db
        .select({
          id: nodes.id,
          title: nodes.title,
          createdAt: nodes.createdAt,
          salience: nodes.salience,
          supersededBy: nodes.supersededBy,
          supersededReason: nodes.supersededReason,
        })
        .from(nodes)
        .where(
          and(
            eq(nodes.ownerId, ownerId),
            eq(nodes.type, 'file'),
            node.parentId ? eq(nodes.parentId, node.parentId) : isNull(nodes.parentId),
          ),
        );
      const family = siblings
        .filter((s) => fileFamilyKey(s.title) === familyKey)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      const [newest, ...older] = family;
      // Manual marks outrank this heuristic: a sibling explicitly superseded
      // ('corrected') or replaced by a page ('migrated') keeps that mark — the
      // step manages only its own 'version' marks and pristine rows. Ownership
      // keys on the REASON, not the edge: a bare manual mark ("this is
      // outdated", no successor pointer) has superseded_by null but must not
      // be touched either.
      const heuristicOwned = (s: (typeof family)[number]) =>
        s.supersededReason === null || s.supersededReason === 'version';
      // If the newest sibling was itself MANUALLY superseded (e.g. marked
      // 'corrected' — with or without a pointer — because the new export was
      // garbage), the heuristic stands down entirely — appointing it family
      // head would write edges INTO a retired node and could close a cycle.
      const headId = newest && heuristicOwned(newest) ? newest.id : null;
      const demote = headId
        ? older.filter(
            (s) =>
              heuristicOwned(s) &&
              (s.salience > SUPERSEDED_FILE_SALIENCE || s.supersededBy !== headId),
          )
        : [];
      if (demote.length > 0 && headId) {
        await db
          .update(nodes)
          .set({
            salience: SUPERSEDED_FILE_SALIENCE,
            supersededBy: headId,
            supersededReason: 'version',
          })
          .where(
            inArray(
              nodes.id,
              demote.map((s) => s.id),
            ),
          );
      }
      // Restore the head whenever a prior pass (or stale family membership —
      // e.g. a rename moved a version-marked node into this family as newest)
      // left a heuristic-owned demotion or edge on it. Clearing the head's own
      // outgoing edge in the same pass keeps the family acyclic: siblings now
      // point at it, so it must not point back into the chain.
      if (headId && newest && (newest.salience < 1 || newest.supersededBy !== null)) {
        await db
          .update(nodes)
          .set({ salience: 1, supersededBy: null, supersededReason: null })
          .where(eq(nodes.id, headId));
      }
      h.setOutput({
        family: familyKey,
        versions: family.length,
        demoted: demote.length,
        newest: newest?.title ?? null,
      });
    },
  );
}
