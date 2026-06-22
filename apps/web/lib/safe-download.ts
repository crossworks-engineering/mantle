/**
 * Safe headers for serving stored file bytes.
 *
 * A user (or an email/agent-ingested file) can upload an SVG or HTML document
 * with embedded `<script>`. If we echo the stored mime type with
 * `content-disposition: inline`, the browser executes that script in our
 * origin — stored XSS, and on the public `/s/[token]` share route it runs for
 * any visitor. This helper closes that:
 *
 *   - `X-Content-Type-Options: nosniff` always, so the browser can't upgrade a
 *     mislabeled response to an executable type.
 *   - `inline` only for an allowlist of genuinely previewable types; everything
 *     else — notably `text/html` — is forced to `attachment` (download) and
 *     relabeled `application/octet-stream`.
 *   - `image/svg+xml` is served inline with its real type so the UI can embed
 *     it via `<img>` (where SVG scripts never run), but with a hardening CSP
 *     that `sandbox`es the document and blocks scripts/network. That defangs
 *     the one path where an SVG would execute: direct top-level navigation to
 *     the raw URL. See `SVG_CSP` below.
 */

/**
 * Locked-down policy for SVG bytes. `sandbox` (with no `allow-scripts`) is the
 * load-bearing directive: even on direct navigation the SVG renders as an
 * inert, scriptless document in a unique origin. `default-src 'none'` cuts off
 * network egress (no beacons / external fetches); inline `<style>`, `data:`
 * images and fonts stay allowed so legitimate SVGs still render. This header is
 * ignored when the SVG loads as an `<img>` subresource, which is harmless —
 * images don't execute scripts regardless.
 */
const SVG_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox";

/** Base mime types safe to render inline. HTML is deliberately absent. */
const INLINE_SAFE = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/x-icon',
  'application/pdf',
  'text/plain',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/webm',
  'audio/mp4',
  'audio/aac',
  'audio/flac',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
]);

function baseType(mime: string | null | undefined): string {
  return (mime ?? '').split(';')[0]!.trim().toLowerCase();
}

export type SafeDownloadHeaders = {
  'content-type': string;
  'content-disposition': string;
  'x-content-type-options': 'nosniff';
  'content-security-policy'?: string;
};

/**
 * Headers for serving `bytes` of `mimeType` named `filename`. Previewable types
 * render inline with their real type; everything else downloads as an opaque
 * octet-stream. SVG renders inline too, but with `SVG_CSP` to neutralize any
 * embedded script on direct navigation. The filename is RFC 5987
 * percent-encoded, so it can never inject header content regardless of its
 * characters.
 */
export function safeDownloadHeaders(
  mimeType: string | null | undefined,
  filename: string | null | undefined,
): SafeDownloadHeaders {
  const mime = baseType(mimeType);
  const encoded = encodeURIComponent(filename || 'download');
  if (mime === 'image/svg+xml') {
    return {
      'content-type': 'image/svg+xml',
      'content-disposition': `inline; filename*=UTF-8''${encoded}`,
      'x-content-type-options': 'nosniff',
      'content-security-policy': SVG_CSP,
    };
  }
  const inline = mime.length > 0 && INLINE_SAFE.has(mime);
  return {
    'content-type': inline ? mime : 'application/octet-stream',
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`,
    'x-content-type-options': 'nosniff',
  };
}
