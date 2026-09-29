/**
 * What a client reads of a page or a note (client logins C2, plan N6): every
 * reference to an item the client may not read is taken out before the body
 * leaves the brain. A client item may name a team or admin item (a mention
 * chip, a link, an embedded image or child page), and the name alone is
 * already the leak: a chip's label and a child page's title are the other
 * item's title. So:
 *
 *  - a mention chip of such an item keeps its place, labelled "Private item",
 *    and points nowhere (no id, no ref); an entity mention always (entities
 *    are brain knowledge no client reads);
 *  - a link to such an item keeps its place as the plain text "Private item"
 *    (the link mark removed; one label for a link split over several text
 *    runs);
 *  - an embed of such an item (an image, a file embed, an embedded drawing,
 *    a child page: any id, src or href on a node) is left out of the doc.
 *
 * A note's markdown is treated the same way: `[text](/n/<id>)` and every
 * other link form becomes "Private item", an image of such an item is left
 * out. A form the line pass does not recognise (a reference-style link, a
 * label with brackets) sends the whole note through the document path, so a
 * reference is never missed because of how it was written.
 *
 * What counts as a reference is embed-refs.ts's reading (the one the member
 * save rule uses): `/n/<id>` and any relative path with an id, the app's own
 * schemes (`page:`, `media:`, `draw:`, `mention:node:`), the id attributes.
 * Pure: `readable` is the set of ids the client may read (client-shared.ts
 * asks the database, once, at the client level). External links and images
 * are not items and stay as they are.
 */
import { CLIENT_PRIVATE_LABEL } from '@mantle/client-types/dto/client';
import { docToMarkdown } from '@mantle/content-core/doc-to-markdown';
import { markdownToDoc } from '@mantle/content-core/markdown';
import { noteRefs, pageRefs, type EmbedRefs } from './embed-refs';

