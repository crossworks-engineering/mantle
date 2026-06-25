/**
 * mentionRefs — collect the resolved references out of a page's TipTap doc,
 * split by what they point at:
 *   - entityIds → an `entity` (person/project/place) the user @-mentioned
 *   - nodeIds   → another `node` (page/note) the user linked to
 *
 * Each mention chip stores `attrs.id` plus `attrs.ref` ('entity' | 'node';
 * defaults to 'entity' for back-compat with chips authored before node links).
 * The extractor turns these into graph edges: entity refs → `mentioned_in`,
 * node refs → `references` (backlinks). Pure + deterministic; deduped,
 * order-preserving.
 */

type PMNode = {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
};

export type MentionRefs = { entityIds: string[]; nodeIds: string[] };

export function mentionRefs(doc: unknown): MentionRefs {
  const entityIds: string[] = [];
  const nodeIds: string[] = [];
  const eSeen = new Set<string>();
  const nSeen = new Set<string>();

  const walk = (node: PMNode | null | undefined) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'mention') {
      const id = node.attrs?.id;
      if (typeof id === 'string' && id) {
        if (node.attrs?.ref === 'node') {
          if (!nSeen.has(id)) {
            nSeen.add(id);
            nodeIds.push(id);
          }
        } else if (!eSeen.has(id)) {
          eSeen.add(id);
          entityIds.push(id);
        }
      }
    }
    if (Array.isArray(node.content)) for (const child of node.content) walk(child);
  };

  walk(doc as PMNode);
  return { entityIds, nodeIds };
}

/** What a mention chip points at: another page/note (`node`) or a
 *  person/project/place (`entity`). Mirrors the editor's chip `ref` attr. */
export type MentionRef = 'node' | 'entity';

/**
 * Build a paragraph block carrying a single mention chip — the programmatic
 * equivalent of typing `@Target` in the editor. `leadText` (e.g. "See also:")
 * is prepended as plain text + a trailing space; omit for a bare chip. The
 * chip's `ref` decides the edge the extractor later builds: 'node' → a
 * `references` backlink to another page/note, 'entity' → a `mentioned_in` edge
 * to an entity. Pure — the caller resolves `label`/`kind` (the chip text the
 * reader sees) and persists the doc. The chip mirrors the editor's shape so the
 * resulting paragraph renders + round-trips identically to a hand-typed mention.
 */
export function buildMentionParagraph(opts: {
  id: string;
  label: string;
  ref: MentionRef;
  kind?: string | null;
  leadText?: string | null;
}): Record<string, unknown> {
  const chip = {
    type: 'mention',
    attrs: { id: opts.id, label: opts.label, ref: opts.ref, kind: opts.kind ?? null },
  };
  const lead = opts.leadText?.trim();
  const content: Record<string, unknown>[] = lead
    ? [{ type: 'text', text: `${lead} ` }, chip]
    : [chip];
  return { type: 'paragraph', content };
}
