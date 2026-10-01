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
 * asks the database, once, at the client level). External links stay as
 * they are.
 *
 * Fail closed (audit B25): every reference embed-refs.ts REFUSES is hidden
 * too, not only an entity mention: a scheme it does not know, a `javascript:`
 * link, an external image, an id that is not a uuid. A scheme is read
 * case-insensitively (`PAGE:<id>` is `page:<id>`), and an absolute URL into
 * this brain (its own host, or any host's `/n/<id>` permalink, see
 * `clientOwnUrl`) is read as the path it stands for. With `titles` (the
 * current titles of the readable ids, from the same query), a readable
 * mention chip and child page card carry the item's title of today, not the
 * one stored when it was written.
 */
import { CLIENT_PRIVATE_LABEL } from '@mantle/client-types/dto/client';
import { docToMarkdown } from '@mantle/content-core/doc-to-markdown';
import { markdownToDoc } from '@mantle/content-core/markdown';
import { cellRefs, noteRefs, pageRefs, sceneRefs, type EmbedRefs, type OwnUrl } from './embed-refs';

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

const PERMALINK = /^\/n\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:[/?#]|$)/i;

/**
 * The OwnUrl a client read uses: an http(s) or protocol-relative URL whose
 * host is one of `origins` (the brain's public URL, its client origin), or
 * whose path is a `/n/<id>` permalink on any host, is the path it stands
 * for. Hosts are compared without the scheme, so `http://` and `https://`
 * links of the brain are both its own. Fail closed: a permalink on another
 * host is read as an item of this brain, so at worst it shows as "Private
 * item".
 */
export function clientOwnUrl(origins: readonly (string | null | undefined)[] = []): OwnUrl {
  const hosts = new Set<string>();
  for (const o of origins) {
    if (!o) continue;
    try {
      hosts.add(new URL(o).host.toLowerCase());
    } catch {
      // not a URL: names no host
    }
  }
  return (u) => {
    if (!/^(https?:)?\/\//i.test(u)) return null;
    let url: URL;
    try {
      url = new URL(u.startsWith('//') ? `https:${u}` : u);
    } catch {
      return null;
    }
    if (!hosts.has(url.host.toLowerCase()) && !PERMALINK.test(url.pathname)) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  };
}

const DEFAULT_OWN_URL = clientOwnUrl();

/** How a client read is redacted, beyond the readable ids. */
export type ClientRedactOptions = {
  /** Absolute URLs into this brain (default: `/n/<id>` on any host). */
  ownUrl?: OwnUrl;
  /** Current titles of readable ids: a readable mention chip's label and a
   *  child page card's title are refreshed from them. */
  titles?: ReadonlyMap<string, string>;
  /** A child page card of a hidden page: left out (the default, what a
   *  client reads), or kept as "Private item" (the level-filtered text a
   *  client-level page indexes, pages/level-text.ts). */
  hiddenChildPage?: 'drop' | 'label';
};

/** Every item id a page document names (for the one readable-ids query). */
export function docRefIds(doc: unknown, opts: ClientRedactOptions = {}): string[] {
  return pageRefs(doc, opts.ownUrl ?? DEFAULT_OWN_URL).ids;
}

/** Every item id a note's markdown names. */
export function noteRefIds(markdown: string, opts: ClientRedactOptions = {}): string[] {
  return noteRefs(markdown, opts.ownUrl ?? DEFAULT_OWN_URL).ids;
}

/** Every item id table cells name (a path or one of the app's schemes). */
export function cellRefIds(values: Iterable<unknown>, opts: ClientRedactOptions = {}): string[] {
  return cellRefs(values, opts.ownUrl ?? DEFAULT_OWN_URL).ids;
}

/** Every item id a list of link targets names (a drawing's element links). */
export function linkRefIds(hrefs: readonly string[], opts: ClientRedactOptions = {}): string[] {
  return sceneRefs({ elements: hrefs.map((link) => ({ link })) }, opts.ownUrl ?? DEFAULT_OWN_URL)
    .ids;
}

/** Whether one link target names something the client may not read. */
export function clientLinkHidden(
  href: string,
  readable: ReadonlySet<string>,
  opts: ClientRedactOptions = {},
): boolean {
  return namesHidden(
    sceneRefs({ elements: [{ link: href }] }, opts.ownUrl ?? DEFAULT_OWN_URL),
    readable,
  );
}

/** Whether a set of references names something the client may not read: an
 *  id outside `readable`, or anything the reference reading refused (an
 *  entity mention, an unknown scheme, an external image, a non-uuid id). */
function namesHidden(refs: EmbedRefs, readable: ReadonlySet<string>): boolean {
  return refs.ids.some((id) => !readable.has(id)) || refs.refused.length > 0;
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
function embedHidden(n: PMNode, readable: ReadonlySet<string>, ownUrl: OwnUrl): boolean {
  const a = n.attrs ?? {};
  for (const k of ID_ATTRS) {
    const v = a[k];
    if (typeof v !== 'string' || !v) continue;
    if (!UUID.test(v) || !readable.has(v.toLowerCase())) return true;
  }
  return namesHidden(
    pageRefs({ type: 'embed', attrs: { src: a.src, href: a.href } }, ownUrl),
    readable,
  );
}

/** A mark (a link) that points at something the client may not read. */
function markHidden(m: PMMark, readable: ReadonlySet<string>, ownUrl: OwnUrl): boolean {
  return namesHidden(pageRefs({ type: 'text', marks: [m] }, ownUrl), readable);
}

/** The mention chip as a client sees it when its target is hidden. */
function privateMention(n: PMNode): PMNode {
  return { ...n, attrs: { id: null, label: CLIENT_PRIVATE_LABEL, ref: null, kind: null } };
}

/** The current title of a readable id, when the caller passed titles. */
function titleOf(id: unknown, titles: ReadonlyMap<string, string> | undefined): string | null {
  if (!titles || typeof id !== 'string') return null;
  return titles.get(id.toLowerCase()) ?? null;
}

class Redactor {
  /** Text runs this pass relabelled, by the hidden target they linked to, so
   *  one link over several runs (bold here, plain there) reads once. */
  private readonly relabelled = new WeakMap<PMNode, string>();
  private readonly ownUrl: OwnUrl;

  constructor(
    private readonly readable: ReadonlySet<string>,
    private readonly opts: ClientRedactOptions = {},
  ) {
    this.ownUrl = opts.ownUrl ?? DEFAULT_OWN_URL;
  }

  /** The node as a client may see it, or null to leave it out. */
  node(n: PMNode): PMNode | null {
    if (!n || typeof n !== 'object') return n;
    let out: PMNode = n;
    if (n.type === 'mention') {
      if (!mentionReadable(n.attrs ?? {}, this.readable)) out = privateMention(n);
      else {
        const title = titleOf(n.attrs?.id, this.opts.titles);
        if (title !== null) out = { ...n, attrs: { ...n.attrs, label: title } };
      }
    } else if (embedHidden(n, this.readable, this.ownUrl)) {
      if (n.type !== 'childPage' || this.opts.hiddenChildPage !== 'label') return null;
      return { type: 'childPage', attrs: { pageId: null, title: CLIENT_PRIVATE_LABEL } };
    } else if (n.type === 'childPage') {
      const title = titleOf(n.attrs?.pageId, this.opts.titles);
      if (title !== null) out = { ...n, attrs: { ...n.attrs, title } };
    }
    if (Array.isArray(n.marks) && n.marks.length) {
      const hidden = n.marks.filter((m) => markHidden(m, this.readable, this.ownUrl));
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
export function redactClientDoc(
  doc: unknown,
  readable: ReadonlySet<string>,
  opts: ClientRedactOptions = {},
): unknown {
  if (!doc || typeof doc !== 'object') return doc;
  return (
    new Redactor(readable, opts).node(doc as PMNode) ?? {
      type: 'doc',
      content: [{ type: 'paragraph' }],
    }
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
export function redactClientNote(
  markdown: string,
  readable: ReadonlySet<string>,
  opts: ClientRedactOptions = {},
): string {
  const ownUrl = opts.ownUrl ?? DEFAULT_OWN_URL;
  if (!markdown) return markdown;
  const hides = namesHidden(noteRefs(markdown, ownUrl), readable);
  if (!hides && !opts.titles?.size) return markdown;
  const out = markdown.replace(MD_LINK, (whole, bang: string, label: string, target: string) => {
    const href = target.startsWith('<') ? target.slice(1, -1) : target;
    if (markHidden({ type: 'link', attrs: { href } }, readable, ownUrl)) {
      return bang ? '' : CLIENT_PRIVATE_LABEL;
    }
    // A readable mention or child page link names its item by title: today's.
    const ref = /^(?:mention:node:|page:)(\S+)$/i.exec(href.trim());
    const title = bang || !ref ? null : titleOf(ref[1], opts.titles);
    if (title === null) return whole;
    return `[${title.replace(/[\\[\]]/g, '\\$&')}]${whole.slice(label.length + 2)}`;
  });
  if (!namesHidden(noteRefs(out, ownUrl), readable)) return out;
  return docToMarkdown(redactClientDoc(markdownToDoc(markdown), readable, opts));
}

/**
 * A table cell as a client may read it: a value that names an item the
 * client may not read (a path such as `/n/<id>`, an app scheme such as
 * `page:<id>`, an absolute URL into this brain) becomes "Private item"; a
 * list value (multiselect) is checked item by item. Anything else is left
 * as it is.
 */
export function redactClientCell<T>(
  value: T,
  readable: ReadonlySet<string>,
  opts: ClientRedactOptions = {},
): T | string | string[] {
  const ownUrl = opts.ownUrl ?? DEFAULT_OWN_URL;
  const one = (v: unknown) =>
    typeof v === 'string' && namesHidden(cellRefs([v], ownUrl), readable)
      ? CLIENT_PRIVATE_LABEL
      : v;
  if (Array.isArray(value)) return value.map((v) => one(v) as string);
  return one(value) as T | string;
}
