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
 *     else — notably `image/svg+xml` and `text/html` — is forced to
 *     `attachment` (download) and relabeled `application/octet-stream`.
 */

/** Base mime types safe to render inline. SVG and HTML are deliberately absent. */
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
};

/**
 * Headers for serving `bytes` of `mimeType` named `filename`. Previewable types
 * render inline with their real type; everything else downloads as an opaque
 * octet-stream. The filename is RFC 5987 percent-encoded, so it can never
 * inject header content regardless of its characters.
 */
export function safeDownloadHeaders(
  mimeType: string | null | undefined,
  filename: string | null | undefined,
): SafeDownloadHeaders {
  const mime = baseType(mimeType);
  const inline = mime.length > 0 && INLINE_SAFE.has(mime);
  const encoded = encodeURIComponent(filename || 'download');
  return {
    'content-type': inline ? mime : 'application/octet-stream',
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`,
    'x-content-type-options': 'nosniff',
  };
}
