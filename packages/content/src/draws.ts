/**
 * Draws surface. A draw is a `nodes` row with type='draw' plus a `draws`
 * sidecar row holding the Excalidraw scene:
 *
 *   nodes.title           display name
 *   nodes.data.summary    extractor-written summary
 *   nodes.data.visibility 'private' | 'public' (read-only sharing, phase 4)
 *   draws.scene           { elements, appState? } (source of truth)
 *   draws.scene_text      derived plaintext (the extractor + FTS read this)
 *   draws.scene_svg       commit-time SVG snapshot (list preview, /s, export)
 *
 * All under the `draw` ltree root, lazy-created on first write. Mirrors
 * pages.ts throughout — the draft/commit model, the draft_rev etag and the
 * row lock are the same machinery; only the document type differs. `draw`
 * joins the extractor's DEFAULT_EXTRACT_TYPES in Phase 3, at which point
 * summary + embedding land automatically on the next
 * pg_notify('node_ingested'); `readNodeBodyRaw` reads `scene_text` from the
 * sidecar.
 */
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { db, nodes, draws, notifyNodeIngested, type Node } from '@mantle/db';
import { sceneToText } from './scene-to-text';
import { acceptSceneSvg } from './scene-svg';
// The etag decision and the embedded-asset text bounds are shared with
// pages — identical semantics, one truth.
import { evaluateDraftRev, foldEmbeddedText } from './pages';

export const DRAWS_ROOT_LABEL = 'draw';

/** An empty Excalidraw scene. */
export const EMPTY_SCENE: Record<string, unknown> = { elements: [] };

export type DrawVisibility = 'private' | 'public';

/** The durable subset of Excalidraw's appState we persist. Everything else
 *  (selection, collaborators, open menus, editing session state) is
 *  ephemeral and must never land in the DB — whitelist, don't blacklist. */
const APP_STATE_KEYS = [
  'viewBackgroundColor',
  'gridSize',
  'gridModeEnabled',
  'scrollX',
  'scrollY',
  'zoom',
] as const;

/** Normalize a client-supplied scene into what we store: `elements` as an
 *  array, `appState` trimmed to the durable whitelist. Never throws. */
export function normalizeScene(scene: unknown): Record<string, unknown> {
  if (!scene || typeof scene !== 'object') return EMPTY_SCENE;
  const s = scene as Record<string, unknown>;
  const elements = Array.isArray(s.elements) ? s.elements : [];
  const out: Record<string, unknown> = { elements };
  if (s.appState && typeof s.appState === 'object') {
    const src = s.appState as Record<string, unknown>;
    const appState: Record<string, unknown> = {};
    for (const key of APP_STATE_KEYS) {
      if (src[key] !== undefined) appState[key] = src[key];
    }
    if (Object.keys(appState).length > 0) out.appState = appState;
  }
  return out;
}

export type DrawRow = {
  id: string;
  title: string;
  tags: string[];
  summary: string | null;
  visibility: DrawVisibility;
  /** Whether a committed SVG snapshot exists (the list fetches it lazily). */
  hasSvg: boolean;
  createdAt: string;
  updatedAt: string;
};

export type DrawDetail = DrawRow & {
  /** Committed scene — what's rendered everywhere and what the extractor
   *  indexes. Only changes on commit. */
  scene: Record<string, unknown>;
  /** Autosaved working copy if uncommitted edits exist, else null. */
  draft: Record<string, unknown> | null;
  draftUpdatedAt?: string | null;
  /** Draft etag the editor round-trips on every autosave/commit. */
  draftRev?: number;
  /** BinaryFile id → file node id map (scene images live in the files
   *  pipeline; the editor rehydrates BinaryFiles from these). */
  fileRefs: Record<string, string>;
};

function rowOf(n: Node, hasSvg = false): DrawRow {
  const d = (n.data ?? {}) as Record<string, unknown>;
  return {
    id: n.id,
    title: n.title,
    tags: n.tags ?? [],
    summary: typeof d.summary === 'string' ? d.summary : null,
    visibility: d.visibility === 'public' ? 'public' : 'private',
    hasSvg,
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
  };
}

