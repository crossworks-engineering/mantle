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
