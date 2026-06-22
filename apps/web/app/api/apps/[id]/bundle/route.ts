/**
 * /api/apps/[id]/bundle — serve the app's current bundle JS. The host
 * AppSandbox fetches this (authenticated, same-origin) and inlines it into the
 * sandboxed iframe's srcdoc, so the opaque-origin iframe never needs to make an
 * authenticated request itself.
 *
 * Serves the DRAFT build when present (preview of unpublished work), else the
 * published build. 404 if the app has never built green.
 */
import { NextResponse } from 'next/server';
import { Readable } from 'node:stream';
import { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { requireOwner } from '@/lib/auth';
import { getApp } from '@mantle/content';
import { getContent } from '@mantle/storage';

export const runtime = 'nodejs';

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const { id } = await ctx.params;
  const app = await getApp(user.id, id);
  if (!app) return new NextResponse('not found', { status: 404 });

  const build = app.draftBuild?.ok ? app.draftBuild : app.publishedBuild?.ok ? app.publishedBuild : null;
  if (!build) return new NextResponse('no build', { status: 404 });

  const { body, contentLength } = await getContent(build.storageKey);
  const headers = new Headers({
    'content-type': 'application/javascript; charset=utf-8',
    // The bundle is content-addressed (sha in the key) — safe to cache hard,
    // but keep it private to the authenticated user.
    'cache-control': 'private, max-age=300',
  });
  if (contentLength !== undefined) headers.set('content-length', String(contentLength));
  const webStream = Readable.toWeb(body) as unknown as NodeReadableStream<Uint8Array>;
  return new NextResponse(webStream as unknown as ReadableStream, { status: 200, headers });
}
