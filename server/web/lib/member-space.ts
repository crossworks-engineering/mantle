/**
 * The HTTP side of a member's personal space (member logins Phase 2). Every
 * member space route runs its work through `inMySpace`: one short transaction
 * on the personal-space role for the caller's own space, so row level
 * security holds every read and write to it. There is no owner filter in the
 * routes to get wrong.
 */
import { NextResponse } from '@/server/http-compat';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { z } from 'zod';
import { spaceThumbsDir, thumbnailFor } from '@mantle/files';
import { safeDownloadHeaders } from '@mantle/client-types/lib/safe-download';
import type { OpenedSpaceFile } from '@mantle/content';
import { withSpace } from '@mantle/db';
import {
  SCENE_SVG_MAX_BYTES,
  SpaceItemStateError,
  isWithAdmin,
  sceneWithinLimits,
  withAdminError,
} from '@mantle/content';
import type { MemberCaller } from '@/lib/auth';
import { rateLimit } from '@/lib/rate-limit';
import { TableOpsSchema } from '@/lib/table-ops-schema';

/** Run `fn` inside the member's own space. */
export function inMySpace<T>(member: MemberCaller, fn: () => Promise<T>): Promise<T> {
  return withSpace({ spaceId: member.spaceId, loginId: member.loginId }, fn);
}

export const SpaceIdParams = z.object({ id: z.string().uuid() });

/** A state refusal (frozen, not a draft, unsaved edits) as a 409 the member
 *  can read, not-found as a 404; anything else rethrows to the opaque 500. */
export function spaceStateResponse(err: unknown): Response {
  if (err instanceof SpaceItemStateError) {
    const status = err.reason === 'not-found' ? 404 : err.reason === 'invalid' ? 400 : 409;
    return NextResponse.json(
      { error: err.message, reason: err.reason, ...(err.ids.length ? { ids: err.ids } : {}) },
      { status },
    );
  }
  throw err;
}

export const notFound = () => NextResponse.json({ error: 'Not found.' }, { status: 404 });

/**
 * An item of this member's that an admin has taken over (audit F07) is not
 * in their space any more: every member item route answers it 409
 * `with-admin` (no content, no bytes) instead of a 404, so the client can
 * say where it is. Null for anything else (the route goes on as before).
 * The client space routes use it too (client logins C5): only the login
 * matters.
 */
export async function withAdminGuard(
  caller: { loginId: string },
  id: string,
): Promise<Response | null> {
  return (await isWithAdmin(caller.loginId, id)) ? spaceStateResponse(withAdminError()) : null;
}

/** A stale draft etag, in the owner routes' shape. */
export const conflict = (rev: number) =>
  NextResponse.json(
    {
      error: 'The draft changed since you loaded it. Reload, then apply your edit again.',
      current_rev: rev,
    },
    { status: 409 },
  );

/** A page document's size cap for members (serialized JSON). The owner's page
 *  routes have none; a member is a less trusted writer. */
export const MEMBER_DOC_MAX_BYTES = 2_000_000;

const Doc = z
  .record(z.string(), z.unknown())
  .refine((d) => Buffer.byteLength(JSON.stringify(d), 'utf8') <= MEMBER_DOC_MAX_BYTES, {
    message: 'document too large',
  });
const Scene = z.record(z.string(), z.unknown()).refine(sceneWithinLimits, {
  message: 'scene too large',
});

/** A whole table document's size cap for members (serialized JSON). Bigger
 *  grids are edited with op batches, which the op schema bounds. */
export const MEMBER_TABLE_MAX_BYTES = 5_000_000;

const TableDocBody = z
  .record(z.string(), z.unknown())
  .refine((d) => Buffer.byteLength(JSON.stringify(d), 'utf8') <= MEMBER_TABLE_MAX_BYTES, {
    message: 'table too large',
  });

/** Autosave body: a page's `doc`, a drawing's `scene`, or a table's whole
 *  `table` document or an `ops` batch, plus the etag. */
export const DraftBody = z.object({
  doc: Doc.optional(),
  scene: Scene.optional(),
  table: TableDocBody.optional(),
  ops: TableOpsSchema.optional(),
  if_rev: z.number().int().nonnegative().optional(),
});

/** Save-version body: as the draft, plus a drawing's SVG snapshot (what
 *  teammates see). Bounded in bytes, like the owner's draw commit. A table
 *  saves its server draft when no `table` is sent. */
