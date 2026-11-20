import { NextResponse } from '@/server/http-compat';
import { anyLoginCaller } from '@/lib/auth';
import { discardSpooled, sweepSpool } from '@mantle/files';
import { readMultipartUpload } from '@/lib/upload-stream';
import { messengerActorOf, uploadMessengerAttachment } from '@/lib/messenger';
import { MESSENGER_ATTACHMENT_MAX_BYTES } from '@mantle/content/messenger';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';
import type { MessengerAttachmentResponse } from '@mantle/client-types/dto/messenger';

export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  POST: {
    class: 'self',
    scope: null,
    open: 'any',
    item: { none: 'a file for a messenger line, not an item' },
    limits: { rateLimit: ['messengerWrite'] },
  },
});

/** POST /api/messenger/c/:id/attachments (multipart, one `file`): upload a
 *  file for a line I will send in this chat (fleet chat, plan section 8).
 *  A live participant only. At most 10 MB (413 past it), the task file
 *  types. Answers the file; its id goes in the send's `attachments`. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = anyLoginCaller();
  const { id } = await ctx.params;
  const contentType = req.headers.get('content-type') ?? '';
  if (!contentType.includes('multipart/form-data')) {
    return NextResponse.json({ error: 'send the file as multipart/form-data' }, { status: 400 });
  }
  void sweepSpool();
  // Over the cap: UploadTooLargeError, 413 with the cap, by the one table.
  const parsed = await readMultipartUpload(req, { maxBytes: MESSENGER_ATTACHMENT_MAX_BYTES });
  const upload = parsed.file;
  if (!upload) return NextResponse.json({ error: 'file required' }, { status: 400 });
  try {
    const attachment = await uploadMessengerAttachment(messengerActorOf(login), id, {
      filename: upload.filename,
      spooled: upload.spooled,
    });
    return NextResponse.json({ attachment } satisfies MessengerAttachmentResponse, {
      status: 201,
    });
  } finally {
    await discardSpooled(upload.spooled);
  }
}
