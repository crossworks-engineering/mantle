/**
 * Extractor: Entity reconciliation (exact / trigram / embedding / org-suffix) and relation edges.
 *
 * Split out of extractor.ts on 2026-09-02 (audit, bloat B1) with behaviour
 * unchanged; the sequencer in ../extractor.ts calls into here.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db, entities, entityEdges, nodes, pages, type Entity } from '@mantle/db';
import { embed } from '@mantle/embeddings';
import { step } from '@mantle/tracing';
import { mentionRefs, normaliseOrgName } from '@mantle/content';
import { isLikelyDifferentPerson } from '../person-names';
import { type ExtractorOutput } from '../extractor-parse';

/** Similarity threshold for resolving an entity mention to an existing entity. */
const ENTITY_DEDUP_THRESHOLD = 0.25;

// ─── Prompts ────────────────────────────────────────────────────────────────

/** A resolved entity mention (name + kind) as produced by the parser and
 *  threaded through the index + reconciliation stages. */
export type EntityMention = { name: string; kind: string };

async function reconcileEntity(
  ownerId: string,
  mention: { name: string; kind: string },
): Promise<{ entity: Entity; created: boolean }> {
  // 1. Exact name (case-insensitive) or alias match first — cheapest. Both OR
  //    branches are indexed: entities_owner_lname_kind_uq for lower(name), and
  //    entities_aliases_gin_idx for the alias membership. The alias test MUST be
  //    the containment form `aliases @> array[q]` — the scalar `q = any(aliases)`
  //    form is NOT recognized by the array GIN opclass (verified via EXPLAIN),
  //    so it would filter after an owner scan instead of using the index.
  const trimmed = mention.name.trim();
  const [exact] = await db
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.ownerId, ownerId),
        sql`lower(${entities.name}) = lower(${trimmed}) or ${entities.aliases} @> array[${trimmed}]::text[]`,
      ),
    )
    .limit(1);
  if (exact) return { entity: exact, created: false };

  // 2. Trigram fuzzy match within the same kind. Pick the strongest similarity.
  //    The `name % $q` predicate lets the trigram GIN (entities_name_trgm_idx)
  //    prefilter to candidates instead of computing similarity() over every
  //    same-owner/kind row — the `%` threshold (0.3) sits well below the 0.7
  //    acceptance gate below, so it never drops a real match.
  const trgmHits = await db
    .select({
      row: entities,
      sim: sql<number>`similarity(${entities.name}, ${trimmed})`,
    })
    .from(entities)
    .where(
      and(
        eq(entities.ownerId, ownerId),
        eq(entities.kind, mention.kind),
        sql`${entities.name} % ${trimmed}`,
      ),
    )
    .orderBy(sql`similarity(${entities.name}, ${trimmed}) desc`)
    .limit(1);
  if (trgmHits[0] && trgmHits[0].sim >= 0.7) {
    const existing = trgmHits[0].row;
    // Same-surname-different-given guard: surname alone hits the trigram
    // threshold, which would alias "Don Carter" into "Alex Carter". For
    // kind='person' we refuse the merge when both names look like full
    // given-name+surname pairs with the same surname but distinct given names.
    // Falls through to the embedding match below, which carries the same guard.
    if (!isLikelyDifferentPerson(mention, existing)) {
      // Looks like a match — register the new spelling as an alias.
      if (
        !existing.aliases.includes(trimmed) &&
        existing.name.toLowerCase() !== trimmed.toLowerCase()
      ) {
        await db
          .update(entities)
          .set({ aliases: [...existing.aliases, trimmed], updatedAt: new Date() })
          .where(eq(entities.id, existing.id));
      }
      return { entity: existing, created: false };
    }
  }

  // 3. Embedding match (when populated). We embed the mention only when we
  // need to compare; cheap thanks to the embedding_cache.
  try {
    const [mentionVec] = await Promise.all([embed(ownerId, trimmed)]);
    const vecHits = await db
      .select({
        row: entities,
        dist: sql<number>`${entities.embedding} <=> ${JSON.stringify(mentionVec)}::vector`,
      })
      .from(entities)
      .where(and(eq(entities.ownerId, ownerId), eq(entities.kind, mention.kind)))
      .orderBy(sql`${entities.embedding} <=> ${JSON.stringify(mentionVec)}::vector`)
      .limit(1);
    if (vecHits[0] && (vecHits[0].dist ?? 1) < ENTITY_DEDUP_THRESHOLD) {
      const existing = vecHits[0].row;
      // Same guard as the trigram path: embeddings of "Don Carter" and
      // "Alex Carter" are close enough to merge by default, which is wrong
      // for distinct people sharing a surname.
      if (!isLikelyDifferentPerson(mention, existing)) {
        if (
          !existing.aliases.includes(trimmed) &&
          existing.name.toLowerCase() !== trimmed.toLowerCase()
        ) {
          await db
            .update(entities)
            .set({ aliases: [...existing.aliases, trimmed], updatedAt: new Date() })
            .where(eq(entities.id, existing.id));
        }
        return { entity: existing, created: false };
      }
    }
  } catch {
    // embedding failure shouldn't block entity creation.
  }

  // 3b. Org legal-suffix match — "Acme (Pty) Ltd" ↔ existing "Acme". Last
  // chance before creating: only orgs, only when the legal-suffix-stripped
  // names are equal (the same conservative rule the dedup pass uses), so a new
  // legal-form variant resolves to the canonical instead of fragmenting the
  // graph. Folds the variant in as an alias for instant future matches.
  if (mention.kind === 'org') {
    const norm = normaliseOrgName(trimmed);
    if (norm) {
      const orgs = await db
        .select()
        .from(entities)
        .where(and(eq(entities.ownerId, ownerId), eq(entities.kind, 'org')));
      const hit = orgs.find(
        (o) => normaliseOrgName(o.name) === norm && o.name.toLowerCase() !== trimmed.toLowerCase(),
      );
      if (hit) {
        if (!hit.aliases.includes(trimmed)) {
          await db
            .update(entities)
            .set({ aliases: [...hit.aliases, trimmed], updatedAt: new Date() })
            .where(eq(entities.id, hit.id));
        }
        return { entity: hit, created: false };
      }
    }
  }

  // 4. No match — create new entity (embed its name + kind for future matches).
  let embedding: number[] | null = null;
  try {
    embedding = await embed(ownerId, `${mention.kind}: ${trimmed}`);
  } catch {
    // OK to create without embedding; can be backfilled later.
  }
  try {
    const [inserted] = await db
      .insert(entities)
      .values({
        ownerId,
        kind: mention.kind,
        name: trimmed,
        aliases: [],
        embedding,
      })
      .returning();
    if (!inserted) throw new Error('extractor: failed to insert entity');
    return { entity: inserted, created: true };
  } catch (err) {
    // Unique-violation on entities_owner_lname_kind_uq (migration 0055): a
    // concurrent extraction inserted this same (owner, name, kind) between our
    // step-1 check and here. That's the race that used to spawn duplicate
    // entities; now it's inert — re-select the winner and use it. Re-throw any
    // other error.
    if ((err as { code?: string }).code !== '23505') throw err;
    const [winner] = await db
      .select()
      .from(entities)
      .where(
        and(
          eq(entities.ownerId, ownerId),
          eq(entities.kind, mention.kind),
          sql`lower(${entities.name}) = lower(${trimmed})`,
        ),
      )
      .limit(1);
    if (!winner) throw err;
    // A concurrent extraction inserted it between our step-1 probe and here —
    // from this call's view it already existed, so count it as matched.
    return { entity: winner, created: false };
  }
}

