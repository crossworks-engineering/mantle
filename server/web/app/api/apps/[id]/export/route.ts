/**
 * GET /api/apps/[id]/export — the app as a `.mantleapp` file (apps
 * first-class plan, Phase 3): a zip of its code and, unless `?data=0`, a copy
 * of its database. Written to a work file first, then streamed; the work file
 * goes when the download ends. Owner only. 409 when the app's database file
 * is lost (export with `?data=0` then). Format: @mantle/content/app-package.
 */
import { createReadStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { NextResponse } from '@/server/http-compat';
import { ownerCaller } from '@/lib/auth';
import {
  appPackageFileName,
  appPackageTempPath,
  writeAppPackage,
} from '@mantle/content/app-package';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'content' },
});

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const withData = new URL(req.url).searchParams.get('data') !== '0';
  const file = await appPackageTempPath('.mantleapp');
  let written;
  try {
    written = await writeAppPackage(user.id, id, file, { withData });
  } catch (err) {
    // The work file goes; a lost database file (AppDbMissingError) answers
    // 409, reason 'db-missing', by the one table.
    await rm(file, { force: true });
    throw err;
  }
  if (!written) {
    await rm(file, { force: true });
    return NextResponse.json({ error: 'app not found' }, { status: 404 });
  }
  const stream = createReadStream(file);
  stream.once('close', () => void rm(file, { force: true }));
  const web = Readable.toWeb(stream) as unknown as NodeReadableStream<Uint8Array>;
  return new NextResponse(web as unknown as ReadableStream, {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${appPackageFileName(written.title)}"`,
      'content-length': String(written.bytes),
    },
  });
}
