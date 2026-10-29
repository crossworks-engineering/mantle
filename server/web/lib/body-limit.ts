/**
 * The request body ceiling. Caddy lets 1 GB through, so a body buffered
 * and parsed whatever its size would let a few parallel half-gigabyte
 * bodies from any signed-in login take the web process past its memory
 * limit. Two guards, one number per route:
 *
 *  - the gate refuses a declared Content-Length over the route's ceiling
 *    before any handler runs (server/middleware/gate.ts);
 *  - the route loader hands every handler a request whose body reads
 *    through the ceiling (capRequestBody): json(), text(), formData(),
 *    arrayBuffer() and the body stream itself stop at the ceiling, for a
 *    chunked body that declares nothing.
 *
 * Both answer 413 `{ reason: 'body-too-large', error }` (the thrown
 * `BodyTooLargeError` is mapped by app.onError; a handler that swallowed it
 * gets the same 413 from the loader). The streamed uploads are not JSON:
 * their routes spool to disk under their own caps (upload-stream.ts) and
 * have no ceiling here. The multipart routes that call formData(), which
 * buffers the whole body, have one: their file cap plus room for the
 * framing (MULTIPART_CEILINGS).
 */
import { CACHE_CONTROL } from './cache-control';

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
 *  20 KB statement with up to 999 parameters. */
export const SHARE_BODY_CEILING_BYTES = 1 * MB;

/** LiveKit's webhook (calls plan section 12): public, one event a body. */
export const WEBHOOK_BODY_CEILING_BYTES = 1 * MB;

/** Routes that stream an upload (multipart or raw) to disk under their own
 *  cap, never buffering it: no ceiling here. */
const UPLOAD_PATHS: readonly RegExp[] = [
  /^\/api\/files\/files$/,
  /^\/api\/apps\/import-package$/,
  /^\/api\/member\/space-files$/,
  /^\/api\/admin\/space-files$/,
];

/** Room for the multipart framing (boundaries, part headers, the text
 *  fields) above a route's file cap. */
export const MULTIPART_FRAMING_BYTES = 1 * MB;

/** The buffered upload cap (MAX_UPLOAD_BYTES, @mantle/files limits.ts): a
 *  chat attachment, a spreadsheet import. Pinned equal by body-ceiling.test.ts. */
export const BUFFERED_UPLOAD_BYTES = 64 * MB;

/** A voice clip: the speech-to-text providers take at most 25 MB. */
export const VOICE_CLIP_BYTES = 25 * MB;

/** A profile photo or brand logo: twice LOGO_MAX_BYTES (512 KB), so a file
 *  under the routes' own cap always fits with its framing; pinned by the
 *  test. A body over it is the gate's 413. */
export const PROFILE_IMAGE_BODY_BYTES = 1 * MB;

/** The multipart routes that read their body with formData(), which buffers
 *  it whole: each is held to its file cap plus the framing, so a chunked
 *  body that declares nothing stops there (the chat routes are open to
 *  member and client logins). */
const MULTIPART_CEILINGS: readonly (readonly [RegExp, number])[] = [
  [/^\/api\/assistant\/turn$/, BUFFERED_UPLOAD_BYTES + MULTIPART_FRAMING_BYTES],
  [/^\/api\/assistant\/transcribe$/, VOICE_CLIP_BYTES + MULTIPART_FRAMING_BYTES],
  [/^\/api\/tables\/[^/]+\/import$/, BUFFERED_UPLOAD_BYTES + MULTIPART_FRAMING_BYTES],
  [/^\/api\/profile\/(photo|logo)$/, PROFILE_IMAGE_BODY_BYTES],
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

/** The body ceiling of `path` (the decoded path the route matched) in
 *  bytes; null for a streamed upload route (its own streamed cap applies). */
export function bodyCeilingFor(path: string): number | null {
  if (UPLOAD_PATHS.some((re) => re.test(path))) return null;
  const multipart = MULTIPART_CEILINGS.find(([re]) => re.test(path));
  if (multipart) return multipart[1];
  if (path === '/api/auth' || path.startsWith('/api/auth/')) return AUTH_BODY_CEILING_BYTES;
  if (path.startsWith('/s/')) return SHARE_BODY_CEILING_BYTES;
  if (path === '/api/livekit/webhook') return WEBHOOK_BODY_CEILING_BYTES;
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

/** The requests capRequestBody made whose body went over the ceiling. */
const wentOver = new WeakSet<Request>();

/**
 * `req` with its body read through `maxBytes`: every
 * reader of the body (json(), text(), formData(), arrayBuffer(), the
 * stream) gets the bytes up to the ceiling and then BodyTooLargeError, and
 * the source is cancelled there. Nothing is read until a reader asks. A
 * request with no body is handed back as it is.
 */
export function capRequestBody(req: Request, maxBytes: number): Request {
  const source = req.body;
  if (!source || req.method === 'GET' || req.method === 'HEAD') return req;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let total = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(ctrl) {
        reader ??= source.getReader();
        const { done, value } = await reader.read();
        if (done) return ctrl.close();
        total += value.byteLength;
        if (total > maxBytes) {
          wentOver.add(capped);
          await reader.cancel().catch(() => {});
          ctrl.error(new BodyTooLargeError(maxBytes));
          return;
        }
        ctrl.enqueue(value);
      },
      cancel(reason) {
        return (reader ?? source).cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  // Built from the request's parts, never `new Request(req, init)`: under
  // @hono/node-server the handler's request is a lightweight stand-in that
  // undici's brand check refuses as a Request input (it would throw on
  // every POST behind serve()). Only a method that
  // carries a body gets one (a GET or HEAD has none here).
  const capped = new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body,
    duplex: 'half',
    signal: req.signal,
  } as RequestInit);
  return capped;
}

/** Whether a body capRequestBody capped went over its ceiling (a handler
 *  that caught the error still answers 413). */
export function bodyWentOver(req: Request): boolean {
  return wentOver.has(req);
}

/** A ceiling as a person reads it: MB from 1 MB up, KB below (a 64 KB
 *  ceiling never reads "at most 0 MB"). */
export function ceilingText(maxBytes: number): string {
  return maxBytes >= MB ? `${Math.round(maxBytes / MB)} MB` : `${Math.round(maxBytes / 1024)} KB`;
}

/** The 413 for a body over `maxBytes`. */
export function bodyTooLargeResponse(maxBytes: number): Response {
  return Response.json(
    {
      error: `This request is too large (at most ${ceilingText(maxBytes)}).`,
      reason: 'body-too-large',
    },
    { status: 413, headers: { 'Cache-Control': CACHE_CONTROL.none } },
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
  return (await readBytesCapped(req, maxBytes)).toString('utf8');
}

/** The body's bytes, read under the same rule as `readBodyCapped` (a raw
 *  upload route reads its own cap this way). Throws BodyTooLargeError. */
export async function readBytesCapped(req: Request, maxBytes: number): Promise<Buffer> {
  if (declaredOver(req.headers, maxBytes)) throw new BodyTooLargeError(maxBytes);
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      // Not awaited: a clone's branch (req.clone(), a peek) settles its
      // cancel only once the other branch is cancelled too, so awaiting it
      // hung the request while the handler went on to read the original.
      void reader.cancel().catch(() => {});
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
