/**
 * Validation for the client-committed SVG snapshot (`draws.scene_svg`).
 *
 * The SVG is produced by exportToSvg in the OWNER's own editor session, but it
 * arrives over the API like any other payload, so it gets the same trust as
 * user HTML: none. Policy is REJECT, not rewrite: a snapshot that trips any
 * check is dropped (stored as null, surfaces fall back to a placeholder) and
 * the scene itself is unaffected. Excalidraw's real exports never contain any
 * of the rejected constructs, so a legitimate client loses nothing.
 *
 * THIS FUNCTION IS NOT THE SAFETY ARGUMENT, and must never be treated as one
 * again. It was, once: every surface injected the stored markup into its page,
 * so a single missed pattern was stored XSS. An audit broke it in two ways in
 * minutes (see docs/draw-audit-findings.md §2) — a solidus is a valid attribute
 * separator in the HTML tokenizer, so `<image href="x"/onerror=…>` never meets
 * the whitespace this file looks for; and the parser decodes character
 * references in attribute values, so `&#106;avascript:` becomes a live
 * `javascript:` URL that no literal search for "javascript:" can see.
 *
 * The fix was architectural: every surface now references the snapshot as an
 * IMAGE (`<img src>` / a `data:` image in print), which is a separate,
 * script-disabled document in every browser. What remains here is a cheap
 * second layer that keeps obvious junk out of the column. Blocklists over HTML
 * are structurally incapable of being complete — if you ever go back to
 * injecting this markup into a page, replace this with a parse-and-serialize
 * allowlist (DOMPurify's SVG profile) first.
 */

/**
 * The pinned Excalidraw version, stamped onto every snapshot this codebase
 * produces (`draws.svg_engine`). A stored snapshot whose stamp differs from
 * this is STALE: the scene is unchanged, but the renderer that drew it isn't
 * the one we ship any more, so it re-renders on next owner view or in bulk via
 * the `draws:re-render` maintenance task.
 *
 * The literal lives in @mantle/client-types/version since the repo split, so
 * BOTH repos' tripwires (server/web/lib/excalidraw-engine.test.ts here, the
 * client/web mirror in jackdaw) assert their local pin against ONE constant.
 */
export { EXCALIDRAW_ENGINE } from '@mantle/client-types/version';

/** Hard cap. Generous because exportToSvg INLINES the fonts it uses as data
 *  URIs (that is what makes the snapshot render standalone on /s, email and
 *  print) — several font subsets can add a couple of MB. Scene images still
 *  live in the files pipeline, never here. */
export const SCENE_SVG_MAX_BYTES = 6_000_000;

const FORBIDDEN = [
  /<\s*script/i,
  /<\s*foreignObject/i,
  /<\s*iframe/i,
  /<\s*embed/i,
  /<\s*object/i,
  // Inline event handlers. The leading class is [\s/] and not \s: in the HTML
  // tokenizer's "before attribute name" state a solidus is a separator, so
  // `<image href="x"/onerror="…">` parses onerror as a live attribute.
  /[\s/]on[a-z-]+\s*=/i,
  /javascript:/i,
  /data:text\/html/i,
  // A character reference anywhere in the document may decode into any of the
  // above once the parser gets it (`&#106;avascript:` → `javascript:`).
  // exportToSvg emits none: its serializer escapes `&` in text as `&amp;`,
  // which this deliberately also rejects rather than trying to tell the two
  // apart. Text with an ampersand in it costs the preview, not the drawing.
  /&#/,
  // Namespaces are resolved by the parser, not by the text: a link or an
  // image under another prefix is as live as an unprefixed one, and none of
  // the checks here (nor keepSvgImages) would see it. exportToSvg declares
  // only the default namespace, so a snapshot with any of these is refused.
  // A DOCTYPE can declare entities; xml:base re-roots every relative link.
  /<!DOCTYPE/i,
  /<!ENTITY/i,
  /<\/?[A-Za-z_][\w.-]*:[A-Za-z_]/,
  /[\s/][A-Za-z_][\w.-]*:href\s*=/i,
  /[\s/]xmlns:[\w.-]+\s*=/i,
  /[\s/]xml:base\s*=/i,
];

// Two checks that belong on this list conceptually and MUST NOT be added,
// because every genuine export trips them. Both were tried; both rejected
// 100% of real snapshots:
//
//   <style>  — exportToSvg ALWAYS appends <style class="style-fonts"> holding
//              the @font-face declarations that make the snapshot render
//              standalone. (Inline <style> escaping its SVG to restyle the
//              host page is real, and is one more reason the snapshot is only
//              ever referenced as an image, where CSS cannot reach out.)
//   external href — Excalidraw emits <a href="https://…"> for element links,
//              a supported feature. Upstream already runs those through
//              @braintree/sanitize-url, and in an image context they are inert
//              and unclickable anyway.

/** Returns the SVG if it passes, null if it should be dropped. */
export function acceptSceneSvg(svg: unknown): string | null {
  if (typeof svg !== 'string') return null;
  const trimmed = svg.trim();
  if (!trimmed) return null;
  if (Buffer.byteLength(trimmed, 'utf8') > SCENE_SVG_MAX_BYTES) return null;
  // Must be a bare <svg> document (allow a leading XML declaration/doctype-free
  // form — exportToSvg emits `<svg …>` directly).
  if (!/^(<\?xml[^>]*\?>\s*)?<svg[\s>]/i.test(trimmed)) return null;
  for (const re of FORBIDDEN) {
    if (re.test(trimmed)) return null;
  }
  return trimmed;
}

