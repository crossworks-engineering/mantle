/**
 * Walk a ProseMirror page document and collect the `file` node ids it embeds
 * (image + fileEmbed nodes carry `attrs.nodeId`). Used to scope the public
 * asset route: a page share may only serve the files its doc actually
 * references. See docs/sharing.md §4.
 */
type PMNode = { type?: string; attrs?: Record<string, unknown>; content?: PMNode[] };

const ASSET_NODE_TYPES = new Set(['image', 'fileEmbed']);

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
