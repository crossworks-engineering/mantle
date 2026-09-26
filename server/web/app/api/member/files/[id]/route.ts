import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { withViewer } from '@mantle/db';
import { thumbnailFor } from '@mantle/files';
import { safeDownloadHeaders } from '@mantle/client-types/lib/safe-download';
import { getMemberForAsset } from '@/lib/auth';
import { fileById, readFileById } from '@/lib/files';

const IdParams = z.object({ id: z.string().uuid() });

/**
 * GET /api/member/files/:id : a file's bytes for a MEMBER (member logins,
 * Phase 1). `?thumb=1` = a JPEG thumbnail. Auth: a member session or a member
 * `?at=` token (an <img> src cannot carry a bearer). The lookup runs at the
 * team level, so a file above it is a 404.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const member = await getMemberForAsset(req);
  if (member instanceof Response) return member;
  const idParsed = IdParams.safeParse(await ctx.params);
  if (!idParsed.success) return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  const scope = { ownerId: member.anchorId, fileId: idParsed.data.id };

  if (new URL(req.url).searchParams.get('thumb') === '1') {
    const meta = await withViewer('team', () => fileById(scope));
    if (!meta?.sha256) return NextResponse.json({ error: 'not found' }, { status: 404 });
    const etag = `"${meta.sha256}.thumb"`;
    if (req.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { etag } });
    }
    const thumb = await thumbnailFor({
      sha256: meta.sha256,
      mimeType: meta.mimeType,
      loadBytes: async () => {
        const res = await withViewer('team', () => readFileById(scope));
        return res ? res.bytes : null;
      },
    });
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

  const res = await withViewer('team', () => readFileById(scope));
  if (!res) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return new Response(new Uint8Array(res.bytes), {
    status: 200,
    headers: {
      ...safeDownloadHeaders(res.row.mimeType, res.row.filename),
      'content-length': String(res.bytes.byteLength),
    },
  });
}
