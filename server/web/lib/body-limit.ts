/**
 * The request body ceiling (client logins C5 audit, I4). A JSON body used to
 * be buffered and parsed whatever its size (Caddy lets 1 GB through), so a
 * few parallel half-gigabyte bodies from any signed-in login could take the
 * web process past its memory limit. Two guards, one number per route:
 *
 *  - the gate refuses a declared Content-Length over the route's ceiling
 *    before any handler runs (server/middleware/gate.ts);
 *  - `readBodyCapped` (lib/strip-nul.ts `readJsonNoNul` reads through it)
 *    stops reading at the ceiling, for a chunked body that declares nothing.
 *
 * Both answer 413 `{ reason: 'body-too-large', error }` (the thrown
 * `BodyTooLargeError` is mapped by app.onError). Uploads are not JSON: their
 * routes stream to disk under their own caps (upload-stream.ts) and have no
 * ceiling here.
 */

const MB = 1024 * 1024;

/** A JSON body's ceiling on any route not listed below. */
export const JSON_BODY_CEILING_BYTES = 8 * MB;

/** The owner surfaces that take whole documents, or a file as base64 (an MCP
 *  `file_upload` of up to 64 MB), in one JSON body. Owner only: a member or
 *  a client never reaches them. */
export const OWNER_DOCUMENT_CEILING_BYTES = 128 * MB;

/** The sign-in and sign-up routes (/api/auth/**): public, a few small
 *  fields each, so a much lower ceiling. */
export const AUTH_BODY_CEILING_BYTES = 64 * 1024;

/** The public share routes (/s/<token>/**): anyone with a link can post
 *  there, so a small ceiling. The app db-broker's largest honest body is a
 *  20 KB statement with up to 999 parameters (apps audit S2). */
export const SHARE_BODY_CEILING_BYTES = 1 * MB;

/** Routes that stream an upload (multipart or raw) under their own cap. */
const UPLOAD_PATHS: readonly RegExp[] = [
  /^\/api\/files\/files$/,
  /^\/api\/assistant\/turn$/,
  /^\/api\/assistant\/transcribe$/,
  /^\/api\/tables\/[^/]+\/import$/,
  /^\/api\/profile\/(photo|logo)$/,
  /^\/api\/member\/space-files$/,
  /^\/api\/admin\/space-files$/,
  /^\/api\/client\/space-files$/,
];

/** Owner document and tool surfaces (prefixes). */
const OWNER_DOCUMENT_PREFIXES: readonly string[] = [
  '/api/mcp',
  '/api/pages',
  '/api/tables',
  '/api/draws',
  '/api/notes',
  '/api/apps',
  '/api/sandboxes',
  '/api/files',
  '/api/admin/space',
];

/** The body ceiling of `path` in bytes; null for an upload route (its own
 *  streamed cap applies). */
export function bodyCeilingFor(path: string): number | null {
  if (UPLOAD_PATHS.some((re) => re.test(path))) return null;
  if (path === '/api/auth' || path.startsWith('/api/auth/')) return AUTH_BODY_CEILING_BYTES;
  if (path.startsWith('/s/')) return SHARE_BODY_CEILING_BYTES;
  if (OWNER_DOCUMENT_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) {
    return OWNER_DOCUMENT_CEILING_BYTES;
  }
  return JSON_BODY_CEILING_BYTES;
}

/** A body over its ceiling (thrown while reading; answered 413). */
export class BodyTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`request body over ${maxBytes} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

/** The 413 for a body over `maxBytes`. */
export function bodyTooLargeResponse(maxBytes: number): Response {
  return Response.json(
    {
      error: `This request is too large (at most ${Math.round(maxBytes / MB)} MB).`,
      reason: 'body-too-large',
    },
    { status: 413, headers: { 'Cache-Control': 'no-store' } },
  );
}

/** The declared Content-Length is over `maxBytes`. A missing or malformed
 *  header declares nothing (the read cap still holds). */
export function declaredOver(headers: Headers, maxBytes: number): boolean {
  const raw = headers.get('content-length');
  if (raw === null || raw.trim() === '') return false;
  const n = Number(raw);
  return Number.isFinite(n) && n > maxBytes;
}

/**
 * The body as text, reading at most `maxBytes`: a declared length over it is
 * refused before a byte is read, and a longer stream is cancelled at the
 * ceiling. Throws BodyTooLargeError.
 */
export async function readBodyCapped(req: Request, maxBytes: number): Promise<string> {
  if (declaredOver(req.headers, maxBytes)) throw new BodyTooLargeError(maxBytes);
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** A request's JSON body read under `maxBytes` (the route's ceiling), or
 *  null when it is not JSON. Throws BodyTooLargeError past the ceiling. */
export async function readJsonCapped(
  req: Request,
  maxBytes: number = JSON_BODY_CEILING_BYTES,
): Promise<unknown> {
  const text = await readBodyCapped(req, maxBytes);
  try {
    // A UTF-8 byte order mark is not JSON; req.json() skipped it too.
    return JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
  } catch {
    return null;
  }
}
