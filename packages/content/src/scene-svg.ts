/**
 * Validation for the client-committed SVG snapshot (`draws.scene_svg`).
 *
 * The SVG is produced by exportToSvg in the OWNER's own editor session, but
 * it arrives over the API like any other payload, and it is later served to
 * third parties on the /s share surface — so it gets the same trust as user
 * HTML: none. Policy is REJECT, not rewrite: a snapshot that trips any check
 * is dropped (stored as null, surfaces fall back to a placeholder) and the
 * scene itself is unaffected. Excalidraw's real exports never contain any of
 * the rejected constructs, so a legitimate client loses nothing.
 */

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
  /\son[a-z]+\s*=/i, // inline event handlers
  /javascript:/i,
  /data:text\/html/i,
];

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