/** One tag's attributes, quoted values skipped whole (a `>` inside quotes
 *  does not end the tag). */
const ATTRS = `(?:[^>"']|"[^"]*"|'[^']*')*`;
/** One tag's attributes for the image pass: no raw `<` anywhere (XML
 *  forbids it in an attribute value), so every match attempt stops at the
 *  next `<` and a run of unclosed tags costs linear time, not quadratic. */
const TAG_ATTRS = `(?:[^<>"']|"[^"<]*"|'[^'<]*')*`;
/** A `<symbol>` or `<image>` / `<feImage>` open tag (self-closed or not), or
 *  one of their end tags, under any prefix. Each token is matched on its
 *  own, never by searching ahead for its end tag. */
const SVG_IMAGE_TOKENS = new RegExp(
  `<\\/?(?:[\\w.-]+:)?(?:symbol|image|feImage)\\b${TAG_ATTRS}>`,
  'gi',
);

/** The scene file id a symbol id names, both ways exportToSvg writes it:
 *  `image-<fileId>`, or `image-crop-<fileId>-<hash>` (the hash is decimal). */
export function symbolFileIds(tag: string): string[] {
  const m = /\sid\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
  const id = m?.[1] ?? m?.[2] ?? '';
  const out: string[] = [];
  const crop = /^image-crop-(.+)-\d+$/.exec(id);
  if (crop?.[1]) out.push(crop[1]);
  const plain = /^image-(.+)$/.exec(id);
  if (plain?.[1]) out.push(plain[1]);
  return out;
}

/**
 * A drawing's saved SVG with every embedded image the reader may not see
 * taken out (member logins: a team-level drawing may hold an admin image).
 * exportToSvg puts each scene image in a `<symbol id="image-<fileId>">`
 * holding one `<image href="data:…">` (the bytes themselves), and draws it
 * with `<use href="#…">`. An `<image>` stays only inside a symbol whose file
 * id is in `allowedFileIds`; every other one (another file's, one outside a
 * symbol, an `<feImage>`) is removed, so its frame shows empty. Fail closed:
 * markup this does not recognise loses its images, never keeps them.
 */
export function keepSvgImages(svg: string, allowedFileIds: ReadonlySet<string>): string {
  let inAllowedSymbol = false;
  /** Per open (not self-closed) image: whether it was kept, so its end tag
   *  goes the same way. */
  const openImages: boolean[] = [];
  return svg.replace(SVG_IMAGE_TOKENS, (token: string) => {
    if (/^<(?:[\w.-]+:)?symbol\b/i.test(token)) {
      inAllowedSymbol = symbolFileIds(token).some((id) => allowedFileIds.has(id));
      return token;
    }
    if (/^<\/(?:[\w.-]+:)?symbol/i.test(token)) {
      inAllowedSymbol = false;
      return token;
    }
    if (token.startsWith('</')) return openImages.pop() === true ? token : '';
    // A prefixed image (any namespace) is never kept: an export writes none.
    const keep = inAllowedSymbol && /^<image\b/i.test(token);
    if (!/\/\s*>$/.test(token)) openImages.push(keep);
    return keep ? token : '';
  });
}

/** True when the SVG embeds any image at all (the common drawing does not,
 *  and then there is nothing to check). */
export function svgHasImages(svg: string): boolean {
  return /<(?:[\w.-]+:)?(?:image|feImage)\b/i.test(svg);
}

/** An `<a>` open tag (its attributes, quoted values skipped whole). */
const SVG_ANCHOR_OPEN = new RegExp(`<a\\b${ATTRS}>`, 'gi');
/** A link attribute inside one tag: `href` or `xlink:href`, quoted either
 *  way or bare. */
const SVG_LINK_ATTR = /(\s)((?:xlink:)?href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

/** The value of an attribute as the parser reads it (the five XML entities;
 *  acceptSceneSvg refuses numeric references). */
function decodeAttr(v: string): string {
  return v
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Every link target on an `<a>` in the SVG (Excalidraw wraps a linked
 *  element in one), decoded. */
export function svgLinkHrefs(svg: string): string[] {
  const out: string[] = [];
  for (const tag of svg.match(SVG_ANCHOR_OPEN) ?? []) {
    for (const m of tag.matchAll(SVG_LINK_ATTR)) out.push(decodeAttr(m[3] ?? m[4] ?? m[5] ?? ''));
  }
  return out;
}

/** The SVG with the link taken off every `<a>` whose target `keep` refuses:
 *  the element stays, drawn as before, and points nowhere. */
export function dropSvgLinks(svg: string, keep: (href: string) => boolean): string {
  return svg.replace(SVG_ANCHOR_OPEN, (tag) =>
    tag.replace(
      SVG_LINK_ATTR,
      (whole, _sp: string, _name: string, a?: string, b?: string, c?: string) =>
        keep(decodeAttr(a ?? b ?? c ?? '')) ? whole : '',
    ),
  );
}
