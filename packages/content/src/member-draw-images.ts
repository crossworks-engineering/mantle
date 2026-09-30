/**
 * The images inside a drawing's saved SVG, as a MEMBER may see them (member
 * logins). A drawing at team level may hold an image whose file is above team
 * (an admin screenshot): exportToSvg inlines the image BYTES into the SVG, so
 * serving the snapshot as-is would hand a member a file the member files
 * route refuses. The member SVG keeps an image only when its file passes that
 * route's rule: a file at team level or lower in this brain, or a file this
 * member wrote and an admin accepted, while the brain file still holds the
 * bytes accepted (audit F07). Every other image is taken out. The SVG of the
 * member's OWN accepted drawing as accepted (its snapshot) keeps the images
 * the member wrote whatever happened to them since: the bytes inside it are
 * the ones accepted, and the snapshot's own image refs name them.
 *
 * The rule is written in the query (the admin pool proves it): the author
 * half needs the admin pool anyway (member-accepted.ts), and the answer is
 * only a set of ids to KEEP, never an item's content.
 */
import { and, eq, inArray } from 'drizzle-orm';
import {
  currentSpaceScope,
  currentViewerLevel,
  db,
  draws,
  LIMITED_LEVELS,
  nodes,
} from '@mantle/db';
import { UUID_RE } from '@mantle/std';
import { readAtSql } from './item-level';
import { acceptedFileReadable, isAuthorOfAcceptedFile } from './member-accepted';
import { keepSvgImages, svgHasImages } from './scene-svg';

/** The scene file ids (Excalidraw BinaryFile ids) of this drawing's images a
 *  member may see. Admin pool: call it outside a viewer scope. */
export async function memberVisibleDrawFileIds(
  anchorId: string,
  loginId: string,
  drawId: string,
  /** The accepted snapshot's image refs, for the SVG as accepted. */
  snapshotRefs?: Record<string, unknown>,
): Promise<Set<string>> {
  if (currentViewerLevel() !== 'admin' || currentSpaceScope()) {
    throw new Error(
      'memberVisibleDrawFileIds reads on the admin pool: call it outside a viewer scope',
    );
  }
  let refs = snapshotRefs;
  if (!refs) {
    const [row] = await db
      .select({ fileRefs: draws.fileRefs })
      .from(draws)
      .where(eq(draws.nodeId, drawId))
      .limit(1);
    refs = (row?.fileRefs ?? {}) as Record<string, unknown>;
  }
  const authored = snapshotRefs ? isAuthorOfAcceptedFile : acceptedFileReadable;
  // file node id -> the scene file ids that draw it.
  const byNode = new Map<string, string[]>();
  for (const [fileId, nodeId] of Object.entries(refs)) {
    if (typeof nodeId !== 'string' || !UUID_RE.test(nodeId)) continue;
    const key = nodeId.toLowerCase();
    byNode.set(key, [...(byNode.get(key) ?? []), fileId]);
  }
  const visible = new Set<string>();
  if (byNode.size === 0) return visible;
  const teamLevel = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, anchorId),
        eq(nodes.type, 'file'),
        inArray(nodes.id, [...byNode.keys()]),
        // Its own level or the share of a folder holding it.
        readAtSql(LIMITED_LEVELS),
      ),
    );
  const ok = new Set(teamLevel.map((r) => r.id.toLowerCase()));
  for (const nodeId of byNode.keys()) {
    if (!ok.has(nodeId) && (await authored(anchorId, loginId, nodeId))) {
      ok.add(nodeId);
    }
  }
  for (const nodeId of ok) for (const fileId of byNode.get(nodeId) ?? []) visible.add(fileId);
  return visible;
}

/** The drawing's saved SVG as a member receives it: only the images the
 *  member may see (see above). Admin pool. */
export async function memberDrawSvg(
  anchorId: string,
  loginId: string,
  drawId: string,
  svg: string,
  /** The accepted snapshot's image refs, for the SVG as accepted. */
  snapshotRefs?: Record<string, unknown>,
): Promise<string> {
  if (!svgHasImages(svg)) return svg;
  return keepSvgImages(
    svg,
    await memberVisibleDrawFileIds(anchorId, loginId, drawId, snapshotRefs),
  );
}
