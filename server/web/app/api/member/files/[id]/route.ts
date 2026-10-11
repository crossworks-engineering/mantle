import { NextResponse } from '@/server/http-compat';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { z } from 'zod';
import { withViewer } from '@mantle/db';
import { thumbnailFor } from '@mantle/files';
import { safeDownloadHeaders } from '@mantle/client-types/lib/safe-download';
import { getMemberForAsset } from '@/lib/auth';
import { fileById, openFileById, readFileById } from '@/lib/files';
import { memberBytesGate } from '@/lib/member-space';

const IdParams = z.object({ id: z.string().uuid() });
/** A thumbnail is kept privately but revalidated on every use (its etag). */
const THUMB_CACHE = 'private, no-cache';

/**
 * GET /api/member/files/:id : a file's bytes for a MEMBER (member logins,
 * Phase 1). `?thumb=1` = a JPEG thumbnail. Auth: a member session or a member
 * `?at=` token (an <img> src cannot carry a bearer). Read in the member's
 * request scope (W7e): a file its workspaces hold (its own files are in its
 * private workspace since W6b); anything else is a 404. The bytes are
 * streamed, and the route is rate limited per login (429).
 *
 * @deprecated Workspaces W7e: GET /api/files/files/:id?raw=1 (and ?thumb=1)
 * serves every login in its scope (the same rule). Kept this release for an
 * older UI; it answers 410 once the UI pair has moved.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberForAsset(req);
  if (member instanceof Response) return member;
  const limited = memberBytesGate(req, member);
  if (limited) return limited;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const scope = { ownerId: member.anchorId, fileId: idParsed.data.id };
  // The member's own scope: the request's (the guard entered it), or built
  // here when the handler runs outside the route loader.
  const inScope = <T>(fn: () => Promise<T>) => withViewer('team', { login: member.loginId }, fn);

  if (new URL(req.url).searchParams.get('thumb') === '1') {
    const meta = await inScope(() => fileById(scope));
    if (!meta?.sha256) return NextResponse.json({ error: 'not found' }, { status: 404 });
    const etag = `"${meta.sha256}.thumb"`;
    if (req.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { etag, 'cache-control': THUMB_CACHE } });
    }
    const thumb = await thumbnailFor({
      sha256: meta.sha256,
      mimeType: meta.mimeType,
      loadBytes: async () => (await inScope(() => readFileById(scope)))?.bytes ?? null,
    });
    if (!thumb) return NextResponse.json({ error: 'no thumbnail' }, { status: 404 });
    return new Response(new Uint8Array(thumb), {
      status: 200,
      headers: {
        'content-type': 'image/jpeg',
        'content-length': String(thumb.byteLength),
        etag,
        // Revalidated on every use, after the scoped lookup (W7e fix round 1).
        'cache-control': THUMB_CACHE,
      },
    });
  }

  const opened = await inScope(() => openFileById(scope));
  if (!opened) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const web = Readable.toWeb(opened.stream) as unknown as NodeReadableStream<Uint8Array>;
  return new NextResponse(web as unknown as ReadableStream, {
    status: 200,
    headers: {
      ...safeDownloadHeaders(opened.row.mimeType, opened.row.filename),
      'content-length': String(opened.size),
      // Never kept by a shared cache or the browser (W7e fix round 1, L2).
      'cache-control': 'private, no-store',
    },
  });
}
