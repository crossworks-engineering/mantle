/**
 * Owner-only: download a forum upload's bytes for review — straight from the
 * QUARANTINE while pending, or from the created file node once filed.
 * Session-gated (under /api/team-admin). Served with safeDownloadHeaders —
 * a member-uploaded HTML/SVG must not execute in the owner's origin either.
 */
import { getOwnerOr401 } from '@/lib/auth';
import { safeDownloadHeaders } from '@mantle/web-ui/lib/safe-download';
import { getForumUpload } from '@mantle/content';
import { readFileById, readQuarantineBytes } from '@mantle/files';


const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return new Response('Not found', { status: 404 });

  const blob = await getForumUpload(user.id, id);
  if (!blob) return new Response('Not found', { status: 404 });

  let bytes: Buffer | null = null;
  if (blob.status === 'filed' && blob.nodeId) {
    const filed = await readFileById({ ownerId: user.id, fileId: blob.nodeId });
    bytes = filed?.bytes ?? null;
  } else if (blob.status === 'staged' || blob.status === 'pending') {
    bytes = await readQuarantineBytes(user.id, id);
  }
  if (!bytes) return new Response('Not found', { status: 404 });

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      ...safeDownloadHeaders(blob.mime, blob.filename),
      'content-length': String(bytes.byteLength),
      'cache-control': 'no-store',
    },
  });
}
