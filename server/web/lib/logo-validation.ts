// Relative import (not `@/`) so the co-located vitest run resolves it — the
// team-sso.ts pattern.
import { LOGO_TYPES } from '@mantle/content';

/**
 * Byte-level validation for the brand-logo upload (PUT /api/profile/logo) —
 * defense for the PUBLIC serve route (/api/appearance/logo). The type comes
 * from the BYTES, never the browser's claimed content-type, and an SVG with
 * active content is rejected outright (the serve route's CSP is the second
 * layer, not the only one).
 */

export const LOGO_MAX_BYTES = 512 * 1024;

export function sniffType(buf: Buffer): (typeof LOGO_TYPES)[number] | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from('\x89PNG\r\n\x1a\n', 'binary'))) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  // SVG: text that reaches an <svg root (optionally after xml decl/comments/
  // doctype). Checked on a decoded, BOM-stripped prefix.
  const head = buf
    .subarray(0, 4096)
    .toString('utf8')
    .replace(/^\uFEFF/, '');
  if (/^\s*(?:<\?xml[^>]*\?>\s*|<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s>]/i.test(head)) {
    return 'image/svg+xml';
  }
  return null;
}

/** Active-content tripwire for SVG — any hit is a hard reject. */
export const SVG_ACTIVE_RE =
  /<script|<foreignObject|\son[a-z]+\s*=|javascript:|data:text\/html|<use[^>]+href\s*=\s*["']?\s*http/i;

/**
 * Which stored logo bytes are safe to delete after a variant write, or null.
 *
 * Content-addressed keys are SHARED by identical bytes — across brains is
 * irrelevant here, but across the two VARIANTS of this brain it bites:
 * uploading the same file as both light and dark yields ONE key, so "delete
 * what this variant used to point at" would tear the bytes out from under the
 * other variant (or from under the very upload that just landed, when the
 * user re-uploads an identical file). Both routes (PUT replace, DELETE) run
 * their cleanup through this one predicate.
 *
 * `replaced` — the key this variant pointed at before the write.
 * `newKey`   — the key just written (undefined on DELETE).
 * `otherKey` — the OTHER variant's current key.
 */
export function staleLogoBytes(opts: {
  replaced: string | undefined;
  newKey?: string | undefined;
  otherKey: string | undefined;
}): string | null {
  const { replaced, newKey, otherKey } = opts;
  if (!replaced) return null; // nothing was pointed at — nothing to clean
  if (replaced === newKey) return null; // identical re-upload — bytes still live
  if (replaced === otherKey) return null; // the other variant still uses them
  return replaced;
}
