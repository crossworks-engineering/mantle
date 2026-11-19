/**
 * POST /api/sidecar/mail/attachment?accountId= (Sync service plan M2;
 * docs/email-ingest.md): one attachment of a large message (past
 * MAIL_MESSAGE_MAX_BYTES), its bytes as the raw body, streamed by the Sync
 * sidecar as it reads the message. Spooled to disk with its sha256 under the
 * streamed upload cap (maxStreamedUploadBytes), then stored in the object
 * store under its content address, streamed again: memory stays flat at any
 * size. Answers `{ sha256, size }`; the message then posts naming it
 * (`staged`, ingest/route.ts), and only then does any row point at it. The
 * bytes of a message that never posts are an object no row names, which the
 * files store already allows (file-broker.ts).
 */
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { NextResponse } from '@/server/http-compat';
import { UUID_RE } from '@mantle/std';
import { mailboxOf } from '@mantle/email';
import {
  discardSpooled,
  maxStreamedUploadBytes,
  spoolUpload,
  UploadTooLargeError,
} from '@mantle/files';
import { stageSpooledObject } from '@mantle/files/broker';
import { routePolicy } from '@/lib/auth/route-declaration';
import { asSidecar, sidecarOwner, sidecarRequestRefusal } from '@/lib/sidecar';

export const policy = routePolicy({
  // No rate limit, as the gateway's routes (gateway/registry/route.ts says
  // why): the token is checked first and a refusal does no work.
  POST: {
    class: 'public',
    item: { none: "a public route: it judges its own credential (the Sync sidecar's token)" },
  },
});

export async function POST(req: Request) {
  const refused = sidecarRequestRefusal(req);
  if (refused) return refused;
  const q = new URL(req.url).searchParams;
  const accountId = q.get('accountId') ?? '';
  const mime = (q.get('mime') ?? '').slice(0, 255) || 'application/octet-stream';
  if (!UUID_RE.test(accountId) || !req.body) {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }
  const account = await asSidecar(async () => mailboxOf(await sidecarOwner(), accountId));
  if (!account || !account.enabled) {
    await req.body.cancel().catch(() => {});
    return NextResponse.json({ error: 'no such mailbox' }, { status: 404 });
  }
  let spooled;
  try {
    spooled = await spoolUpload(
      Readable.fromWeb(req.body as unknown as NodeReadableStream<Uint8Array>),
      { maxBytes: maxStreamedUploadBytes() },
    );
  } catch (err) {
    if (err instanceof UploadTooLargeError) {
      return NextResponse.json({ error: 'attachment too large' }, { status: 413 });
    }
    throw err;
  }
  try {
    await stageSpooledObject(spooled, mime);
    return NextResponse.json({ sha256: spooled.sha256, size: spooled.size });
  } finally {
    await discardSpooled(spooled);
  }
}
