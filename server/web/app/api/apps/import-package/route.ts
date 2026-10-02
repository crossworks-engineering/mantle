/**
 * POST /api/apps/import-package — make a NEW app from a `.mantleapp` file
 * (apps first-class plan, Phase 3). The body is the file itself (raw bytes,
 * e.g. `fetch(url, { method: 'POST', body: file })`), read under its own cap
 * (a full app database plus the code; lib/body-limit.ts lists the path as an
 * upload). Query: `title` names the new app; `data=0` leaves the data out.
 *
 * The package is checked whole before anything is written, then built and
 * published here when it was published where it came from
 * (@mantle/tools app-package-import.ts). Two imports at a time per process:
 * each holds its package in memory while it is read. Owner only.
 */
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { readBytesCapped } from '@/lib/body-limit';
import { AppPackageError, appPackageMaxBytes } from '@mantle/content/app-package';
import { importAppPackage } from '@mantle/tools';

const MAX_PARALLEL_IMPORTS = 2;
let running = 0;

export async function POST(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  if (running >= MAX_PARALLEL_IMPORTS) {
    return NextResponse.json(
      { error: 'another import is running: try again when it is done', reason: 'busy' },
      { status: 429, headers: { 'retry-after': '10' } },
    );
  }
  running++;
  try {
    const q = new URL(req.url).searchParams;
    const title = q.get('title')?.trim().slice(0, 200) || undefined;
    const bytes = await readBytesCapped(req, appPackageMaxBytes());
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
  } catch (err) {
    if (err instanceof AppPackageError) {
      return NextResponse.json({ error: err.message, reason: 'bad-package' }, { status: 400 });
    }
    throw err; // a body over the cap: app.onError answers 413
  } finally {
    running--;
  }
}
