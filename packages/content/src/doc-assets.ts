/**
 * Walk a ProseMirror page document and collect the `file` node ids it embeds
 * (image + fileEmbed nodes carry `attrs.nodeId`). Used to scope the public
 * asset route: a page share may only serve the files its doc actually
 * references. See docs/sharing.md §4.
 */
type PMNode = { type?: string; attrs?: Record<string, unknown>; content?: PMNode[] };

const ASSET_NODE_TYPES = new Set(['image', 'fileEmbed']);

/**
 * The DRAW node ids a page embeds (`![alt](draw:<id>)` → an image node with
 * `attrs.drawId`). Scopes the share surface the same way referencedFileIds
 * does for uploads: a shared page may serve exactly the drawings its doc
 * actually places, and nothing else.
 */
export function referencedDrawIds(doc: unknown): string[] {
  const out = new Set<string>();
  const walk = (n: PMNode | null | undefined) => {
    if (!n || typeof n !== 'object') return;
    if (n.type === 'image') {
      const id = n.attrs?.drawId;
      if (typeof id === 'string' && id) out.add(id);
    }
    if (Array.isArray(n.content)) for (const c of n.content) walk(c);
  };
  walk(doc as PMNode);
  return [...out];
}

export function referencedFileIds(doc: unknown): string[] {
  const out = new Set<string>();
  const walk = (n: PMNode | null | undefined) => {
    if (!n || typeof n !== 'object') return;
    if (n.type && ASSET_NODE_TYPES.has(n.type)) {
      const id = n.attrs?.nodeId;
      if (typeof id === 'string' && id) out.add(id);
    }
    if (Array.isArray(n.content)) for (const c of n.content) walk(c);
  };
  walk(doc as PMNode);
  return [...out];
}

/** Node types whose ids render INSIDE a page: an image or page image (an
 *  uploaded file by `nodeId`, a drawing by `drawId`), a file embed, and a
 *  child page card (`pageId`). */
const EMBED_ATTRS: Record<string, readonly string[]> = {
  image: ['nodeId', 'drawId'],
  pageImage: ['nodeId', 'drawId'],
  fileEmbed: ['nodeId'],
  childPage: ['pageId'],
};

/**
 * Every item a page EMBEDS: its images and file embeds (files), its embedded
 * drawings, and its child page cards. This is the page's part of the embed
 * closure that follows a page's level down (docs/access-levels.md section 1,
 * "Embedding means sharing"). Links (a link mark, a mention chip) are not
 * embeds: they name an item without showing it.
 */
export function referencedEmbedIds(doc: unknown): string[] {
  const out = new Set<string>();
  const walk = (n: PMNode | null | undefined) => {
    if (!n || typeof n !== 'object') return;
    for (const k of (n.type && EMBED_ATTRS[n.type]) || []) {
      const id = n.attrs?.[k];
      if (typeof id === 'string' && id) out.add(id);
    }
    if (Array.isArray(n.content)) for (const c of n.content) walk(c);
  };
  walk(doc as PMNode);
  return [...out];
}
