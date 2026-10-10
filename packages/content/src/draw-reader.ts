/**
 * What an agent's reader may get of a drawing: the ONE access helper behind
 * `draw_get`, for its text and for its picture alike.
 *
 * Which drawings a call reaches is decided before and around this: the tool
 * grant (the same `draw_get` slug on every surface, so the same groups, key
 * areas and peer rules), and the viewer scope the call runs in (row rules on
 * `nodes` and `draws`). This helper adds what the scope alone cannot say:
 *
 *  - the draft is never read (the picture is the committed snapshot, and the
 *    draft flag is only asked where the draft columns are readable at all);
 *  - a snapshot inlines its images' BYTES, and `scene_text` folds in their
 *    extracted TEXT, so a reader below the owner gets both with only the
 *    images whose file they may read, by the same rule as their own SVG
 *    route: a member's (member-draw-images.ts), a client's
 *    (client-draw-images.ts), else the files the current scope reads.
 *
 * Kept in one place on purpose: when items move from levels to workspaces,
 * `readerVisibleFileIds` and `readableDraw` are the bodies to swap, and both
 * the text and the picture follow.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  asSystem,
  currentSpaceScope,
  currentViewerLevel,
  db,
  draws,
  nodes,
  readsDrafts,
  withViewer,
} from '@mantle/db';
import { UUID_RE } from '@mantle/std';
import { EMPTY_SCENE, getDrawSceneText, getDrawSvg } from './draws';
import { memberVisibleDrawFileIds } from './member-draw-images';
import { clientVisibleDrawFileIds } from './client-draw-images';
import { sceneToText } from './scene-to-text';
import { foldEmbeddedText } from './pages';

/** Who the call reads for: a member login, a client login, or whoever the
 *  current viewer scope is (the owner's own paths, an agent at its level). */
export type DrawReader =
  { kind: 'scope' } | { kind: 'member'; loginId: string } | { kind: 'client' };

export type ReadableDraw = {
  id: string;
  title: string;
  tags: string[];
  summary: string | null;
  /** Uncommitted canvas edits exist. Only known where drafts are readable
   *  (the owner, a member's own space); false everywhere else. */
  hasDraft: boolean;
  /** A committed snapshot exists to draw a picture from. */
  hasSvg: boolean;
};

/** A drawing's metadata, as the current scope may read it. Null when it is
 *  not a drawing this scope reaches. */
export async function readableDraw(ownerId: string, id: string): Promise<ReadableDraw | null> {
  const [row] = await db
    .select({
      id: nodes.id,
      title: nodes.title,
      tags: nodes.tags,
      data: nodes.data,
      // The draft columns are never granted to the level roles: asking for
      // them there fails the whole query.
      hasDraft: readsDrafts() ? sql<boolean>`${draws.draftScene} IS NOT NULL` : sql<boolean>`false`,
      hasSvg: sql<boolean>`${draws.sceneSvg} IS NOT NULL`,
    })
    .from(nodes)
    .leftJoin(draws, eq(draws.nodeId, nodes.id))
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'draw')))
    .limit(1);
  if (!row) return null;
  const summary = (row.data as Record<string, unknown> | null)?.summary;
  return {
    id: row.id,
    title: row.title,
    tags: row.tags ?? [],
    summary: typeof summary === 'string' ? summary : null,
    hasDraft: row.hasDraft ?? false,
    hasSvg: row.hasSvg ?? false,
  };
}

/**
 * The scene file ids of this drawing's images the reader may see, by the
 * same rule as their own SVG route; null means all of them (the owner).
 * Fail closed: a rule that cannot run leaves none.
 */
export async function readerVisibleFileIds(
  ownerId: string,
  id: string,
  reader: DrawReader,
): Promise<ReadonlySet<string> | null> {
  try {
    if (reader.kind === 'member') {
      // The member rule reads on the admin pool (its author half needs it);
      // the drawing itself is reached at the member's scope by the caller.
      return await asSystem(() => memberVisibleDrawFileIds(ownerId, reader.loginId, id));
    }
    if (reader.kind === 'client') {
      return await withViewer('client', () => clientVisibleDrawFileIds(ownerId, id));
    }
    if (currentViewerLevel() === 'admin' && !currentSpaceScope()) return null;
    return await scopeVisibleDrawFileIds(ownerId, id);
  } catch {
    return new Set();
  }
}

