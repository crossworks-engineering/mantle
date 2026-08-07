/**
 * The reference-link schemes of Saskia's rich-markdown dialect: the round-trip
 * forms `docToMarkdown` emits for app-native nodes (see rich-writing.md §2):
 *
 *   ![alt](media:<file-id>)      an uploaded image, by node id
 *   [label](media:<file-id>)     a file embed
 *   [Title](page:<page-id>)      a child page
 *   ![alt](draw:<draw-id>)       an embedded drawing
 *   [Label](mention:<ref>:<id>)  a mention chip
 *
 * Kept here, alone, with **no dependencies**, because two converters read these
 * schemes and they must not drift:
 *
 *   - `markdown-to-doc.ts`            → ProseMirror JSON (Pages, server-side)
 *   - `client/web/lib/rich-markdown`  → HTML (the chat RichText, client-side)
 *
 * They diverged once already: Pages resolved `media:` into a real image while
 * chat let it fall through to a broken `<img src="media:…">`, which is why a
 * reply could not place a picture mid-sentence. Both now import the scheme from
 * here, and a drift test pins them to the same answers.
 *
 * Browser-safe leaf, importable from client code without dragging the
 * `@mantle/content` barrel (and its DB deps) into the bundle.
 */

/** `[Label](mention:node:<id>)` / `[Label](mention:entity:<id>)`. The ref
 *  segment is optional and defaults to `entity` at the call site. */
export const MENTION_HREF = /^mention:(?:(node|entity):)?([^\s]+)$/;
/** `media:<file-id>`, an uploaded file by node id. */
export const MEDIA_HREF = /^media:([^\s]+)$/;
/** `page:<page-id>`, a child page by node id. */
export const PAGE_HREF = /^page:([^\s]+)$/;
/** `draw:<draw-id>`, a drawing embedded as a picture. Deliberately a LIVE
 *  reference, not a copy: the page renders the drawing's current committed
 *  snapshot, so editing the drawing updates every page that embeds it. */
export const DRAW_HREF = /^draw:([^\s]+)$/;

/** The draw node id behind a `draw:` href, or null for any other href. */
export function drawNodeId(href: string | undefined | null): string | null {
  return DRAW_HREF.exec(href ?? '')?.[1] ?? null;
}

/** The owner-gated serve path for a drawing's committed snapshot. The one
 *  place this route is spelled out for markdown conversion, mirroring
 *  `fileRawSrc` for uploaded files. */
export function drawRawSrc(nodeId: string): string {
  return `/api/draws/${nodeId}/svg?raw=1`;
}

/** The file node id behind a `media:` href, or null for any other href. */
export function mediaFileId(href: string | undefined | null): string | null {
  return MEDIA_HREF.exec(href ?? '')?.[1] ?? null;
}

/**
 * The owner-gated serve path for a file's bytes. This is the ONE place the
 * route is spelled out for markdown conversion; `PageImage.renderHTML` builds
 * the same string from `nodeId`, so an emitted `<img>` and a re-rendered one
 * agree. Unencoded on purpose, so it matches what the node itself produces.
 */
export function fileRawSrc(nodeId: string): string {
  return `/api/files/files/${nodeId}?raw=1`;
}

/**
 * Every file id referenced as an INLINE IMAGE (`![alt](media:<id>)`) in a
 * markdown source. Used to suppress the trailing attachment gallery for a
 * picture the reply already placed itself. Otherwise a turn that writes the
 * image inline *and* calls `show_image` for the same file shows it twice.
 *
 * Deliberately images only: a `[label](media:<id>)` file-embed link is a
 * different affordance and does not render the picture, so it must not
 * suppress the gallery copy.
 */
export function inlineMediaImageIds(source: string | undefined | null): Set<string> {
  const ids = new Set<string>();
  if (!source) return ids;
  const re = /!\[[^\]]*\]\(\s*media:([^\s)]+)\s*\)/g;
  for (const m of source.matchAll(re)) if (m[1]) ids.add(m[1]);
  return ids;
}

/** A reference-link target found in a markdown source: which scheme it used,
 *  the id it points at, and the node type that scheme requires (unset ⇒ any
 *  node). `nodeType` is what makes a wrong-type reference reportable. */
export type MarkdownRef = {
  scheme: 'media' | 'page' | 'mention' | 'draw';
  id: string;
  nodeType?: 'file' | 'page' | 'draw';
};

/** Any markdown link or image, capturing the href. */
const REF_LINK_RE = /!?\[[^\]]*\]\(\s*([^\s)]+)\s*\)/g;

/**
 * Every app-native reference a markdown source points at, deduped. The write
 * path checks these against real nodes before storing the body — a dangling
 * `media:` id renders as nothing at all, silently, and the model that wrote it
 * gets no feedback (see packages/tools/src/preconditions.ts).
 *
 * `mention:entity:<id>` is deliberately NOT returned: entities live outside the
 * node table, so there is no node id to check. Only the explicit
 * `mention:node:<id>` form yields a ref.
 */
export function markdownRefs(source: string | undefined | null): MarkdownRef[] {
  const out: MarkdownRef[] = [];
  if (!source) return out;
  const seen = new Set<string>();
  for (const m of source.matchAll(REF_LINK_RE)) {
    const href = m[1];
    if (!href) continue;
    let ref: MarkdownRef | null = null;
    const media = MEDIA_HREF.exec(href);
    if (media?.[1]) ref = { scheme: 'media', id: media[1], nodeType: 'file' };
    const page = PAGE_HREF.exec(href);
    if (page?.[1]) ref = { scheme: 'page', id: page[1], nodeType: 'page' };
    const draw = DRAW_HREF.exec(href);
    if (draw?.[1]) ref = { scheme: 'draw', id: draw[1], nodeType: 'draw' };
    const mention = MENTION_HREF.exec(href);
    // Bare `mention:<id>` defaults to an entity — skip; only `mention:node:` is
    // a node reference.
    if (mention?.[1] === 'node' && mention[2]) ref = { scheme: 'mention', id: mention[2] };
    if (!ref) continue;
    const key = `${ref.scheme}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/**
 * Drop inline `![alt](media:<id>)` image markers from a markdown source, for a
 * surface that cannot render them (Telegram sends plain text, so the marker
 * would arrive as literal `![...](media:...)` gibberish). Returns the cleaned text
 * plus how many markers were removed, so the caller can trace it.
 *
 * A marker alone on its line takes the line with it; one sitting in prose
 * leaves its alt text behind, which is the closest thing to the picture the
 * surface can carry.
 */
export function stripInlineMediaImages(source: string): { text: string; stripped: number } {
  let stripped = 0;
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const soleMarker = /^\s*!\[([^\]]*)\]\(\s*media:[^\s)]+\s*\)\s*$/.exec(line);
    if (soleMarker) {
      stripped++;
      continue; // drop the whole line, nothing else was on it
    }
    if (!/!\[[^\]]*\]\(\s*media:[^\s)]+\s*\)/.test(line)) {
      kept.push(line);
      continue;
    }
    kept.push(
      line.replace(/!\[([^\]]*)\]\(\s*media:[^\s)]+\s*\)/g, (_all, alt: string) => {
        stripped++;
        return alt;
      }),
    );
  }
  // Collapse the blank-line runs a dropped marker line can leave behind.
  const text = kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, stripped };
}
