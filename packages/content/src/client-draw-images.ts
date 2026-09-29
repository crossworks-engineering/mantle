/**
 * The images inside a drawing's saved SVG, as a CLIENT may see them (client
 * logins C2; the client twin of member-draw-images.ts). exportToSvg inlines
 * each image's BYTES into the SVG, so a client-level drawing that holds a
 * team or admin image would hand a client a file the client files route
 * refuses. The client SVG keeps an image only when its file is a client-level
 * file of this brain; every other image is taken out and its frame shows
 * empty. There is no author rule here: a client writes nothing into the brain.
 *
 * Read at the client level (the drawing's image refs and the files both
 * follow row security), with the level written in the query as well.
 *
 * Element links too (audit B25): exportToSvg wraps a linked element in
 * `<a href>`, and a link to an item the client may not read (`/n/<id>`, a
 * `page:` ref, an absolute URL into this brain) loses its href; the element
 * stays and points nowhere. Links to readable items and external sites stay.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { currentSpaceScope, currentViewerLevel, db, draws, nodes } from '@mantle/db';
import { UUID_RE } from '@mantle/std';
import { clientLinkHidden, clientOwnUrl, linkRefIds } from './client-redact';
import { clientRedactOrigins } from './client-origins';
import { clientReadableIds } from './client-shared';
import { dropSvgLinks, keepSvgImages, svgHasImages, svgLinkHrefs } from './scene-svg';

/** The scene file ids (Excalidraw BinaryFile ids) of this drawing's images a
 *  client may see. Client scope only. */
export async function clientVisibleDrawFileIds(
  anchorId: string,
  drawId: string,
): Promise<Set<string>> {
  if (currentViewerLevel() !== 'client' || currentSpaceScope()) {
    throw new Error(
      "clientVisibleDrawFileIds reads at the client level: wrap it in withViewer('client')",
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
  const clientFiles = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, anchorId),
        eq(nodes.type, 'file'),
        eq(nodes.audience, 'client'),
        inArray(nodes.id, [...byNode.keys()]),
      ),
    );
  for (const r of clientFiles) {
    for (const fileId of byNode.get(r.id.toLowerCase()) ?? []) visible.add(fileId);
  }
  return visible;
}

/** The drawing's saved SVG as a client receives it: only the images the
 *  client may see (see above). Client scope only. */
export async function clientDrawSvg(
  anchorId: string,
  drawId: string,
  svg: string,
): Promise<string> {
  let out = svg;
  const hrefs = svgLinkHrefs(out);
  if (hrefs.length) {
    const opts = { ownUrl: clientOwnUrl(clientRedactOrigins()) };
    const readable = await clientReadableIds(anchorId, linkRefIds(hrefs, opts));
    out = dropSvgLinks(out, (href) => !clientLinkHidden(href, readable, opts));
  }
  if (!svgHasImages(out)) return out;
  return keepSvgImages(out, await clientVisibleDrawFileIds(anchorId, drawId));
}
