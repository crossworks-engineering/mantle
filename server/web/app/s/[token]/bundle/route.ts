/**
 * GET /s/[token]/bundle — serve a SHARED app's published bundle JS to an
 * unauthenticated viewer. The share token is the auth: it resolves to an active
 * 'app' share, and we serve only the app's PUBLISHED build (never a draft).
 * Mirrors /api/apps/[id]/bundle but owner comes from the share row, not a session.
 */
import { NextResponse } from 'next/server';
import { Readable } from 'node:stream';
import { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { resolveActiveShareByToken } from '@/lib/shares';
import { getApp } from '@mantle/content';
import { getContent } from '@mantle/storage';
import { resolveShareVisitorFromRequest } from '@/lib/team-gate';

export const runtime = 'nodejs';

export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const share = await resolveActiveShareByToken(token);
  if (!share || share.nodeType !== 'app') return new NextResponse('not found', { status: 404 });

  // Team-mode shares don't serve code to strangers either — the bundle can
  // embed the operator's copy, layout, and data shapes.
  const visitor = await resolveShareVisitorFromRequest(req, share);
  if (!visitor) return new NextResponse('team session required', { status: 401 });

  const app = await getApp(share.ownerId, share.nodeId);
  const build = app?.publishedBuild?.ok ? app.publishedBuild : null;
  if (!build) return new NextResponse('no build', { status: 404 });

  const { body, contentLength } = await getContent(build.storageKey);
  const headers = new Headers({
    'content-type': 'application/javascript; charset=utf-8',
    // Content-addressed (sha in the key); cache hard but keep private.
    'cache-control': 'private, max-age=300',
  });
  if (contentLength !== undefined) headers.set('content-length', String(contentLength));
  const webStream = Readable.toWeb(body) as unknown as NodeReadableStream<Uint8Array>;
  return new NextResponse(webStream as unknown as ReadableStream, { status: 200, headers });
}
