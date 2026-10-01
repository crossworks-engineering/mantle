/**
 * GET /s/[token]/bundle/css — the shared app's per-app stylesheet, published
 * build only. Mirrors /s/[token]/bundle (same auth: the share token); 404 when the published build carries no CSS (pre-CSS
 * builds) — the sandbox then renders on the host stylesheet alone.
 */
import { contactCodeRequired, gateShare } from '@/lib/contact-share-gate';
import { NextResponse } from '@/server/http-compat';
import { Readable } from 'node:stream';
import { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { getApp } from '@mantle/content';
import { getContent } from '@mantle/storage';

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const gate = await gateShare(req, token);
  if (gate.kind === 'code') return contactCodeRequired();
  const share = gate.kind === 'ok' ? gate.share : null;
  if (!share || share.nodeType !== 'app') return new NextResponse('not found', { status: 404 });

  const app = await getApp(share.ownerId, share.nodeId);
  const build = app?.publishedBuild?.ok ? app.publishedBuild : null;
  if (!build?.css) return new NextResponse('no css', { status: 404 });

  const { body, contentLength } = await getContent(build.css.storageKey);
  const headers = new Headers({
    'content-type': 'text/css; charset=utf-8',
    'cache-control': 'private, max-age=300',
  });
  if (contentLength !== undefined) headers.set('content-length', String(contentLength));
  const webStream = Readable.toWeb(body) as unknown as NodeReadableStream<Uint8Array>;
  return new NextResponse(webStream as unknown as ReadableStream, { status: 200, headers });
}
