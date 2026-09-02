/**
 * Recall — the DB half of the compiler (S1). The pure parse/lint core lives
 * in `@mantle/content-core/recall-compile`; this module walks the page tree,
 * aggregates the map-level lint, and owns the serving rows.
 *
 * Contract (design page "Recall — architecture plan v1", task 97cf7850):
 *  - a map is a page tree whose ROOT carries the `recall` tag; a page tagged
 *    `prompt` compiles as a prompt (embedded for recall_match);
 *  - ANY member commit recompiles the WHOLE map — options cross-reference
 *    siblings, so single-page compiles cannot validate; maps are capped at
 *    RECALL_MAX_MAP_NODES members, so this stays milliseconds;
 *  - lint ERRORS block the COMPILE, never the commit: the pages publish, the
 *    map keeps serving its last good rev, and the report lands on the map row;
 *  - the serving write is delete-then-one-batch-insert, so intra-map slug
 *    handoffs (two pages swapping titles) can never trip the unique index
 *    mid-transaction;
 *  - prompt embeddings are the one async step — vectors are carried forward
 *    for unchanged prompts and refilled fire-and-forget otherwise.
 *
 * Every entry point here is no-throw: a Recall failure must never take a
 * page write down with it.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { db, notifyNodeIngested, recallMaps, recallNodes } from '@mantle/db';
import { getRecallEmbedder } from './embed-bridge';
import {
  RECALL_MAX_MAP_NODES,
  RECALL_PROMPT_TAG,
  RECALL_TAG,
  assignRecallSlugs,
  parseRecallDoc,
  recallSlug,
  type RecallLintIssue,
} from '@mantle/content-core/recall-compile';

export { RECALL_PROMPT_TAG, RECALL_TAG };

/** Sanity cap on tree walks — cycle guard, not a product limit. */
const MAX_TREE_DEPTH = 64;

const rowsOf = <T>(result: unknown): T[] =>
  (Array.isArray(result) ? result : ((result as { rows?: T[] }).rows ?? [])) as T[];

/** Walk `parent_id` up to the page tree's root. Returns the root's id and
 *  tags (the page itself, when top-level). Depth-capped for cycle safety. */
export async function findPageRoot(
  ownerId: string,
  pageId: string,
): Promise<{ id: string; tags: string[] } | null> {
  const result = await db.execute(sql`
    with recursive up as (
      select id, parent_id, tags, 1 as depth
        from nodes where id = ${pageId} and owner_id = ${ownerId} and type = 'page'
      union all
      select n.id, n.parent_id, n.tags, up.depth + 1
        from nodes n
        join up on n.id = up.parent_id
       where n.owner_id = ${ownerId} and n.type = 'page' and up.depth < ${MAX_TREE_DEPTH}
    )
    select id, tags from up order by depth desc limit 1
  `);
  const [row] = rowsOf<{ id: string; tags: string[] | null }>(result);
  return row ? { id: row.id, tags: row.tags ?? [] } : null;
}

type MemberRow = {
  id: string;
  title: string;
  tags: string[] | null;
  doc: unknown;
  version: number;
};

/** Every page in the tree under `rootId` (inclusive), root first then by
 *  creation order (id as the tie-break, so bulk-imported same-instant pages
 *  keep a deterministic slug order). */
async function listMapMembers(ownerId: string, rootId: string): Promise<MemberRow[]> {
  const result = await db.execute(sql`
    with recursive down as (
      select id from nodes where id = ${rootId} and owner_id = ${ownerId} and type = 'page'
      union
      select n.id from nodes n join down d on n.parent_id = d.id
       where n.owner_id = ${ownerId} and n.type = 'page'
    )
    select n.id, n.title, n.tags, p.doc, p.version
      from down
      join nodes n on n.id = down.id
      join pages p on p.node_id = down.id
     order by (down.id = ${rootId}) desc, n.created_at asc, n.id asc
  `);
  return rowsOf<MemberRow>(result);
}

