/**
 * mentionEntityIds — collect the resolved entity ids from a page's TipTap
 * document. Each `@`-mention chip stores the entity id the user picked (from
 * the existing-entities lookup), so these are high-signal, pre-resolved
 * references — used by the extractor to guarantee an `entity --mentioned_in-->
 * node` edge for every mention, independent of whether the LLM's NER happens
 * to surface that name. Pure + deterministic; deduped, order-preserving.
 */

type PMNode = {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
};

export function mentionEntityIds(doc: unknown): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  const walk = (node: PMNode | null | undefined) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'mention') {
      const id = node.attrs?.id;
      if (typeof id === 'string' && id && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
    if (Array.isArray(node.content)) for (const child of node.content) walk(child);
  };

  walk(doc as PMNode);
  return ids;
}
