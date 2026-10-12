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
 *    images whose file the current scope reads (row rules on the grants
 *    decide), by the same rule as the SVG byte route (`scopedDrawSvg`).
 *
 * Every read is the current scope's (workspaces W8d): the member and client
 * readers, which read on other pools, are gone. Kept in one place on
 * purpose: `readerVisibleFileIds` and `readableDraw` are the bodies the text
 * and the picture both follow.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  currentSpaceScope,
  currentWorkspaceScope,
  db,
  draftAllowed,
  draws,
  nodes,
  inTurnScope,
  readsDrafts,
  TurnScopeExitError,
  isSystemScope,
} from '@mantle/db';
import { UUID_RE } from '@mantle/std';
import { EMPTY_SCENE, getDrawSceneText, getDrawSvg } from './draws';
import { keepSvgImages, svgHasImages } from './scene-svg';
import { sceneToText } from './scene-to-text';
import { foldEmbeddedText } from './pages';

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
 *  not a drawing this scope reaches, and for a team surface that reaches
 *  the system pool (W8 final): a member's read never gets the owner's
 *  drawing, its text included. */
export async function readableDraw(
  ownerId: string,
  id: string,
  readFor: DrawReadFor = {},
): Promise<ReadableDraw | null> {
  if (teamReadOnSystemPool(readFor)) return null;
  const [row] = await db
    .select({
      id: nodes.id,
      title: nodes.title,
      tags: nodes.tags,
      data: nodes.data,
      // The draft columns are never granted to the level roles: asking for
      // them there fails the whole query.
      hasDraft: readsDrafts()
        ? sql<boolean>`(${draftAllowed()} and ${draws.draftScene} IS NOT NULL)`
        : sql<boolean>`false`,
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

/** Who a drawing is read for, beyond the current scope: `teamSurface` when
 *  the call came from a team surface (a member's chat, a member's app). */
export type DrawReadFor = { teamSurface?: boolean };

/** A read for a team surface that reached the system pool, outside any turn
 *  or space scope: it reads nothing (fail closed). */
function teamReadOnSystemPool(readFor: DrawReadFor): boolean {
  return !!readFor.teamSurface && !inTurnScope() && isSystemScope() && !currentSpaceScope();
}

/**
 * The scene file ids of this drawing's images the current scope may see, by
 * the same rule as the SVG byte route; null means all of them (the owner's
 * own paths on the admin pool). Fail closed: a rule that cannot run leaves
 * none, and so does a team surface that reaches here on the system pool
 * (W8 integration): a member's read never gets every image of the owner's.
 */
export async function readerVisibleFileIds(
  ownerId: string,
  id: string,
  readFor: DrawReadFor = {},
): Promise<ReadonlySet<string> | null> {
  try {
    // Inside a turn scope (workspaces W4b fix round 2) the scope's own row
    // rules decide, and a turn never leaves its scope unnamed.
    if (inTurnScope()) return await scopeVisibleDrawFileIds(ownerId, id);
    if (isSystemScope() && !currentSpaceScope()) return readFor.teamSurface ? new Set() : null;
    return await scopeVisibleDrawFileIds(ownerId, id);
  } catch (err) {
    // An unnamed exit from a turn scope is a bug to report (strict mode
    // throws it), never a drawing without images.
    if (err instanceof TurnScopeExitError) throw err;
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
  readFor: DrawReadFor = {},
): Promise<string | null> {
  if (teamReadOnSystemPool(readFor)) return null;
  const visible = await readerVisibleFileIds(ownerId, id, readFor);
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
  // Visibility is decided above, in this scope; the texts are read here too.
  const files = await db
    .select({ id: nodes.id, title: nodes.title, data: nodes.data })
    .from(nodes)
    .where(and(eq(nodes.ownerId, ownerId), eq(nodes.type, 'file'), inArray(nodes.id, nodeIds)));
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
  readFor: DrawReadFor = {},
): Promise<ReadableDrawSvg | null> {
  const snapshot = await getDrawSvg(ownerId, id);
  if (!snapshot) return null;
  return { snapshot, visibleFileIds: await readerVisibleFileIds(ownerId, id, readFor) };
}

/**
 * The drawing's saved SVG as a non-Admin login receives it on the byte
 * routes (workspaces W7e): only the images whose file the CURRENT scope
 * reads (the login's request scope, where row security on the grants
 * decides). Call it inside that scope: every read here is the scope's (the
 * drawing's image refs, then which of their files exist for the reader).
 * Moved here from member-draw-images.ts (removed in W8d) unchanged.
 */
export async function scopedDrawSvg(
  anchorId: string,
  drawId: string,
  svg: string,
): Promise<string> {
  if (!svgHasImages(svg)) return svg;
  if (!currentWorkspaceScope()) {
    throw new Error('scopedDrawSvg reads in the caller workspace scope: call it inside one');
  }
  return keepSvgImages(svg, await scopeVisibleDrawFileIds(anchorId, drawId));
}
