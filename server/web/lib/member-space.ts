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
import { thumbnailFor } from '@mantle/files';
import { safeDownloadHeaders } from '@mantle/client-types/lib/safe-download';
import type { OpenedSpaceFile } from '@mantle/content';
import { withSpace } from '@mantle/db';
import { SCENE_SVG_MAX_BYTES, SpaceItemStateError, sceneWithinLimits } from '@mantle/content';
import type { MemberCaller } from '@/lib/auth';
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
    const status = err.reason === 'not-found' ? 404 : 409;
    return NextResponse.json(
      { error: err.message, reason: err.reason, ...(err.ids.length ? { ids: err.ids } : {}) },
      { status },
    );
  }
  throw err;
}

export const notFound = () => NextResponse.json({ error: 'Not found.' }, { status: 404 });

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
  const { file, stream, size } = opened;
  if (new URL(req.url).searchParams.get('thumb') === '1') {
    const chunks: Buffer[] = [];
    const etag = `"${file.sha256 ?? file.id}.thumb"`;
    if (req.headers.get('if-none-match') === etag) {
      stream.destroy();
      return new Response(null, { status: 304, headers: { etag } });
    }
    const thumb = await thumbnailFor({
      sha256: file.sha256 ?? file.id,
      mimeType: file.mimeType,
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