function detailOf(
  n: Node,
  scene: Record<string, unknown>,
  draft: Record<string, unknown> | null = null,
  extra: { draftRev?: number; fileRefs?: Record<string, string>; hasSvg?: boolean } = {},
): DrawDetail {
  return {
    ...rowOf(n, extra.hasSvg ?? false),
    scene,
    draft,
    fileRefs: extra.fileRefs ?? {},
    ...(extra.draftRev !== undefined ? { draftRev: extra.draftRev } : {}),
  };
}

// ── Draft concurrency control ────────────────────────────────────────────────
// Same spine as pages/tables: every draft write, commit, and discard bumps
// `draws.draft_rev` and serializes on the sidecar row via SELECT … FOR UPDATE.

type DrawTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type LockedDrawRow = {
  draftRev: number;
  draftScene: Record<string, unknown> | null;
} | null;

export async function withDrawLock<T>(
  nodeId: string,
  fn: (tx: DrawTx, locked: LockedDrawRow) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const result = await tx.execute<{
      draft_rev: number;
      draft_scene: Record<string, unknown> | null;
    }>(sql`SELECT draft_rev, draft_scene FROM draws WHERE node_id = ${nodeId} FOR UPDATE`);
    const rows = (
      Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    ) as { draft_rev: number; draft_scene: Record<string, unknown> | null }[];
    const locked: LockedDrawRow = rows[0]
      ? { draftRev: Number(rows[0].draft_rev), draftScene: rows[0].draft_scene }
      : null;
    return fn(tx, locked);
  });
}

async function ensureRoot(ownerId: string): Promise<void> {
  await db
    .insert(nodes)
    .values({
      ownerId,
      type: 'branch',
      title: 'Draw',
      slug: DRAWS_ROOT_LABEL,
      path: DRAWS_ROOT_LABEL,
      data: { description: 'Whiteboard scenes (Excalidraw). Indexed and embedded automatically.' },
    })
    .onConflictDoNothing({
      target: [nodes.ownerId, nodes.path],
      where: sql`${nodes.type} = 'branch'`,
    });
}

export type DrawSort = 'edited' | 'newest' | 'oldest' | 'title';

type ListDrawsOpts = { query?: string; tag?: string; sort?: DrawSort };

function drawOrderBy(sort?: DrawSort) {
  switch (sort) {
    case 'newest':
      return desc(nodes.createdAt);
    case 'oldest':
      return asc(nodes.createdAt);
    case 'title':
      return asc(nodes.title);
    case 'edited':
    default:
      return desc(nodes.updatedAt);
  }
}

function drawConds(ownerId: string, opts: ListDrawsOpts) {
  const conds = [eq(nodes.ownerId, ownerId), eq(nodes.type, 'draw')];
  if (opts.query?.trim()) {
    const q = `%${opts.query.trim()}%`;
    const c = or(
      ilike(nodes.title, q),
      sql`${draws.sceneText} ilike ${q}`,
      sql`${nodes.data}->>'summary' ilike ${q}`,
    );
    if (c) conds.push(c);
  }
  if (opts.tag) conds.push(sql`${opts.tag} = ANY(${nodes.tags})`);
  return conds;
}

export async function listDraws(
  ownerId: string,
  opts: ListDrawsOpts & { limit?: number; offset?: number } = {},
): Promise<DrawRow[]> {
  const rows = await db
    .select({ node: nodes, hasSvg: sql<boolean>`${draws.sceneSvg} IS NOT NULL` })
    .from(nodes)
    .leftJoin(draws, eq(draws.nodeId, nodes.id))
    .where(and(...drawConds(ownerId, opts)))
    .orderBy(drawOrderBy(opts.sort))
    .limit(opts.limit ?? 500)
    .offset(opts.offset ?? 0);
  return rows.map((r) => rowOf(r.node, r.hasSvg ?? false));
}