/** A map's public slug must be unique per owner (`recall_maps_owner_slug_uq`).
 *  Two roots titled "Projects" would otherwise abort the second map's compile
 *  transaction with no report — so the slug counts up until free, and a map
 *  that already owns a slug for this base keeps it (stability over prettiness). */
async function resolveMapSlug(ownerId: string, rootId: string, base: string): Promise<string> {
  const taken = await db
    .select({ id: recallMaps.id, slug: recallMaps.slug })
    .from(recallMaps)
    .where(eq(recallMaps.ownerId, ownerId));
  const mine = taken.find((t) => t.id === rootId);
  if (mine && (mine.slug === base || mine.slug.startsWith(`${base}-`))) return mine.slug;
  const others = new Set(taken.filter((t) => t.id !== rootId).map((t) => t.slug));
  let slug = base;
  for (let n = 2; others.has(slug); n++) slug = `${base}-${n}`;
  return slug;
}

export type RecallCompileResult = {
  ok: boolean;
  mapId: string;
  issues: RecallLintIssue[];
  nodeCount: number;
};

/** Record a failed compile on the map row without touching served nodes. */
async function recordCompileFailure(
  ownerId: string,
  rootId: string,
  title: string,
  enterWhen: string,
  issues: RecallLintIssue[],
): Promise<void> {
  const mapSlug = await resolveMapSlug(ownerId, rootId, recallSlug(title));
  await db
    .insert(recallMaps)
    .values({
      id: rootId,
      ownerId,
      slug: mapSlug,
      title,
      enterWhen,
      nodeCount: 0,
      lastCompileOk: false,
      lastCompileReport: issues,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: recallMaps.id,
      set: { lastCompileOk: false, lastCompileReport: issues, updatedAt: new Date() },
    });
}

/**
 * Compile one map from its committed pages. Writes serving rows only when the
 * lint has no errors; always records the outcome on the map row.
 */
