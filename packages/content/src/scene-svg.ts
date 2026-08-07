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
 * Kept as a literal rather than read from the package, whose `exports` map
 * does not expose package.json. `excalidraw-engine.test.ts` is the tripwire:
 * it fails if this drifts from the exact pin declared by either app.
 */
export const EXCALIDRAW_ENGINE = '0.18.1';

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
