/**
 * /api/apps/[id]/bundle/css — the app's compiled per-app stylesheet (the
 * Tailwind utilities its own source uses; see @mantle/app-build css.ts). The
 * AppSandbox fetches this alongside /bundle and inlines it into the srcdoc.
 * 404 when the build predates per-app CSS or the CSS compile was skipped —
 * the sandbox treats that as "host stylesheet only".
 */
import { NextResponse } from '@/server/http-compat';
import { Readable } from 'node:stream';
import { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { getOwnerOr401 } from '@/lib/auth';
import { getApp } from '@mantle/content';
import { getContent } from '@mantle/storage';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const { id } = await ctx.params;
  const app = await getApp(user.id, id);
  if (!app) return new NextResponse('not found', { status: 404 });

  const build = app.draftBuild?.ok
    ? app.draftBuild
    : app.publishedBuild?.ok
      ? app.publishedBuild
      : null;
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
