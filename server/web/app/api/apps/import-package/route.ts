/**
 * POST /api/apps/import-package — make a NEW app from a `.mantleapp` file.
 * The body is the file itself (raw bytes, e.g.
 * `fetch(url, { method: 'POST', body: file })`), read under its own cap
 * (a full app database plus the code; lib/body-limit.ts lists the path as an
 * upload). Query: `title` names the new app; `data=0` leaves the data out.
 *
 * The package is checked whole before anything is written, then built and
 * published here when it was published where it came from
 * (@mantle/tools app-package-import.ts). Two imports at a time per process,
 * shared with the app_import tool (takeAppImportSlot): each holds its package
 * in memory while it is read. The body streams to a spool file first and is
 * read back in one piece, so the route never holds the chunks AND the whole
 * (apps audit 2026-10-02, item 13). Owner only.
 */
import { readFile, rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebStream } from 'node:stream/web';
import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import { BodyTooLargeError } from '@/lib/body-limit';
import { appPackageMaxBytes, takeAppImportSlot } from '@mantle/content/app-package';
import { spoolUpload, UploadTooLargeError } from '@mantle/files';
import { importAppPackage } from '@mantle/tools';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  POST: { class: 'content', item: { none: 'names no item in its path' } },
});

export async function POST(req: Request) {
  const user = ownerCaller();
  const release = takeAppImportSlot();
  if (!release) {
    return NextResponse.json(
      { error: 'another import is running: try again when it is done', reason: 'busy' },
      { status: 429, headers: { 'retry-after': '10' } },
    );
  }
  let spooled: string | null = null;
  try {
    const q = new URL(req.url).searchParams;
    const title = q.get('title')?.trim().slice(0, 200) || undefined;
    const max = appPackageMaxBytes();
    const declared = Number(req.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > max) throw new BodyTooLargeError(max);
    if (!req.body) return NextResponse.json({ error: 'no file sent' }, { status: 400 });
    try {
      const up = await spoolUpload(Readable.fromWeb(req.body as NodeWebStream<Uint8Array>), {
        maxBytes: max,
      });
      spooled = up.tempPath;
    } catch (err) {
      if (err instanceof UploadTooLargeError) throw new BodyTooLargeError(max);
      throw err;
    }
    const bytes = await readFile(spooled);
    if (bytes.length === 0) return NextResponse.json({ error: 'no file sent' }, { status: 400 });
    const result = await importAppPackage(user.id, bytes, {
      ...(title ? { title } : {}),
      withData: q.get('data') !== '0',
      actor: 'owner',
    });
    return NextResponse.json(
      { ok: true, ...result, reviewUrl: `/apps/${result.appId}` },
      { status: 201 },
    );
  } finally {
    // A bad package (AppPackageError) answers 400, reason 'bad-package', by
    // the one table; a body over the cap 413 (app.onError).
    if (spooled) await rm(spooled, { force: true });
    release();
  }
}
