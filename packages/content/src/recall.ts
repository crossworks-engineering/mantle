/**
 * Recall — the DB half of the compiler (S1). The pure parse/lint core lives
 * in `@mantle/content-core/recall-compile`; this module walks the page tree,
 * aggregates the map-level lint, and owns the serving rows.
 *
 * Contract (design page "Recall — architecture plan v1", task 97cf7850):
 *  - a map is a page tree whose ROOT carries the `recall` tag; a page tagged
 *    `prompt` compiles as a prompt (embedded for recall_match);
 *  - ANY member commit recompiles the WHOLE map — options cross-reference
 *    siblings, so single-page compiles cannot validate; maps are small by
 *    budget, so this is milliseconds;
 *  - lint ERRORS block the COMPILE, never the commit: the pages publish, the
 *    map keeps serving its last good rev, and the report lands on the map row;
 *  - prompt embeddings are the one async step — rows land with a NULL vector
 *    (unmatchable but servable) and `embedPendingRecallPrompts` fills them in
 *    fire-and-forget after the write.
 *
 * Every entry point here is no-throw: a Recall failure must never take a
 * page write down with it.
 */

import { and, eq, isNull, notInArray, sql } from 'drizzle-orm';

import { db, recallMaps, recallNodes } from '@mantle/db';
import {
  RECALL_PROMPT_TAG,
  RECALL_TAG,
  assignRecallSlugs,
  parseRecallDoc,
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
 *  creation order — the order slugs are assigned in, so slugs stay stable. */
async function listMapMembers(ownerId: string, rootId: string): Promise<MemberRow[]> {
  const result = await db.execute(sql`
    with recursive down as (
      select id from nodes where id = ${rootId} and owner_id = ${ownerId} and type = 'page'
      union
      select n.id from nodes n join down d on n.parent_id = d.id
       where n.owner_id = ${ownerId} and n.type = 'page'
    )
    select n.id, n.title, n.tags, p.doc, p.version, n.created_at
      from down
      join nodes n on n.id = down.id
      join pages p on p.node_id = down.id
     order by (down.id = ${rootId}) desc, n.created_at asc
  `);
  return rowsOf<MemberRow>(result);
}

export type RecallCompileResult = {
  ok: boolean;
  mapId: string;
  issues: RecallLintIssue[];
  nodeCount: number;
};

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
  const mapSlug = slugs.get(rootId)!;

  if (errors.length > 0) {
    // Record the outcome; leave the served nodes exactly as they were.
    await db
      .insert(recallMaps)
      .values({
        id: rootId,
        ownerId,
        slug: mapSlug,
        title: root.title,
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
    return { ok: false, mapId: rootId, issues, nodeCount: 0 };
  }

  // Clean compile — carry forward embeddings whose inputs did not change.
  const existing = rowsOf<{
    id: string;
    title: string;
    body_md: string;
    use_when: string;
    embedding: unknown;
  }>(
    await db.execute(sql`
      select id, title, body_md, use_when, (embedding is not null) as embedding
        from recall_nodes where map_id = ${rootId} and owner_id = ${ownerId}
    `),
  );
  const unchanged = new Set(
    existing
      .filter((e) => e.embedding === true)
      .filter((e) => {
        const c = compiled.find((x) => x.member.id === e.id);
        return (
          c &&
          c.kind === 'prompt' &&
          c.parsed.bodyMarkdown === e.body_md &&
          (c.parsed.useWhen ?? '') === e.use_when &&
          c.member.title === e.title
        );
      })
      .map((e) => e.id),
  );

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
        updatedAt: new Date(),
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
          updatedAt: new Date(),
        },
      });

    const keep = compiled.map((c) => c.member.id);
    await tx
      .delete(recallNodes)
      .where(and(eq(recallNodes.mapId, rootId), notInArray(recallNodes.id, keep)));

    for (const c of compiled) {
      const row = {
        ownerId,
        mapId: rootId,
        slug: slugs.get(c.member.id)!,
        kind: c.kind,
        title: c.member.title,
        bodyMd: c.parsed.bodyMarkdown,
        bodyChars: c.parsed.bodyMarkdown.length,
        useWhen: c.parsed.useWhen ?? '',
        options: c.options,
        sourceVersion: c.member.version,
        updatedAt: new Date(),
        // A changed prompt drops its vector; the pending-embed pass refills.
        ...(c.kind !== 'prompt' || !unchanged.has(c.member.id) ? { embedding: null } : {}),
      };
      await tx
        .insert(recallNodes)
        .values({ id: c.member.id, ...row, embedding: null })
        .onConflictDoUpdate({ target: recallNodes.id, set: row });
    }
  });

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

/** Embed prompt rows whose vector is missing. Fire-and-forget from the write
 *  hooks; also safe to call from a sweep. Dynamic import so the adapter
 *  registry stays out of module load (extractor convention). */
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

  const { embedBatch } = await import('@mantle/embeddings');
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
 * The write hook: called after a page commit / title / tag change. Finds the
 * tree root; compiles when the root carries `recall`, cleans up when it does
 * not. Never throws — Recall must not take a page write down.
 */
export async function recallAfterPageWrite(ownerId: string, pageId: string): Promise<void> {
  try {
    const root = await findPageRoot(ownerId, pageId);
    if (!root) {
      await removeRecallForPage(ownerId, pageId);
      return;
    }
    if (!root.tags.includes(RECALL_TAG)) {
      // Not (or no longer) a map — clear anything previously compiled from
      // this page or (if it was a root) its map.
      await removeRecallForPage(ownerId, pageId);
      if (root.id !== pageId) await removeRecallForPage(ownerId, root.id);
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
