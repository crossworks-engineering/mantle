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
 *  - a snapshot inlines its images' BYTES, so a reader below the owner gets it
 *    with only the images whose file they may read, by the same rule as their
 *    own SVG route: a member's (member-draw-images.ts), a client's
 *    (client-draw-images.ts), else the files the current scope reads.
 *
 * Kept in one place on purpose: when items move from levels to workspaces,
 * this is the body to swap, and both the text and the picture follow.
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
import { getDrawSceneText, getDrawSvg } from './draws';
import { memberDrawSvg } from './member-draw-images';
import { clientDrawSvg } from './client-draw-images';
import { keepSvgImages, svgHasImages } from './scene-svg';

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

/** The committed text (`scene_text`), as the current scope may read it. */
export function readableDrawText(ownerId: string, id: string): Promise<string | null> {
  return getDrawSceneText(ownerId, id);
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

/**
 * The committed SVG snapshot as this reader may see it: null when there is
 * none (or the drawing is out of reach), else the snapshot with every image
 * the reader may not see taken out. Fail closed: a rule that cannot run
 * leaves no images at all.
 */
export async function readableDrawSvg(
  ownerId: string,
  id: string,
  reader: DrawReader,
): Promise<string | null> {
  const svg = await getDrawSvg(ownerId, id);
  if (!svg) return null;
  if (reader.kind === 'member') {
    // The member rule reads on the admin pool (its author half needs it);
    // the drawing itself was reached above, at the member's scope.
    return asSystem(() => memberDrawSvg(ownerId, reader.loginId, id, svg));
  }
  if (reader.kind === 'client') {
    try {
      return await withViewer('client', () => clientDrawSvg(ownerId, id, svg));
    } catch {
      return keepSvgImages(svg, new Set());
    }
  }
  if (currentViewerLevel() === 'admin' && !currentSpaceScope()) return svg;
  if (!svgHasImages(svg)) return svg;
  return keepSvgImages(svg, await scopeVisibleDrawFileIds(ownerId, id));
}