export async function countDraws(ownerId: string, opts: ListDrawsOpts = {}): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(nodes)
    .leftJoin(draws, eq(draws.nodeId, nodes.id))
    .where(and(...drawConds(ownerId, opts)));
  return row?.n ?? 0;
}

export async function listDrawTags(ownerId: string): Promise<{ tag: string; count: number }[]> {
  const rows = await db
    .select({ tags: nodes.tags })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'draw')));
  const counts = new Map<string, number>();
  for (const r of rows) {
    for (const t of r.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export async function getDraw(ownerId: string, id: string): Promise<DrawDetail | null> {
  const [row] = await db
    .select({
      node: nodes,
      scene: draws.scene,
      draft: draws.draftScene,
      draftUpdatedAt: draws.draftUpdatedAt,
      draftRev: draws.draftRev,
      fileRefs: draws.fileRefs,
      hasSvg: sql<boolean>`${draws.sceneSvg} IS NOT NULL`,
    })
    .from(nodes)
    .leftJoin(draws, eq(draws.nodeId, nodes.id))
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'draw')))
    .limit(1);
  if (!row) return null;

  const scene = (row.scene as Record<string, unknown> | null) ?? EMPTY_SCENE;
  const draft = (row.draft as Record<string, unknown> | null) ?? null;
  return {
    ...detailOf(row.node, scene, draft, {
      draftRev: row.draftRev ?? 0,
      fileRefs: (row.fileRefs as Record<string, string> | null) ?? {},
      hasSvg: row.hasSvg ?? false,
    }),
    draftUpdatedAt: draft ? (row.draftUpdatedAt?.toISOString() ?? null) : null,
  };
}

/** The committed derived plaintext (`scene_text`, including any folded
 *  embedded-image OCR) — what the extractor indexed and what an agent should
 *  read. Null when the draw doesn't exist. Deliberately NOT recomputed from
 *  the scene: the stored text is the one the brain saw. */
export async function getDrawSceneText(ownerId: string, id: string): Promise<string | null> {
  const [row] = await db
    .select({ sceneText: draws.sceneText })
    .from(draws)
    .innerJoin(nodes, eq(nodes.id, draws.nodeId))
    .where(and(eq(draws.nodeId, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'draw')))
    .limit(1);
  return row?.sceneText ?? null;
}

/** The committed SVG snapshot, for surfaces that render it (list preview,
 *  /s share, export). Null when no commit carried one. */
export async function getDrawSvg(ownerId: string, id: string): Promise<string | null> {
  const [row] = await db
    .select({ svg: draws.sceneSvg })
    .from(draws)
    .innerJoin(nodes, eq(nodes.id, draws.nodeId))
    .where(and(eq(draws.nodeId, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'draw')))
    .limit(1);
  return row?.svg ?? null;
}

export type CreateDrawInput = {
  title: string;
  scene?: Record<string, unknown>;
  tags?: string[];
};

export async function createDraw(ownerId: string, input: CreateDrawInput): Promise<DrawDetail> {
  await ensureRoot(ownerId);
  const scene = normalizeScene(input.scene ?? EMPTY_SCENE);
  const sceneText = sceneToText(scene);

  return db.transaction(async (tx) => {
    const [node] = await tx
      .insert(nodes)
      .values({
        ownerId,
        type: 'draw',
        title: input.title.trim().slice(0, 200) || 'Untitled drawing',
        path: DRAWS_ROOT_LABEL,
        data: { visibility: 'private' },
        tags: dedupeTags(input.tags ?? []),
      })
      .returning();
    if (!node) throw new Error('createDraw: insert returned no row');
    await tx.insert(draws).values({ nodeId: node.id, scene, sceneText });
    return detailOf(node, scene);
  });
}

export type UpdateDrawInput = {
  title?: string;
  tags?: string[];
  visibility?: DrawVisibility;
};