// ─── Fact classification ────────────────────────────────────────────────────

/**
 * entity reconciliation: resolve each unique mention to an entity (dedup via
 * exact/trigram/embedding/org-suffix match, or create), collect this node's
 * `mentioned_in` edges plus a page's explicit @-mention / node-reference edges,
 * then atomically swap (delete this node's prior edges + insert the new set) in
 * one transaction. Returns the name→entityId map used by the relation + fact
 * passes.
 */
export async function reconcileEntities(
  node: typeof nodes.$inferSelect,
  ownerId: string,
  uniqueMentions: EntityMention[],
): Promise<Map<string, string>> {
  return await step(
    {
      name: 'reconcile_entities',
      kind: 'compute',
      input: {
        mentions: uniqueMentions.length,
        // Full list of mentions — names + kinds. truncateJson
        // applies the safety net at 64KB; a normal extractor
        // pass fits comfortably. The arrays-over-50 cap in
        // truncate.ts catches genuinely runaway iterations.
        preview: uniqueMentions.map((m) => ({
          name: m.name,
          kind: m.kind ?? 'unknown',
        })),
      },
    },
    async (h) => {
      // Idempotent rebuild: this node's prior edges are REPLACED, not
      // appended to — both the inbound mention edges (entity → this
      // node) and this node's outbound page/note links (this node →
      // other node). The delete + re-insert happens in ONE transaction
      // at the END of this step: entity reconciliation makes network
      // calls (candidate embeddings), and the old delete-first ordering
      // meant a crash mid-loop destroyed the previous extraction's
      // edges with nothing written to replace them. Edges are collected
      // in memory during the loop instead.
      const pendingEdges: (typeof entityEdges.$inferInsert)[] = [];
      const map = new Map<string, string>();
      // Entity ids that already have an edge this rebuild — dedupes the
      // NER pass against the explicit @-mention pass below.
      const edgedEntityIds = new Set<string>();
      let created = 0;
      let matched = 0;
      for (const mention of uniqueMentions) {
        try {
          // reconcileEntity already does the exact-match probe as its
          // first step and reports whether it matched or created — no
          // need for a second identical `lower(name)=…` query here.
          const { entity: ent, created: wasCreated } = await reconcileEntity(ownerId, mention);
          map.set(mention.name.trim().toLowerCase(), ent.id);
          if (wasCreated) created++;
          else matched++;
          pendingEdges.push({
            ownerId,
            sourceId: ent.id,
            sourceKind: 'entity',
            targetId: node.id,
            targetKind: 'node',
            relation: 'mentioned_in',
            validFrom: new Date(),
          });
          edgedEntityIds.add(ent.id);
        } catch (err) {
          console.error(
            `[extractor]   entity '${mention.name}' failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      // ─── explicit @-mentions / links (pages) ─────────────────────
      // A page's chips carry resolved ids. Entity refs → precise
      // `mentioned_in` edges (independent of NER recall, deduped against
      // the loop above). Node refs → `node --references--> node` edges
      // (backlinks). Both skip ids whose target no longer exists (edges
      // have no FK; integrity is application-level).
      let explicit = 0;
      let refs = 0;
      if (node.type === 'page') {
        try {
          const [pageRow] = await db
            .select({ doc: pages.doc })
            .from(pages)
            .where(eq(pages.nodeId, node.id))
            .limit(1);
          const { entityIds, nodeIds } = mentionRefs(pageRow?.doc);

          for (const entId of entityIds) {
            if (edgedEntityIds.has(entId)) continue;
            const [ent] = await db
              .select({ id: entities.id })
              .from(entities)
              .where(and(eq(entities.id, entId), eq(entities.ownerId, ownerId)))
              .limit(1);
            if (!ent) continue;
            pendingEdges.push({
              ownerId,
              sourceId: ent.id,
              sourceKind: 'entity',
              targetId: node.id,
              targetKind: 'node',
              relation: 'mentioned_in',
              validFrom: new Date(),
              data: { explicit: true },
            });
            edgedEntityIds.add(ent.id);
            explicit++;
          }

          const refSeen = new Set<string>();
          for (const refId of nodeIds) {
            if (refId === node.id || refSeen.has(refId)) continue;
            const [target] = await db
              .select({ id: nodes.id })
              .from(nodes)
              .where(and(eq(nodes.id, refId), eq(nodes.ownerId, ownerId)))
              .limit(1);
            if (!target) continue;
            pendingEdges.push({
              ownerId,
              sourceId: node.id,
              sourceKind: 'node',
              targetId: refId,
              targetKind: 'node',
              relation: 'references',
              validFrom: new Date(),
              data: { explicit: true },
            });
            refSeen.add(refId);
            refs++;
          }
        } catch (err) {
          console.error(
            '[extractor]   page mention/link edges failed:',
            err instanceof Error ? err.message : err,
          );
        }
      }

      // Atomic swap: clear this node's prior edges and write the new
      // set in one transaction (see the rebuild note at the top of this
      // step). All network work is done by now, so the tx is brief.
      await db.transaction(async (tx) => {
        await tx
          .delete(entityEdges)
          .where(
            and(
              eq(entityEdges.targetId, node.id),
              eq(entityEdges.targetKind, 'node'),
              eq(entityEdges.relation, 'mentioned_in'),
            ),
          );
        await tx
          .delete(entityEdges)
          .where(
            and(
              eq(entityEdges.sourceId, node.id),
              eq(entityEdges.sourceKind, 'node'),
              eq(entityEdges.relation, 'references'),
            ),
          );
        if (pendingEdges.length > 0) await tx.insert(entityEdges).values(pendingEdges);
      });

      h.setOutput({ matched, created, explicit, refs });
      return map;
    },
  );
}

/**
 * relation pass (entity↔entity edges → knowledge graph): resolve + dedupe the
 * parsed relations against the reconciled entity ids in memory, then swap
 * delete + insert in ONE transaction so a re-extract REPLACES this node's prior
 * relation edges (the only edges carrying source_node_id). Endpoints that don't
 * resolve to a known entity are dropped — we never invent entities from a
 * relation.
 */
export async function processRelations(
  node: typeof nodes.$inferSelect,
  ownerId: string,
  parsed: ExtractorOutput,
  entityIdByName: Map<string, string>,
): Promise<void> {
  await step(
    {
      name: 'process_relations',
      kind: 'compute',
      input: {
        candidates: parsed.relations.length,
        preview: parsed.relations.map((r) => ({
          subject: r.subject,
          relation: r.relation,
          object: r.object,
        })),
      },
    },
    async (h) => {
      // Resolve + dedupe in memory first, then swap delete + insert in
      // ONE transaction — the old delete-first ordering meant a crash
      // mid-loop destroyed the previous extraction's relation edges
      // with nothing written to replace them. No network calls here
      // (entity ids are already resolved), so the tx is brief.
      const t = { ADD: 0, NOOP: 0, skipped: 0 };
      const seen = new Set<string>();
      const newEdges: (typeof entityEdges.$inferInsert)[] = [];
      for (const rel of parsed.relations) {
        const subjId = entityIdByName.get(rel.subject.trim().toLowerCase());
        const objId = entityIdByName.get(rel.object.trim().toLowerCase());
        // Skip endpoints that didn't resolve to a known entity — we never
        // invent entities from a relation, to keep graph junk out.
        if (!subjId || !objId || subjId === objId) {
          t.skipped++;
          continue;
        }
        const key = `${subjId}|${rel.relation}|${objId}`;
        if (seen.has(key)) {
          t.NOOP++;
          continue;
        }
        seen.add(key);
        newEdges.push({
          ownerId,
          sourceId: subjId,
          sourceKind: 'entity',
          targetId: objId,
          targetKind: 'entity',
          relation: rel.relation,
          validFrom: new Date(),
          data: { source_node_id: node.id, confidence: rel.confidence },
        });
        t.ADD++;
      }
      await db.transaction(async (tx) => {
        await tx
          .delete(entityEdges)
          .where(
            and(
              eq(entityEdges.ownerId, ownerId),
              sql`${entityEdges.data}->>'source_node_id' = ${node.id}`,
            ),
          );
        if (newEdges.length > 0) await tx.insert(entityEdges).values(newEdges);
      });
      h.setOutput(t);
      h.setMeta({ added: t.ADD, deduped: t.NOOP, unresolved: t.skipped });
      console.log(`[extractor]   → relations: ADD=${t.ADD} NOOP=${t.NOOP} skipped=${t.skipped}`);
      return t;
    },
  );
}