export async function compileRecallMap(
  ownerId: string,
  rootId: string,
): Promise<RecallCompileResult> {
  const members = await listMapMembers(ownerId, rootId);
  const root = members[0];
  if (!root || root.id !== rootId) {
    return { ok: false, mapId: rootId, issues: [], nodeCount: 0 };
  }

  if (members.length > RECALL_MAX_MAP_NODES) {
    const issues: RecallLintIssue[] = [
      {
        severity: 'error',
        code: 'map-too-big',
        message: `This tree has ${members.length} pages; a Recall map is capped at ${RECALL_MAX_MAP_NODES}. Split it, or untag pages that aren't part of the map.`,
        pageId: rootId,
      },
    ];
    await recordCompileFailure(ownerId, rootId, root.title, root.title, issues);
    return { ok: false, mapId: rootId, issues, nodeCount: 0 };
  }

  const memberIds = new Set(members.map((m) => m.id));
  const slugs = assignRecallSlugs(members.map((m) => ({ id: m.id, title: m.title })));
  const issues: RecallLintIssue[] = [];
  const referenced = new Set<string>();

  const compiled = members.map((m) => {
    const isRoot = m.id === rootId;
    const isPrompt = (m.tags ?? []).includes(RECALL_PROMPT_TAG);
    // A one-page map that is a tagged prompt IS a standalone prompt; a
    // multi-node map's root is its index (a prompt tag there is a mistake).
    const kind = isRoot
      ? isPrompt && members.length === 1
        ? 'prompt'
        : 'index'
      : isPrompt
        ? 'prompt'
        : 'knowledge';
    if (isRoot && isPrompt && members.length > 1) {
      issues.push({
        severity: 'warning',
        code: 'options-shape',
        message:
          'The map root is tagged `prompt` but has sub-pages — the root serves as the index; move the prompt to its own page.',
        pageId: m.id,
      });
    }
    const parsed = parseRecallDoc(m.doc, { isPrompt: kind === 'prompt' });
    for (const issue of parsed.issues) issues.push({ ...issue, pageId: m.id });

    const options = (parsed.options ?? []).flatMap((o) => {
      if (!memberIds.has(o.targetPageId)) {
        issues.push({
          severity: 'error',
          code: 'target-outside-map',
          message: `Option “${o.label}” points at a page that is not in this map's tree.`,
          pageId: m.id,
        });
        return [];
      }
      referenced.add(o.targetPageId);
      return [{ label: o.label, useWhen: o.useWhen, targetSlug: slugs.get(o.targetPageId)! }];
    });

    if (isRoot && kind === 'index' && members.length > 1 && options.length === 0) {
      issues.push({
        severity: 'error',
        code: 'index-no-options',
        message:
          'The map root is the index — it must carry an Options block pointing into the map.',
        pageId: m.id,
      });
    }

    return { member: m, kind, parsed, options };
  });

  for (const c of compiled) {
    if (c.member.id !== rootId && !referenced.has(c.member.id)) {
      issues.push({
        severity: 'warning',
        code: 'orphan-node',
        message: `“${c.member.title}” is in the map's tree but no option leads to it.`,
        pageId: c.member.id,
      });
    }
  }

  const errors = issues.filter((i) => i.severity === 'error');
  const enterWhen = compiled[0]!.parsed.useWhen ?? root.title;

  if (errors.length > 0) {
    await recordCompileFailure(ownerId, rootId, root.title, enterWhen, issues);
    return { ok: false, mapId: rootId, issues, nodeCount: 0 };
  }

  const mapSlug = await resolveMapSlug(ownerId, rootId, recallSlug(root.title));
  const isNewMap =
    (
      await db
        .select({ id: recallMaps.id })
        .from(recallMaps)
        .where(eq(recallMaps.id, rootId))
        .limit(1)
    ).length === 0;

  // Clean compile — carry forward vectors whose embed inputs did not change,
  // THROUGH the delete-and-reinsert below (vectors ride the insert values).
  const existing = rowsOf<{
    id: string;
    title: string;
    body_md: string;
    use_when: string;
    embedding_text: string | null;
  }>(
    await db.execute(sql`
      select id, title, body_md, use_when, embedding::text as embedding_text
        from recall_nodes where map_id = ${rootId} and owner_id = ${ownerId}
    `),
  );
  const carried = new Map<string, number[]>();
  for (const e of existing) {
    if (!e.embedding_text) continue;
    const c = compiled.find((x) => x.member.id === e.id);
    if (
      c &&
      c.kind === 'prompt' &&
      c.parsed.bodyMarkdown === e.body_md &&
      (c.parsed.useWhen ?? '') === e.use_when &&
      c.member.title === e.title
    ) {
      try {
        carried.set(e.id, JSON.parse(e.embedding_text) as number[]);
      } catch {
        // Unparseable vector text — re-embed instead of carrying garbage.
      }
    }
  }

  const now = new Date();
  const values = compiled.map((c) => ({
    id: c.member.id,
    ownerId,
    mapId: rootId,
    slug: slugs.get(c.member.id)!,
    kind: c.kind,
    title: c.member.title,
    bodyMd: c.parsed.bodyMarkdown,
    bodyChars: c.parsed.bodyMarkdown.length,
    useWhen: c.parsed.useWhen ?? '',
    options: c.options,
    embedding: c.kind === 'prompt' ? (carried.get(c.member.id) ?? null) : null,
    sourceVersion: c.member.version,
    updatedAt: now,
  }));

  await db.transaction(async (tx) => {
    await tx
      .insert(recallMaps)
      .values({
        id: rootId,
        ownerId,
        slug: mapSlug,
        title: root.title,
        enterWhen,
        nodeCount: compiled.length,
        lastCompileOk: true,
        lastCompileReport: issues.length > 0 ? issues : null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: recallMaps.id,
        set: {
          slug: mapSlug,
          title: root.title,
          enterWhen,
          nodeCount: compiled.length,
          lastCompileOk: true,
          lastCompileReport: issues.length > 0 ? issues : null,
          updatedAt: now,
        },
      });

    // A root that got MOVED INSIDE this tree stops being a map of its own —
    // without this its recall_maps row survives as a ghost catalog entry.
    await tx.delete(recallMaps).where(
      and(
        eq(recallMaps.ownerId, ownerId),
        inArray(
          recallMaps.id,
          members.filter((m) => m.id !== rootId).map((m) => m.id),
        ),
      ),
    );

    // Delete-then-batch-insert: clearing the map's rows first means an
    // intra-map slug handoff (two pages swapping titles) can never trip the
    // (map_id, slug) unique index mid-write. The ON CONFLICT (id) handles a
    // page that moved IN from another map — its old row re-points here.
    await tx.delete(recallNodes).where(eq(recallNodes.mapId, rootId));
    if (values.length > 0) {
      await tx
        .insert(recallNodes)
        .values(values)
        .onConflictDoUpdate({
          target: recallNodes.id,
          set: {
            ownerId: sql`excluded.owner_id`,
            mapId: sql`excluded.map_id`,
            slug: sql`excluded.slug`,
            kind: sql`excluded.kind`,
            title: sql`excluded.title`,
            bodyMd: sql`excluded.body_md`,
            bodyChars: sql`excluded.body_chars`,
            useWhen: sql`excluded.use_when`,
            options: sql`excluded.options`,
            embedding: sql`excluded.embedding`,
            sourceVersion: sql`excluded.source_version`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    }
  });

  // A brand-new map pulls its members out of general content indexing (the
  // extractor serves them metadata-only once the root is tagged) — re-ingest
  // each once so already-indexed chunks are dropped. One-time, map-sized.
  if (isNewMap) {
    for (const m of members) {
      void notifyNodeIngested(m.id);
    }
  }

  return { ok: true, mapId: rootId, issues, nodeCount: compiled.length };
}

/** Drop everything compiled from `pageId` — its node row, and its map (with
 *  all rows) when it was a root. For untag, delete, and non-member cleanup. */
export async function removeRecallForPage(ownerId: string, pageId: string): Promise<void> {
  await db
    .delete(recallNodes)
    .where(and(eq(recallNodes.mapId, pageId), eq(recallNodes.ownerId, ownerId)));
  await db
    .delete(recallNodes)
    .where(and(eq(recallNodes.id, pageId), eq(recallNodes.ownerId, ownerId)));
  await db
    .delete(recallMaps)
    .where(and(eq(recallMaps.id, pageId), eq(recallMaps.ownerId, ownerId)));
}

/** Indexed probes: was anything ever compiled from these ids? Keeps the
 *  non-recall fast path (every ordinary page write) at one or two cheap
 *  queries instead of a fistful of no-op DELETEs. */
async function hasCompiledRows(ownerId: string, ids: string[]): Promise<boolean> {
  if (ids.length === 0) return false;
  const [nodeHit] = await db
    .select({ id: recallNodes.id })
    .from(recallNodes)
    .where(
      and(
        eq(recallNodes.ownerId, ownerId),
        sql`(${inArray(recallNodes.id, ids)} or ${inArray(recallNodes.mapId, ids)})`,
      ),
    )
    .limit(1);
  if (nodeHit) return true;
  const [mapHit] = await db
    .select({ id: recallMaps.id })
    .from(recallMaps)
    .where(and(eq(recallMaps.ownerId, ownerId), inArray(recallMaps.id, ids)))
    .limit(1);
  return !!mapHit;
}

/** Embed prompt rows whose vector is missing. Fire-and-forget from the write
 *  hooks; also safe to call from a sweep (none exists yet — S3 wires one).
 *  The embedder is injected at boot (see embed-bridge.ts), so this package
 *  never reaches up into the adapter layer. Throws when the process forgot to
 *  register one — deliberately loud, because the caller is fire-and-forget and
 *  a silent zero here is invisible until recall_match stops finding prompts. */
export async function embedPendingRecallPrompts(ownerId: string): Promise<number> {
  const pending = await db
    .select({
      id: recallNodes.id,
      title: recallNodes.title,
      useWhen: recallNodes.useWhen,
      bodyMd: recallNodes.bodyMd,
    })
    .from(recallNodes)
    .where(
      and(
        eq(recallNodes.ownerId, ownerId),
        eq(recallNodes.kind, 'prompt'),
        isNull(recallNodes.embedding),
      ),
    )
    .limit(50);
  if (pending.length === 0) return 0;

  const embedBatch = getRecallEmbedder();
  const texts = pending.map((p) => `${p.title}\n${p.useWhen}\n${p.bodyMd}`.slice(0, 6000));
  const vectors = await embedBatch(ownerId, texts);
  let done = 0;
  for (let i = 0; i < pending.length; i++) {
    const vec = vectors[i];
    if (!vec) continue;
    await db
      .update(recallNodes)
      .set({ embedding: vec })
      .where(and(eq(recallNodes.id, pending[i]!.id), isNull(recallNodes.embedding)));
    done++;
  }
  return done;
}

/**
 * The write hook: called after a page create / commit / title / tag change.
 * Finds the tree root; compiles when the root carries `recall`, cleans up
 * when it does not. Never throws — Recall must not take a page write down.
 */
export async function recallAfterPageWrite(ownerId: string, pageId: string): Promise<void> {
  try {
    const root = await findPageRoot(ownerId, pageId);
    if (!root || !root.tags.includes(RECALL_TAG)) {
      // Not (or no longer) a map member. The common case — an ordinary page
      // write — exits after one existence probe; cleanup runs only when
      // something was actually compiled from this page or its root before.
      const ids = root && root.id !== pageId ? [pageId, root.id] : [pageId];
      if (await hasCompiledRows(ownerId, ids)) {
        await removeRecallForPage(ownerId, pageId);
        if (root && root.id !== pageId) await removeRecallForPage(ownerId, root.id);
      }
      return;
    }
    await compileRecallMap(ownerId, root.id);
    void embedPendingRecallPrompts(ownerId).catch((err) => {
      console.error('[recall] prompt embed failed (non-fatal):', err);
    });
  } catch (err) {
    console.error('[recall] compile after page write failed (non-fatal):', err);
  }
}

/** The delete hook: the compiled copy of a deleted page must not keep
 *  serving. Pass the pre-delete root so the surviving map can recompile. */
export async function recallAfterPageDelete(
  ownerId: string,
  pageId: string,
  rootId: string | null,
): Promise<void> {
  try {
    await removeRecallForPage(ownerId, pageId);
    if (rootId && rootId !== pageId) await recallAfterPageWrite(ownerId, rootId);
  } catch (err) {
    console.error('[recall] cleanup after page delete failed (non-fatal):', err);
  }
}

/** The move hook: a page can leave one map and join another in one gesture —
 *  recompile the tree it LEFT, then treat the new location as a write. */
export async function recallAfterPageMove(
  ownerId: string,
  pageId: string,
  oldRootId: string | null,
): Promise<void> {
  try {
    if (oldRootId && oldRootId !== pageId) await recallAfterPageWrite(ownerId, oldRootId);
    await recallAfterPageWrite(ownerId, pageId);
  } catch (err) {
    console.error('[recall] compile after page move failed (non-fatal):', err);
  }
}

/** Read helper for surfaces/tests: the map row plus its compiled nodes. */
export async function getRecallMap(ownerId: string, rootId: string) {
  const [map] = await db
    .select()
    .from(recallMaps)
    .where(and(eq(recallMaps.id, rootId), eq(recallMaps.ownerId, ownerId)))
    .limit(1);
  if (!map) return null;
  const nodesRows = await db
    .select()
    .from(recallNodes)
    .where(and(eq(recallNodes.mapId, rootId), eq(recallNodes.ownerId, ownerId)));
  return { map, nodes: nodesRows };
}

/** Is this page inside a Recall map's tree? Used by the extractor to serve
 *  such pages metadata-only — their content's serving surface is the compiled
 *  rows, and full indexing would leak prompt text into general search. */
export async function isRecallTreePage(ownerId: string, pageId: string): Promise<boolean> {
  const root = await findPageRoot(ownerId, pageId);
  return !!root && root.tags.includes(RECALL_TAG);
}