type PMMark = { type?: string; attrs?: Record<string, unknown> };
type PMNode = {
  type?: string;
  attrs?: Record<string, unknown>;
  marks?: PMMark[];
  content?: PMNode[];
  text?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Attributes that hold a node id, on any node type (as embed-refs.ts). */
const ID_ATTRS = ['nodeId', 'drawId', 'pageId'] as const;
/** Block types whose content may be empty; any other container that loses
 *  every child to the embed rule gets an empty paragraph instead. */
const MAY_BE_EMPTY = new Set(['paragraph', 'heading']);

/** Every item id a page document names (for the one readable-ids query). */
export function docRefIds(doc: unknown): string[] {
  return pageRefs(doc).ids;
}

/** Every item id a note's markdown names. */
export function noteRefIds(markdown: string): string[] {
  return noteRefs(markdown).ids;
}

/** Whether a set of references names something the client may not read: an
 *  id outside `readable`, or a mention that is not of a node. */
function namesHidden(refs: EmbedRefs, readable: ReadonlySet<string>): boolean {
  return (
    refs.ids.some((id) => !readable.has(id)) || refs.refused.some((r) => /^\s*mention:/i.test(r))
  );
}

/** A mention chip the client may follow: a node mention of a readable id. */
function mentionReadable(attrs: Record<string, unknown>, readable: ReadonlySet<string>): boolean {
  const id = attrs.id;
  return (
    attrs.ref === 'node' &&
    typeof id === 'string' &&
    UUID.test(id) &&
    readable.has(id.toLowerCase())
  );
}

/** A node that embeds something the client may not read (its own ids and
 *  targets only; its content is walked separately). A non-uuid id names no
 *  item the client could read, so it is hidden too. */
function embedHidden(n: PMNode, readable: ReadonlySet<string>): boolean {
  const a = n.attrs ?? {};
  for (const k of ID_ATTRS) {
    const v = a[k];
    if (typeof v !== 'string' || !v) continue;
    if (!UUID.test(v) || !readable.has(v.toLowerCase())) return true;
  }
  return namesHidden(pageRefs({ type: 'embed', attrs: { src: a.src, href: a.href } }), readable);
}

/** A mark (a link) that points at something the client may not read. */
function markHidden(m: PMMark, readable: ReadonlySet<string>): boolean {
  return namesHidden(pageRefs({ type: 'text', marks: [m] }), readable);
}

/** The mention chip as a client sees it when its target is hidden. */
function privateMention(n: PMNode): PMNode {
  return { ...n, attrs: { id: null, label: CLIENT_PRIVATE_LABEL, ref: null, kind: null } };
}

class Redactor {
  /** Text runs this pass relabelled, by the hidden target they linked to, so
   *  one link over several runs (bold here, plain there) reads once. */
  private readonly relabelled = new WeakMap<PMNode, string>();

  constructor(private readonly readable: ReadonlySet<string>) {}

  /** The node as a client may see it, or null to leave it out. */
  node(n: PMNode): PMNode | null {
    if (!n || typeof n !== 'object') return n;
    let out: PMNode = n;
    if (n.type === 'mention') {
      if (!mentionReadable(n.attrs ?? {}, this.readable)) out = privateMention(n);
    } else if (embedHidden(n, this.readable)) {
      return null;
    }
    if (Array.isArray(n.marks) && n.marks.length) {
      const hidden = n.marks.filter((m) => markHidden(m, this.readable));
      if (hidden.length) {
        const marks = n.marks.filter((m) => !hidden.includes(m));
        out = { ...out, marks };
        if (!marks.length) delete out.marks;
        if (n.type === 'text') {
          out.text = CLIENT_PRIVATE_LABEL;
          this.relabelled.set(out, JSON.stringify(hidden.map((m) => m.attrs ?? {})));
        }
      }
    }
    if (Array.isArray(n.content)) {
      const content = this.content(n.content);
      out = { ...out, content };
      if (!content.length) {
        if (n.type && MAY_BE_EMPTY.has(n.type)) delete out.content;
        else out.content = [{ type: 'paragraph' }];
      }
    }
    return out;
  }

  private content(children: PMNode[]): PMNode[] {
    const out: PMNode[] = [];
    for (const c of children) {
      const r = this.node(c);
      if (r === null) continue;
      const prev = out[out.length - 1];
      const key = this.relabelled.get(r);
      if (key !== undefined && prev && this.relabelled.get(prev) === key) continue;
      out.push(r);
    }
    return out;
  }
}

/**
 * A page document (ProseMirror JSON) as a client may read it: see the top of
 * this file. `readable` = the lower-case ids the client may read. The input
 * is not changed.
 */
export function redactClientDoc(doc: unknown, readable: ReadonlySet<string>): unknown {
  if (!doc || typeof doc !== 'object') return doc;
  return (
    new Redactor(readable).node(doc as PMNode) ?? { type: 'doc', content: [{ type: 'paragraph' }] }
  );
}

/** `[label](target "title")` and `![alt](target)`, the inline forms. The
 *  label holds no unescaped `]`; anything else is left to the check after. */
const MD_LINK =
  /(!?)\[((?:\\.|[^\\\]])*)\]\(\s*(<[^>\n]*>|[^\s()]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/g;

/**
 * A note's markdown as a client may read it: a link to an item the client
 * may not read becomes "Private item", an image of one is left out. When a
 * hidden reference is still there after that (a form the pass does not
 * know), the note goes through the document path instead: markdown to a
 * document, redacted as a page is, and back.
 */
export function redactClientNote(markdown: string, readable: ReadonlySet<string>): string {
  if (!markdown || !namesHidden(noteRefs(markdown), readable)) return markdown;
  const out = markdown.replace(MD_LINK, (whole, bang: string, _label: string, target: string) => {
    const href = target.startsWith('<') ? target.slice(1, -1) : target;
    if (!markHidden({ type: 'link', attrs: { href } }, readable)) return whole;
    return bang ? '' : CLIENT_PRIVATE_LABEL;
  });
  if (!namesHidden(noteRefs(out), readable)) return out;
  return docToMarkdown(redactClientDoc(markdownToDoc(markdown), readable));
}
