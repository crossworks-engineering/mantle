/**
 * Every reference a member's personal item carries, for the save-time embed
 * rule (member logins Phase 2, plan 2d; audit S2). Pure: the rule itself
 * (own items and Library items only) lives in member-space.ts.
 *
 * What counts as a reference:
 *  - page documents: the id attributes (`nodeId`, `drawId`, `pageId`) on any
 *    node (image, pageImage, fileEmbed, childPage, …), mention chips, and
 *    every `src` / `href` on a node or a mark (link marks included);
 *  - notes: the same, after their markdown is parsed into a document;
 *  - drawings: each element's `link`;
 *  - tables: every text cell that is a path or a scheme.
 *
 * An href or src resolves like this: the app's own schemes (`page:`,
 * `media:`, `draw:`, `mention:node:`) name one id; a relative path names
 * every uuid in it (`/n/<id>`, `/api/member/space/<id>/bytes`); an external
 * link (`https:`, `mailto:`) is fine; an external IMAGE (or an embedded
 * frame) is refused, as it would be a tracking pixel on every teammate and
 * the reviewer who opens the item. Refused outright, never queried: an id
 * that is not a uuid (Postgres would answer 22P02, an opaque 500), an entity
 * mention (entities are brain knowledge no member can read), any other
 * scheme (`javascript:`).
 */
import { markdownToDoc } from '@mantle/content-core/markdown';
import { DRAW_HREF, MEDIA_HREF, MENTION_HREF, PAGE_HREF } from '@mantle/content-core/markdown-refs';

/** `ids`: uuids to check against the space and the Library. `refused`: what
 *  may never be saved, whatever the database says. `embeds`: the ids among
 *  `ids` that render INSIDE the item (an image, a file embed, an embedded
 *  drawing or child page: any id, src or href on a node); the rest are
 *  links (a link mark, a mention chip, a drawing's element link, a table
 *  cell). Accept (Phase 4, plan 6.2) moves the embeds with the item and
 *  leaves the links where they are. */
export type EmbedRefs = { ids: string[]; refused: string[]; embeds: string[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** Attributes that hold a node id, on any node type. */
const ID_ATTRS = ['nodeId', 'drawId', 'pageId'] as const;

type PMNode = {
  type?: string;
  attrs?: Record<string, unknown>;
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
  content?: PMNode[];
};

class Collector {
  private readonly ids = new Set<string>();
  private readonly embeds = new Set<string>();
  private readonly refused = new Set<string>();

  /** `embed`: the id renders inside the item (see EmbedRefs). */
  id(v: unknown, embed = false): void {
    if (typeof v !== 'string' || !v) return;
    if (!UUID.test(v)) {
      this.refused.add(v);
      return;
    }
    const id = v.toLowerCase();
    this.ids.add(id);
    if (embed) this.embeds.add(id);
  }

  /** A link target (`image` false) or an image / frame source (`image` true).
   *  `text`: the value is free text (a table cell), so only the app's own
   *  schemes and paths count; "Note: call Ann" is not a link. `embed`: the
   *  value sits on a node, so what it names renders inside the item. */
  href(v: unknown, image: boolean, text = false, embed = image): void {
    if (typeof v !== 'string') return;
    const t = v.trim();
    if (!t || t.startsWith('#')) return; // an anchor on the same page
    if (text && !t.startsWith('/') && !/^(mention|media|page|draw):/i.test(t)) return;
    const mention = MENTION_HREF.exec(t);
    if (mention) {
      if (mention[1] === 'node') this.id(mention[2], embed);
      else this.refused.add(t);
      return;
    }
    const scheme = MEDIA_HREF.exec(t) ?? PAGE_HREF.exec(t) ?? DRAW_HREF.exec(t);
    if (scheme) {
      this.id(scheme[1], embed);
      return;
    }
    if (/^(https?:)?\/\//i.test(t)) {
      if (image) this.refused.add(t);
      return;
    }
    if (image && /^data:image\//i.test(t)) return;
    if (!image && /^(mailto|tel):/i.test(t)) return;
    if (/^[a-z][a-z0-9+.-]*:/i.test(t)) {
      this.refused.add(t);
      return;
    }
    // A relative path: every id in it, the fragment (block ids) left out.
    const path = t.split('#')[0] ?? '';
    for (const u of path.match(UUID_ANY) ?? []) this.id(u, embed);
  }

  doc(node: unknown): void {
    if (!node || typeof node !== 'object') return;
    const n = node as PMNode;
    const a = n.attrs ?? {};
    if (n.type === 'mention') {
      if (a.ref === 'node') this.id(a.id);
      else if (typeof a.id === 'string' && a.id) this.refused.add(`mention:entity:${a.id}`);
    }
    // On a node, every id and target renders inside the item (an image, a
    // file embed, an embedded drawing or child page); on a mark it is a link.
    for (const k of ID_ATTRS) this.id(a[k], true);
    this.href(a.src, true);
    this.href(a.href, false, false, true);
    for (const m of n.marks ?? []) {
      this.href(m.attrs?.href, false);
      this.href(m.attrs?.src, true, false, false);
    }
    if (Array.isArray(n.content)) for (const c of n.content) this.doc(c);
  }

  result(): EmbedRefs {
    return { ids: [...this.ids], refused: [...this.refused], embeds: [...this.embeds] };
  }
}

/** The references in a page document (ProseMirror JSON). */
export function pageRefs(doc: unknown): EmbedRefs {
  const c = new Collector();
  c.doc(doc);
  return c.result();
}

/** The references in a note's markdown. */
export function noteRefs(markdown: string): EmbedRefs {
  const c = new Collector();
  if (markdown) c.doc(markdownToDoc(markdown));
  return c.result();
}

/** The references in a drawing's scene: element links (links, never
 *  embeds: a drawing's own images are its file refs); an embedded frame's
 *  link is a source, like an image's, for the refusals. */
export function sceneRefs(scene: unknown): EmbedRefs {
  const c = new Collector();
  const elements = (scene as { elements?: unknown })?.elements;
  if (Array.isArray(elements)) {
    for (const el of elements) {
      if (!el || typeof el !== 'object') continue;
      const e = el as { type?: unknown; link?: unknown; isDeleted?: unknown };
      if (e.isDeleted === true) continue;
      c.href(e.link, e.type === 'embeddable' || e.type === 'iframe', false, false);
    }
  }
  return c.result();
}

/** The references in table cells (the text values that are a path or a
 *  scheme). */
export function cellRefs(values: Iterable<unknown>): EmbedRefs {
  const c = new Collector();
  for (const v of values) c.href(v, false, true);
  return c.result();
}