/** Metadata-only update (title/tags/visibility save live, like pages).
 *  Scene writes go through the draft/commit path exclusively. */
export async function updateDraw(
  ownerId: string,
  id: string,
  input: UpdateDrawInput,
): Promise<DrawDetail | null> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'draw')))
    .limit(1);
  if (!node) return null;

  const newData: Record<string, unknown> = { ...((node.data ?? {}) as Record<string, unknown>) };
  if (input.visibility !== undefined) newData.visibility = input.visibility;

  const [row] = await db
    .update(nodes)
    .set({
      ...(input.title !== undefined
        ? { title: input.title.trim().slice(0, 200) || 'Untitled drawing' }
        : {}),
      ...(input.tags !== undefined ? { tags: dedupeTags(input.tags) } : {}),
      data: newData,
      updatedAt: new Date(),
    })
    .where(eq(nodes.id, id))
    .returning();
  if (!row) return null;

  const [d] = await db
    .select({ scene: draws.scene })
    .from(draws)
    .where(eq(draws.nodeId, id))
    .limit(1);
  return detailOf(row, (d?.scene as Record<string, unknown> | null) ?? EMPTY_SCENE);
}

export type SaveDrawDraftResult =
  | { ok: true; rev: number }
  | { ok: false; conflict: true; rev: number }
  | { ok: false; missing: true };

/**
 * Autosave the working draft. Persists to `draws.draft_scene` ONLY — the
 * published scene, scene_text, svg, summary, embedding and the extractor are
 * all untouched. The canvas fires onChange continuously, so this is the hot
 * path; keep it cheap. Same etag semantics as pages.saveDraft.
 */
export async function saveDrawDraft(
  ownerId: string,
  id: string,
  scene: Record<string, unknown>,
  opts: { baseRev?: number; fileRefs?: Record<string, string> } = {},
): Promise<SaveDrawDraftResult> {
  const [node] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'draw')))
    .limit(1);
  if (!node) return { ok: false, missing: true };
  const normalized = normalizeScene(scene);
  return withDrawLock(id, async (tx, locked) => {
    if (!locked) return { ok: false as const, missing: true as const };
    const decision = evaluateDraftRev(locked.draftRev, opts.baseRev);
    if (decision.conflict) {
      return { ok: false as const, conflict: true as const, rev: decision.rev };
    }
    await tx
      .update(draws)
      .set({
        draftScene: normalized,
        draftUpdatedAt: new Date(),
        draftRev: sql`${draws.draftRev} + 1`,
        // The BinaryFile-id → file-node-id map rides along whenever the editor
        // uploaded new scene images. Replace-whole-map: the editor owns it.
        ...(opts.fileRefs !== undefined ? { fileRefs: opts.fileRefs } : {}),
      })
      .where(eq(draws.nodeId, id));
    return { ok: true as const, rev: decision.nextRev };
  });
}

/** Throw away the working draft. Published scene untouched; brain untouched.
 *  Bumps draft_rev so any in-flight autosave conflicts instead of
 *  resurrecting the discarded draft. */
export async function discardDrawDraft(ownerId: string, id: string): Promise<boolean> {
  const [node] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'draw')))
    .limit(1);
  if (!node) return false;
  await withDrawLock(id, async (tx, locked) => {
    if (!locked) return;
    await tx
      .update(draws)
      .set({ draftScene: null, draftUpdatedAt: null, draftRev: sql`${draws.draftRev} + 1` })
      .where(eq(draws.nodeId, id));
  });
  return true;
}

/**
 * Plaintext of the images a draw embeds — each referenced `file` node's
 * durable `data.text` (vision describe + OCR, written once by the file
 * extractor) folded into the scene's indexed text, so a drawing is
 * searchable by what's INSIDE its pasted screenshots, not just its shape
 * labels. A file whose own extraction hasn't landed yet is skipped and
 * picked up on the next commit — no reactive re-extract (cost stays
 * bounded, per the no-runaway rule). Mirror of pages' embeddedAssetText.
 */
