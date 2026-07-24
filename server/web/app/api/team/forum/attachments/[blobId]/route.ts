/**
 * GET /api/team/forum/attachments/[blobId] — member download of a forum
 * attachment.
 *
 * Attachments are member-visible IMMEDIATELY (decision locked with Jason:
 * review gates BRAIN INGESTION and owner triage, not member-to-member
 * distribution — a member could paste the same content as text). Authz:
 *   - staged blob (no post yet): the uploader only;
 *   - bound blob: anyone who can see its topic (getForumTopic, absent ==
 *     forbidden == uniform 404);
 *   - filed: streamed from the file node the owner created;
 *   - dismissed: bytes are gone → 404.
 * Always served with safeDownloadHeaders (stored XSS defense) + Range
 * support (audio/video seek) — the /s/[token]/a/[fileId] pattern.
 */
import { rateLimit } from '@/lib/rate-limit';
import { resolveTeamChatCaller } from '@/lib/team-chat-gate';
import { safeDownloadHeaders } from '@mantle/web-ui/lib/safe-download';
import { getForumTopic, getForumUpload, recordTeamAccess } from '@mantle/content';
import { readFileById, readQuarantineBytes } from '@mantle/files';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function notFound() {
  return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
}

export async function GET(req: Request, ctx: { params: Promise<{ blobId: string }> }) {
  const caller = await resolveTeamChatCaller(req);
  if (!caller) return new Response('Unauthorized', { status: 401 });
  const { ownerId, contactId } = caller;

  const { blobId } = await ctx.params;
  if (!UUID_RE.test(blobId)) return notFound();

  const gate = rateLimit(`forum-asset:${contactId}`, { max: 240, windowMs: 60_000 });
  if (!gate.ok) {
    // Log the denial for symmetry with the upload route (successful downloads
    // stay unlogged — 240/min would flood the access log).
    recordTeamAccess({
      ownerId,
      contactId,
      kind: 'denied',
      detail: { reason: 'rate_limit', surface: 'forum-attachment', blobId },
    });
    return new Response('Too many requests', {
      status: 429,
      headers: { 'retry-after': String(gate.retryAfterSec), 'cache-control': 'no-store' },
    });
  }

  const blob = await getForumUpload(ownerId, blobId);
  if (!blob) return notFound();

  if (blob.status === 'staged') {
    // Not yet on any post — only its uploader may fetch it (composer preview).
    if (blob.contactId !== contactId) return notFound();
  } else {
    if (!blob.topicId) return notFound();
    // Topic visibility is the whole rule; absent == forbidden, uniform 404.
    const topic = await getForumTopic(ownerId, blob.topicId, { kind: 'member', contactId });
    if (!topic) return notFound();
  }

  let bytes: Buffer | null = null;
  if (blob.status === 'filed' && blob.nodeId) {
    const filed = await readFileById({ ownerId, fileId: blob.nodeId });
    bytes = filed?.bytes ?? null;
  } else if (blob.status === 'staged' || blob.status === 'pending') {
    bytes = await readQuarantineBytes(ownerId, blobId);
  }
  if (!bytes) return notFound(); // dismissed, or bytes lost a race with review

  const total = bytes.byteLength;
  const base: Record<string, string> = {
    ...safeDownloadHeaders(blob.mime, blob.filename),
    'accept-ranges': 'bytes',
    // Private + short-lived: review can replace the backing bytes (filed) at
    // any time, and revocation must bite on the next request.
    'cache-control': 'private, max-age=300',
  };

  const range = req.headers.get('range');
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m) {
    let start: number;
    let end: number;
    if (m[1] === '' && m[2] !== '') {
      // Suffix form `bytes=-N`: the LAST N bytes (RFC 7233). Media players probe
      // a trailing atom this way — serving the first N here breaks seeking.
      const suffix = parseInt(m[2]!, 10);
      start = Number.isNaN(suffix) ? 0 : Math.max(0, total - suffix);
      end = total - 1;
    } else {
      start = m[1] ? parseInt(m[1], 10) : 0;
      end = m[2] ? parseInt(m[2], 10) : total - 1;
    }
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
      headers: {
        ...base,
        'content-range': `bytes ${start}-${end}/${total}`,
        'content-length': String(chunk.byteLength),
      },
    });
  }

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { ...base, 'content-length': String(total) },
  });
}
