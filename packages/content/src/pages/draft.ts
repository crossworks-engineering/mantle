/**
 * Pages · the draft/commit spine — every path that changes what a page SAYS.
 *
 * Two writes, two very different costs. `saveDraft` is cheap and frequent: it
 * touches `draft_doc` only, so nothing is rendered elsewhere and nothing is
 * indexed. `commitPage` is the expensive one and the ONLY path that indexes a
 * page body, so a long editing session produces one index per commit instead
 * of one per pause. `updatePage` is the programmatic third way in.
 *
 * All of them serialize on the page's sidecar row through `withPageLock` and
 * bump `draft_rev`, which is what stops a second device (or the Pages agent
 * writing while the user types) from silently winning a lost update.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, nodes, notifyNodeIngested, pages } from '@mantle/db';
import { ensureBlockIds, repairTableRows } from '@mantle/content-core/block-ids';
import type { PageVisibility, PageWidth } from '@mantle/client-types';
import { docToText } from '../doc-to-text';
import { recallAfterPageWrite } from '../recall';
import { EMPTY_DOC, dedupeTags, detailOf, type PageDetail } from './shared';
import { embeddedAssetText } from './embed';

// ── Draft concurrency control (audit item #3) ────────────────────────────────
// Page drafts mirror the Tables registry-lock spine (see table-storage.ts):
// every draft write, commit, and discard bumps `pages.draft_rev` and serializes
// on the pages row via SELECT … FOR UPDATE, so two autosave streams (a second
// device, or a user editing while the Pages agent applies block ops) can't
// interleave into a silent last-write-wins lost update.
type PageTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The pages-row fields the draft lock exposes to its critical section — null
 *  when no pages sidecar exists for the id (page deleted / never created). */
export type LockedPageRow = {
  draftRev: number;
  draftDoc: Record<string, unknown> | null;
} | null;

/**
 * Run `fn` while holding SELECT … FOR UPDATE on the page's sidecar row.
 * Serializes cross-process draft writers (desktop autosave vs phone vs the
 * Pages agent's block ops); the lock releases when the transaction commits or
 * rolls back. The locked row's `draftRev`/`draftDoc` are passed to `fn` (null
 * when the row is gone). Mirrors `withTableRegistryLock`.
 */
export async function withPageLock<T>(
  nodeId: string,
  fn: (tx: PageTx, locked: LockedPageRow) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const result = await tx.execute<{
      draft_rev: number;
      draft_doc: Record<string, unknown> | null;
    }>(sql`SELECT draft_rev, draft_doc FROM pages WHERE node_id = ${nodeId} FOR UPDATE`);
    const rows = (
      Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    ) as { draft_rev: number; draft_doc: Record<string, unknown> | null }[];
    const locked: LockedPageRow = rows[0]
      ? { draftRev: Number(rows[0].draft_rev), draftDoc: rows[0].draft_doc }
      : null;
    return fn(tx, locked);
  });
}

/**
 * The etag decision, extracted pure so it's unit-testable without a DB: given
 * the row's current rev and the caller's optional `baseRev`, either report a
 * conflict (stale base) or clear the write and hand back the next rev. Callers
 * apply this INSIDE the lock, before writing — so a conflict never mutates the
 * draft. `baseRev` absent (internal callers) always proceeds, serialized by the
 * lock and rev-bumped so writes are never silently interleaved.
 */
export function evaluateDraftRev(
  currentRev: number,
  baseRev: number | undefined,
): { conflict: false; nextRev: number } | { conflict: true; rev: number } {
  if (baseRev !== undefined && baseRev !== currentRev) {
    return { conflict: true, rev: currentRev };
  }
  return { conflict: false, nextRev: currentRev + 1 };
}

export type UpdatePageInput = Partial<{
  title: string;
  doc: Record<string, unknown>;
  tags: string[];
  icon: string;
  visibility: PageVisibility;
  width: PageWidth;
}>;