async function embeddedAssetText(ownerId: string, fileRefs: Record<string, string>): Promise<string> {
  const ids = [...new Set(Object.values(fileRefs))];
  if (ids.length === 0) return '';
  const rows = await db
    .select({ id: nodes.id, title: nodes.title, data: nodes.data })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), inArray(nodes.id, ids), eq(nodes.type, 'file')));
  const items = rows.map((r) => ({
    title: r.title,
    text: (r.data as Record<string, unknown> | null)?.text as string | undefined,
  }));
  return foldEmbeddedText(items);
}

export type CommitDrawResult =
  | { ok: true; draw: DrawDetail }
  | { ok: false; conflict: true; rev: number }
  | { ok: false; missing: true };

/**
 * Commit: publish the scene as canonical, recompute `scene_text`, store the
 * (validated) SVG snapshot, clear the draft, bump the version, and fire the
 * extractor. The ONLY path that indexes a draw body — a whiteboard session
 * produces exactly one index per commit, not one per mouse move.
 *
 * `svg` is the client's exportToSvg output; it is validated (acceptSceneSvg)
 * and dropped to null on any doubt — the commit itself never fails on it.
 */
export async function commitDraw(
  ownerId: string,
  id: string,
  scene: Record<string, unknown>,
  opts: { baseRev?: number; svg?: string; fileRefs?: Record<string, string> } = {},
): Promise<CommitDrawResult> {
  const [node] = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'draw')))
    .limit(1);
  if (!node) return { ok: false, missing: true };

  const normalized = normalizeScene(scene);
  // Fold the text inside embedded images (vision/OCR) into the indexed
  // plaintext, so the drawing is searchable by — and its summary reflects —
  // what its screenshots say, not just its own labels.
  const refsForText =
    opts.fileRefs ??
    ((
      await db
        .select({ fileRefs: draws.fileRefs })
        .from(draws)
        .where(eq(draws.nodeId, id))
        .limit(1)
    )[0]?.fileRefs as Record<string, string> | undefined) ??
    {};
  const baseText = sceneToText(normalized);
  const assetText = await embeddedAssetText(ownerId, refsForText);
  const sceneText = assetText ? `${baseText}\n\n${assetText}` : baseText;
  const sceneSvg = acceptSceneSvg(opts.svg);
  const newData = { ...((node.data ?? {}) as Record<string, unknown>) };
  delete newData.summary;
  delete newData.summary_model;
  delete newData.summary_at;
  delete newData.entities;

  const result = await withDrawLock(id, async (tx, locked) => {
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
    if (!row) throw new Error('commitDraw: update returned no row');
    await tx
      .update(draws)
      .set({
        scene: normalized,
        sceneText,
        // A commit without a (valid) snapshot clears the old one — a stale
        // preview of a superseded scene is worse than no preview.
        sceneSvg,
        draftScene: null,
        draftUpdatedAt: null,
        version: sql`${draws.version} + 1`,
        draftRev: sql`${draws.draftRev} + 1`,
        updatedAt: new Date(),
        ...(opts.fileRefs !== undefined ? { fileRefs: opts.fileRefs } : {}),
      })
      .where(eq(draws.nodeId, id));
    return {
      ok: true as const,
      draw: detailOf(row, normalized, null, {
        draftRev: decision.nextRev,
        hasSvg: sceneSvg !== null,
      }),
    };
  });

  if (result.ok) await notifyNodeIngested(id);
  return result;
}

export async function deleteDraw(ownerId: string, id: string): Promise<boolean> {
  const [row] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'draw')))
    .limit(1);
  if (!row) return false;
  await db.delete(nodes).where(eq(nodes.id, id)); // `draws` row cascades.
  return true;
}

function dedupeTags(tags: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const t = raw.trim().toLowerCase();
    if (!t || t.length > 40 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 20) break;
  }
  return out;
}