/**
 * The committed text as this reader may read it. The owner gets the stored
 * `scene_text`, the very text the brain indexed. Everyone else gets the
 * scene's own text (labels, frames, arrows) plus the extracted text of only
 * the pasted images they may see: `scene_text` folds every image's text in
 * at commit, so serving it as stored would hand a reader the words of an
 * image their picture hides. Each file keeps its own text (`nodes.data.text`,
 * written once by the file extractor), so the fold is redone per reader from
 * the same source the commit used, with the same bounds.
 */
export async function readableDrawText(
  ownerId: string,
  id: string,
  reader: DrawReader,
): Promise<string | null> {
  const visible = await readerVisibleFileIds(ownerId, id, reader);
  if (visible === null) return getDrawSceneText(ownerId, id);
  const [row] = await db
    .select({ scene: draws.scene, fileRefs: draws.fileRefs })
    .from(draws)
    .innerJoin(nodes, eq(nodes.id, draws.nodeId))
    .where(and(eq(draws.nodeId, id), eq(nodes.ownerId, ownerId), eq(nodes.type, 'draw')))
    .limit(1);
  if (!row) return null;
  const base = sceneToText((row.scene as Record<string, unknown> | null) ?? EMPTY_SCENE);
  const nodeIds: string[] = [];
  for (const [fileId, nodeId] of Object.entries((row.fileRefs ?? {}) as Record<string, unknown>)) {
    if (!visible.has(fileId) || typeof nodeId !== 'string' || !UUID_RE.test(nodeId)) continue;
    if (!nodeIds.includes(nodeId)) nodeIds.push(nodeId);
  }
  if (nodeIds.length === 0) return base;
  // Visibility is decided above; the texts are read on the admin pool so a
  // member's own accepted image (the author rule) keeps its words too.
  const files = await asSystem(() =>
    db
      .select({ id: nodes.id, title: nodes.title, data: nodes.data })
      .from(nodes)
      .where(and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'file'), inArray(nodes.id, nodeIds))),
  );
  const byId = new Map(files.map((f) => [f.id, f]));
  const fold = foldEmbeddedText(
    nodeIds.flatMap((n) => {
      const f = byId.get(n);
      return f
        ? [{ title: f.title, text: (f.data as Record<string, unknown> | null)?.text as string }]
        : [];
    }),
  );
  return fold ? `${base}\n\n${fold}` : base;
}

/** The scene file ids of this drawing's images whose file the current scope
 *  reads (row rules decide). */
async function scopeVisibleDrawFileIds(ownerId: string, id: string): Promise<Set<string>> {
  const [row] = await db
    .select({ fileRefs: draws.fileRefs })
    .from(draws)
    .where(eq(draws.nodeId, id))
    .limit(1);
  const byNode = new Map<string, string[]>();
  for (const [fileId, nodeId] of Object.entries((row?.fileRefs ?? {}) as Record<string, unknown>)) {
    if (typeof nodeId !== 'string' || !UUID_RE.test(nodeId)) continue;
    const key = nodeId.toLowerCase();
    byNode.set(key, [...(byNode.get(key) ?? []), fileId]);
  }
  const visible = new Set<string>();
  if (byNode.size === 0) return visible;
  const readable = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, ownerId),
        eq(nodes.type, 'file'),
        inArray(nodes.id, [...byNode.keys()]),
      ),
    );
  for (const r of readable) {
    for (const fileId of byNode.get(r.id.toLowerCase()) ?? []) visible.add(fileId);
  }
  return visible;
}

export type ReadableDrawSvg = {
  /** The committed snapshot AS STORED, images and all. Only ever for
   *  `renderDrawSvgPng` with `keepImagesOf: visibleFileIds`, whose XML parse
   *  applies the image rule; never serve it as it is. */
  snapshot: string;
  /** The scene file ids whose image this reader may see; null = all (the
   *  owner). */
  visibleFileIds: ReadonlySet<string> | null;
};

/**
 * The committed SVG snapshot and this reader's image rule: null when there
 * is no snapshot (or the drawing is out of reach). The rule is applied by the
 * renderer's parser (svg-sanitize.ts), on what the parser sees, rather than
 * by a text pass here.
 */
export async function readableDrawSvg(
  ownerId: string,
  id: string,
  reader: DrawReader,
): Promise<ReadableDrawSvg | null> {
  const snapshot = await getDrawSvg(ownerId, id);
  if (!snapshot) return null;
  return { snapshot, visibleFileIds: await readerVisibleFileIds(ownerId, id, reader) };
}
