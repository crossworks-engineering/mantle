import { resolveActiveShareByToken, isAssetAllowed } from '@/lib/shares';
import { readFileById } from '@/lib/files';
import { rateLimit, clientIp } from '@/lib/rate-limit';

/**
 * Public asset bytes for a shared node. Authorization = the token must be
 * active AND `fileId` must be in the share's allowed set (the file itself for a
 * file share; the files a page's doc references for a page share). Everything
 * else 404s. Supports Range requests so shared video/audio can seek.
 */
export const dynamic = 'force-dynamic';

function notFound() {
  return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ token: string; fileId: string }> },
) {
  const { token, fileId } = await params;

  const { ok, retryAfterSec } = rateLimit(`share-asset:${clientIp(req)}`, {
    max: 240,
    windowMs: 60_000,
  });
  if (!ok) {
    return new Response('Too many requests', {
      status: 429,
      headers: { 'retry-after': String(retryAfterSec), 'cache-control': 'no-store' },
    });
  }

  const share = await resolveActiveShareByToken(token);
  if (!share) return notFound();
  if (!(await isAssetAllowed(share, fileId))) return notFound();

  const res = await readFileById({ ownerId: share.ownerId, fileId });
  if (!res) return notFound();

  const bytes = res.bytes;
  const total = bytes.byteLength;
  const filename = res.row.filename.replace(/["\\\r\n]/g, '');
  const base: Record<string, string> = {
    'content-type': res.row.mimeType || 'application/octet-stream',
    'content-disposition': `inline; filename="${filename}"`,
    'accept-ranges': 'bytes',
    // Private + short: browser may cache, shared caches won't; a revoked link
    // 404s on the next request regardless (token is in the path).
    'cache-control': 'private, max-age=300',
  };

  const range = req.headers.get('range');
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m) {
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : total - 1;
    if (Number.isNaN(start)) start = 0;
    if (Number.isNaN(end) || end >= total) end = total - 1;
    if (start > end || start >= total) {
      return new Response('Range not satisfiable', {
        status: 416,
        headers: { 'content-range': `bytes */${total}` },
      });
    }
    const chunk = bytes.subarray(start, end + 1);
    return new Response(new Uint8Array(chunk), {
      status: 206,
      headers: { ...base, 'content-range': `bytes ${start}-${end}/${total}`, 'content-length': String(chunk.byteLength) },
    });
  }

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { ...base, 'content-length': String(total) },
  });
}
