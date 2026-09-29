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
 * scheme (`javascript:`, `vbscript:`, a `data:` link; only a `data:image/`
 * image passes). The scheme is read the way a browser reads it: controls and
 * whitespace inside the value are ignored first, so `java<TAB>script:` is
 * `javascript:` here too (final audit F31).
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

/** Maps an absolute URL that points into this brain (its own host, or any
 *  host's `/n/<id>` permalink) to its path, so it is read as the relative
 *  path it stands for; null for any other URL. The client redactor passes
 *  one (client-redact.ts); the member save rule does not. */
export type OwnUrl = (url: string) => string | null;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_ANY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
/** C0 and C1 controls, DEL and whitespace. A browser's URL parser drops tabs
 *  and newlines anywhere in a URL and controls and spaces at its ends, so a
 *  scheme is tested with all of them removed. */
// eslint-disable-next-line no-control-regex -- matching controls is the point
const URL_NOISE = /[\u0000-\u0020\u007f-\u009f\s]/g;
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

  constructor(private readonly ownUrl?: OwnUrl) {}

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
    let t = v.trim();
    if (!t || t.startsWith('#')) return; // an anchor on the same page
    // An absolute URL into this brain is the path it stands for (OwnUrl).
    const own = this.ownUrl?.(t.replace(URL_NOISE, ''));
    if (own != null) t = own;
    if (text && !t.startsWith('/') && !/^(mention|media|page|draw):/i.test(t)) return;
    // Classified as the browser will read it (see URL_NOISE); `t` is kept for
    // the refusal message. The scheme is case-insensitive, as a browser reads
    // it: `PAGE:<id>` names the same item as `page:<id>`.
    const u = t
      .replace(URL_NOISE, '')
      .replace(/^[a-z][a-z0-9+.-]*:/i, (scheme) => scheme.toLowerCase());
    const mention = MENTION_HREF.exec(u);
    if (mention) {
      if (mention[1] === 'node') this.id(mention[2], embed);
      else this.refused.add(t);
      return;
    }
    const scheme = MEDIA_HREF.exec(u) ?? PAGE_HREF.exec(u) ?? DRAW_HREF.exec(u);
    if (scheme) {
      this.id(scheme[1], embed);
      return;
    }
    if (/^(https?:)?\/\//i.test(u)) {
      if (image) this.refused.add(t);
      return;
    }
    if (image && /^data:image\//i.test(u)) return;
    if (!image && /^(mailto|tel):/i.test(u)) return;
    // Every other scheme: javascript:, vbscript:, data: (not an image), …
    if (/^[a-z][a-z0-9+.-]*:/i.test(u)) {
      this.refused.add(t);
      return;
    }
    // A relative path: every id in it, the fragment (block ids) left out.
    const path = u.split('#')[0] ?? '';
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
export function pageRefs(doc: unknown, ownUrl?: OwnUrl): EmbedRefs {
  const c = new Collector(ownUrl);
  c.doc(doc);
  return c.result();
}

/** The references in a note's markdown. */
export function noteRefs(markdown: string, ownUrl?: OwnUrl): EmbedRefs {
  const c = new Collector(ownUrl);
  if (markdown) c.doc(markdownToDoc(markdown));
  return c.result();
}

/** The references in a drawing's scene: element links (links, never
 *  embeds: a drawing's own images are its file refs); an embedded frame's
 *  link is a source, like an image's, for the refusals. */
export function sceneRefs(scene: unknown, ownUrl?: OwnUrl): EmbedRefs {
  const c = new Collector(ownUrl);
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
export function cellRefs(values: Iterable<unknown>, ownUrl?: OwnUrl): EmbedRefs {
  const c = new Collector(ownUrl);
  for (const v of values) c.href(v, false, true);
  return c.result();
}
