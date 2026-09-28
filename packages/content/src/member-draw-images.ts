/**
 * The images inside a drawing's saved SVG, as a MEMBER may see them (member
 * logins). A drawing at team level may hold an image whose file is above team
 * (an admin screenshot): exportToSvg inlines the image BYTES into the SVG, so
 * serving the snapshot as-is would hand a member a file the member files
 * route refuses. The member SVG keeps an image only when its file passes that
 * route's rule: a file at team level or lower in this brain, or a file this
 * member wrote and an admin accepted. Every other image is taken out.
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
import { isAuthorOfAcceptedFile } from './member-accepted';
import { keepSvgImages, svgHasImages } from './scene-svg';

/** The scene file ids (Excalidraw BinaryFile ids) of this drawing's images a
 *  member may see. Admin pool: call it outside a viewer scope. */
export async function memberVisibleDrawFileIds(
  anchorId: string,
  loginId: string,
  drawId: string,
): Promise<Set<string>> {
  if (currentViewerLevel() !== 'admin' || currentSpaceScope()) {
    throw new Error(
      'memberVisibleDrawFileIds reads on the admin pool: call it outside a viewer scope',
    );
  }
  const [row] = await db
    .select({ fileRefs: draws.fileRefs })
    .from(draws)
    .where(eq(draws.nodeId, drawId))
    .limit(1);
  const refs = (row?.fileRefs ?? {}) as Record<string, unknown>;
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
        inArray(nodes.audience, [...LIMITED_LEVELS]),
      ),
    );
  const ok = new Set(teamLevel.map((r) => r.id.toLowerCase()));
  for (const nodeId of byNode.keys()) {
    if (!ok.has(nodeId) && (await isAuthorOfAcceptedFile(anchorId, loginId, nodeId))) {
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
): Promise<string> {
  if (!svgHasImages(svg)) return svg;
  return keepSvgImages(svg, await memberVisibleDrawFileIds(anchorId, loginId, drawId));
}