export const SaveBody = DraftBody.extend({
  svg: z
    .string()
    .refine((s) => Buffer.byteLength(s, 'utf8') <= SCENE_SVG_MAX_BYTES, {
      message: 'svg too large',
    })
    .optional(),
});

/** Writes a member may make to their space (autosave, Save version, create,
 *  rename, delete, share, submit, recall, comments, uploads), per login per
 *  minute (audit F31). Generous: an editor autosaves every second or two. */
export const MEMBER_WRITES_PER_MIN = 120;

/**
 * The per-login rate limit on every member write route: a 429 with
 * Retry-After, or null to go on. Checked before the body is read. Each write
 * costs only CPU and disk (no model work), but a page draft can be 2 MB and a
 * table save rebuilds its workbook, so a runaway client is bounded here.
 */
export function memberWriteGate(member: MemberCaller): Response | null {
  const gate = rateLimit(`member-writes:${member.loginId}`, {
    max: MEMBER_WRITES_PER_MIN,
    windowMs: 60_000,
  });
  if (gate.ok) return null;
  return NextResponse.json(
    { error: 'Too many changes at once. Wait a moment, then try again.', reason: 'rate-limit' },
    { status: 429, headers: { 'retry-after': String(gate.retryAfterSec) } },
  );
}

/** Requests a member may make to the bytes routes, per login per minute.
 *  A thumbnail may decode an image, so it has its own, smaller budget. */
export const MEMBER_BYTES_PER_MIN = 240;
export const MEMBER_THUMBS_PER_MIN = 60;

/**
 * The per-login rate limit on the member bytes routes (own and team files).
 * Answers a 429 with Retry-After, or null to go on. Checked before any file
 * is opened.
 */
export function memberBytesGate(req: Request, member: MemberCaller): Response | null {
  const thumb = new URL(req.url).searchParams.get('thumb') === '1';
  const gate = thumb
    ? rateLimit(`member-thumbs:${member.loginId}`, {
        max: MEMBER_THUMBS_PER_MIN,
        windowMs: 60_000,
      })
    : rateLimit(`member-bytes:${member.loginId}`, { max: MEMBER_BYTES_PER_MIN, windowMs: 60_000 });
  if (gate.ok) return null;
  return NextResponse.json(
    { error: 'Too many requests. Try again shortly.', reason: 'rate-limit' },
    { status: 429, headers: { 'retry-after': String(gate.retryAfterSec) } },
  );
}

/**
 * A personal file's bytes as a response: streamed with safe download
 * headers, or with `?thumb=1` a JPEG thumbnail (images and PDFs; 404 when the
 * kind has none). The stream is closed when a thumbnail is answered instead.
 */
export async function spaceFileResponse(
  req: Request,
  opened: OpenedSpaceFile | null,
): Promise<Response> {
  if (!opened) return notFound();
  const { file, spaceId, stream, size } = opened;
  if (new URL(req.url).searchParams.get('thumb') === '1') {
    const chunks: Buffer[] = [];
    const etag = `"${file.sha256 ?? file.id}.thumb"`;
    if (req.headers.get('if-none-match') === etag) {
      stream.destroy();
      return new Response(null, { status: 304, headers: { etag } });
    }
    const thumb = await thumbnailFor({
      // Keyed by the node id inside the space's own folder (audit S9): a
      // private image's thumbnail never sits in the brain's shared cache,
      // and it is removed with the file.
      sha256: file.id,
      cacheDir: spaceThumbsDir(spaceId),
      mimeType: file.mimeType,
      // The size on disk: an oversized source is refused before any read.
      sizeBytes: size,
      loadBytes: async () => {
        for await (const c of stream) chunks.push(c as Buffer);
        return Buffer.concat(chunks);
      },
    });
    stream.destroy();
    if (!thumb) return NextResponse.json({ error: 'no thumbnail' }, { status: 404 });
    return new Response(new Uint8Array(thumb), {
      status: 200,
      headers: {
        'content-type': 'image/jpeg',
        'content-length': String(thumb.byteLength),
        etag,
        'cache-control': 'private, max-age=3600',
      },
    });
  }
  const web = Readable.toWeb(stream) as unknown as NodeReadableStream<Uint8Array>;
  return new NextResponse(web as unknown as ReadableStream, {
    status: 200,
    headers: {
      ...safeDownloadHeaders(file.mimeType, file.filename),
      'content-length': String(size),
      'cache-control': 'private, no-store',
    },
  });
}