export async function updatePage(
  ownerId: string,
  id: string,
  input: UpdatePageInput,
  opts: { reindex?: boolean } = {},
): Promise<PageDetail | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'page')))
    .limit(1);
  if (!node) return null;

  const docChanged = input.doc !== undefined;
  // Re-indexing (LLM summary + embedding + fact extraction) is the expensive
  // part, so it's opt-out via `reindex`. The editor never sends a doc through
  // here — it uses the draft/commit path (saveDraft / commitPage); this
  // option exists for programmatic callers that write a doc and want (or want
  // to skip) indexing. Defaults to true.
  const willReindex = docChanged && opts.reindex !== false;
  const oldData = (node.data ?? {}) as Record<string, unknown>;
  const newData: Record<string, unknown> = { ...oldData };
  if (input.icon !== undefined) newData.icon = input.icon;
  if (input.visibility !== undefined) newData.visibility = input.visibility;
  if (input.width !== undefined) newData.width = input.width;
  // A re-index invalidates the extractor's prior summary/embedding.
  if (willReindex) {
    delete newData.summary;
    delete newData.summary_model;
    delete newData.summary_at;
    delete newData.entities;
  }

  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(nodes)
      .set({
        ...(input.title !== undefined
          ? { title: input.title.trim().slice(0, 200) || 'Untitled page' }
          : {}),
        ...(input.tags !== undefined ? { tags: dedupeTags(input.tags) } : {}),
        data: newData,
        ...(willReindex ? { embedding: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(nodes.id, id))
      .returning();
    if (!row) throw new Error('updatePage: update returned no row');

    if (docChanged) {
      const doc = input.doc as Record<string, unknown>;
      await tx
        .update(pages)
        .set({
          doc,
          docText: docToText(doc),
          version: sql`${pages.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(pages.nodeId, id));
      return detailOf(row, doc);
    }
    const [p] = await tx
      .select({ doc: pages.doc })
      .from(pages)
      .where(eq(pages.nodeId, id))
      .limit(1);
    return detailOf(row, (p?.doc as Record<string, unknown> | null) ?? EMPTY_DOC);
  });

  if (willReindex) {
    await notifyNodeIngested(id);
  }
  // Recall: tags decide map membership, titles decide slugs, and a
  // programmatic doc write changes the body — any of the three recompiles.
  if (input.tags !== undefined || input.title !== undefined || docChanged) {
    await recallAfterPageWrite(ownerId, id);
  }
  return result;
}

/** Result of a draft/commit write under the `draft_rev` etag. `ok` carries the
 *  NEW rev the client adopts; `conflict` carries the CURRENT server rev so the
 *  client can resync; `missing` means the page is gone. */
export type SaveDraftResult =
  | { ok: true; rev: number }
  | { ok: false; conflict: true; rev: number }
  | { ok: false; missing: true };

/**
 * Autosave the working draft. Persists to `pages.draft_doc` ONLY — the
 * published `doc`/`doc_text`, the summary, the embedding, and the extractor are
 * all left untouched. Cheap and frequent; nothing is rendered to other
 * surfaces or indexed from a draft.
 *
 * Concurrency (audit item #3): the write runs under `withPageLock` and bumps
 * `draft_rev`. When `opts.baseRev` is supplied (the editor's autosave etag) a
 * stale value returns a typed conflict WITHOUT touching the draft, so a second
 * device or the Pages agent can't silently overwrite newer edits. Internal
 * callers omit `baseRev` — they still serialize on the lock and bump the rev,
 * so concurrent programmatic writes are never interleaved (last-write-wins).
 */
export async function saveDraft(
  ownerId: string,
  id: string,
  doc: Record<string, unknown>,
  opts: { baseRev?: number } = {},
): Promise<SaveDraftResult> {
  const [node] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'page')))
    .limit(1);
  if (!node) return { ok: false, missing: true };
  // Guarantee every persisted draft carries stable block ids — the autosave
  // endpoint accepts whatever the editor sends, and an editor that doesn't
  // yet preserve the id global attr (or a programmatic write) would
  // otherwise strip them. Idempotent + cheap.
  const enriched = ensureBlockIds(repairTableRows(doc));
  return withPageLock(id, async (tx, locked) => {
    if (!locked) return { ok: false as const, missing: true as const };
    const decision = evaluateDraftRev(locked.draftRev, opts.baseRev);
    if (decision.conflict) {
      return { ok: false as const, conflict: true as const, rev: decision.rev };
    }
    await tx
      .update(pages)
      .set({ draftDoc: enriched, draftUpdatedAt: new Date(), draftRev: sql`${pages.draftRev} + 1` })
      .where(eq(pages.nodeId, id));
    return { ok: true as const, rev: decision.nextRev };
  });
}

/**
 * Throw away the working draft (set draft_doc=null). The published `doc`
 * is untouched; brain index untouched. Used by the AI-assist panel's
 * "Discard" button after the Pages agent writes changes the user
 * decides not to keep. Returns false if the page doesn't exist.
 *
 * Bumps `draft_rev` under the lock: discarding invalidates the base any
 * in-flight writer holds, so their next conditional save conflicts (and
 * refetches) instead of resurrecting the thrown-away draft.
 */
export async function discardDraft(ownerId: string, id: string): Promise<boolean> {
  const [node] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'page')))
    .limit(1);
  if (!node) return false;
  await withPageLock(id, async (tx, locked) => {
    if (!locked) return;
    await tx
      .update(pages)
      .set({ draftDoc: null, draftUpdatedAt: null, draftRev: sql`${pages.draftRev} + 1` })
      .where(eq(pages.nodeId, id));
  });
  return true;
}

/** Result of a commit under the `draft_rev` etag: the published detail (with
 *  the bumped rev), a typed conflict (stale base — nothing published), or a
 *  missing page. */
export type CommitPageResult =
  | { ok: true; page: PageDetail }
  | { ok: false; conflict: true; rev: number }
  | { ok: false; missing: true };

/**
 * Commit: publish `doc` as canonical, recompute `doc_text`, clear the draft,
 * bump the version, and fire the extractor. This is the ONLY path that indexes
 * a page body — autosaves never do, so a long editing session produces exactly
 * one index per commit instead of one per pause.
 */
export async function commitPage(
  ownerId: string,
  id: string,
  doc: Record<string, unknown>,
  opts: { baseRev?: number } = {},
): Promise<CommitPageResult> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'page')))
    .limit(1);
  if (!node) return { ok: false, missing: true };

  // Guarantee the committed doc carries stable per-block ids so the
  // brain (via doc_text), Phase 2b block tools, and the editor diff
  // view all see addressable blocks. Idempotent.
  const enriched = ensureBlockIds(repairTableRows(doc));
  const newData = { ...((node.data ?? {}) as Record<string, unknown>) };
  delete newData.summary;
  delete newData.summary_model;
  delete newData.summary_at;
  delete newData.entities;
  // Fold the text *inside* embedded images (vision/OCR) + doc chips into the
  // indexed plaintext, so the page is searchable by — and its summary reflects —
  // its own assets, not just their filenames.
  const baseText = docToText(enriched);
  const assetText = await embeddedAssetText(ownerId, enriched);
  const docText = assetText ? `${baseText}\n\n${assetText}` : baseText;

  // Same etag guard as saveDraft, under the same lock: a stale `baseRev`
  // returns a conflict WITHOUT publishing, so a client committing a doc it
  // built on an out-of-date draft can't blow away a newer draft. The
  // successful commit clears the draft and bumps `draft_rev` in the same tx.
  const result = await withPageLock(id, async (tx, locked) => {
    if (!locked) return { ok: false as const, missing: true as const };
    const decision = evaluateDraftRev(locked.draftRev, opts.baseRev);
    if (decision.conflict) {
      return { ok: false as const, conflict: true as const, rev: decision.rev };
    }
    const [row] = await tx
      .update(nodes)
      .set({ data: newData, embedding: null, updatedAt: new Date() })
      .where(eq(nodes.id, id))
      .returning();
    if (!row) throw new Error('commitPage: update returned no row');
    await tx
      .update(pages)
      .set({
        doc: enriched,
        docText,
        draftDoc: null,
        draftUpdatedAt: null,
        version: sql`${pages.version} + 1`,
        draftRev: sql`${pages.draftRev} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(pages.nodeId, id));
    return {
      ok: true as const,
      page: detailOf(row, enriched, null, { draftRev: decision.nextRev }),
    };
  });

  if (result.ok) {
    await notifyNodeIngested(id);
    // Recall: a commit is the compile moment for a map's serving rows. The
    // hook is no-throw and skips instantly for pages outside a `recall` tree.
    await recallAfterPageWrite(ownerId, id);
  }
  return result;
}

/** `commitPage` takes the doc to publish because its caller is the EDITOR,
 *  which holds it. An agent doesn't: every agent body-write (page_update_draft,
 *  the block tools, page_mention) lands in `draft_doc`, so what it needs is
 *  "publish whatever is in the draft". Mirrors `commitTable(ownerId, id)`.
 *
 *  Reading `draft_rev` alongside the draft and passing it as `baseRev` is the
 *  point, not a formality: an editor autosave landing between the read and the
 *  commit surfaces as a typed conflict instead of silently publishing a doc
 *  that is already stale. */
export type CommitPageDraftResult = CommitPageResult | { ok: false; noDraft: true };

export async function commitPageDraft(ownerId: string, id: string): Promise<CommitPageDraftResult> {
  const [row] = await db
    .select({ draftDoc: pages.draftDoc, draftRev: pages.draftRev })
    .from(pages)
    .innerJoin(nodes, eq(nodes.id, pages.nodeId))
    .where(and(eq(pages.nodeId, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'page')))
    .limit(1);
  if (!row) return { ok: false, missing: true };
  if (!row.draftDoc) return { ok: false, noDraft: true };
  return commitPage(ownerId, id, row.draftDoc as Record<string, unknown>, {
    baseRev: row.draftRev,
  });
}
