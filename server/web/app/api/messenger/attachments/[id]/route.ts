import { NextResponse } from '@/server/http-compat';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { anyLoginAssetCaller } from '@/lib/auth';
import { messengerActorOf, openMessengerAttachment } from '@/lib/messenger';
import { safeDownloadHeaders } from '@mantle/client-types/lib/safe-download';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  GET: { class: 'self', scope: null, open: 'any', limits: { rateLimit: ['messengerRead'] } },
});

/** GET /api/messenger/attachments/:id: a file's bytes, for who reads its
 *  line (an unsent one: its uploader). An <img src>, so it takes the
 *  login's `?at=` asset token (auth-constants isAssetPath). Anyone else
 *  hears the one 404. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const login = anyLoginAssetCaller();
  const { id } = await ctx.params;
  const file = await openMessengerAttachment(messengerActorOf(login), id);
  if (!file) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const web = Readable.toWeb(file.body) as unknown as NodeReadableStream<Uint8Array>;
  return new Response(web as unknown as ReadableStream, {
    status: 200,
    headers: {
      ...safeDownloadHeaders(file.mime, file.name),
      'content-length': String(file.bytes),
    },
  });
}
