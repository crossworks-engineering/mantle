import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401, getOwnerForAsset } from '@/lib/auth';
import { loadPreferencesFor, savePreferencesFor, projectAvatarPhotoType } from '@mantle/content';
import { putContent, deleteContent, getContent } from '@mantle/storage';
import { sniffType, LOGO_MAX_BYTES } from '@/lib/logo-validation';

/**
 * The user's PROFILE PHOTO — an uploaded, pre-cropped square raster that
 * clients show instead of the generated avatar (photo → generated seed →
 * initials). PERSONAL, like avatarSeed: each login has its own, set only from
 * Settings → Profile, and agents never have one.
 *
 * PUT (multipart `file`) / DELETE — the logo route's upload pattern
 * (server/web/app/api/profile/logo), minus everything SVG: a photo is
 * png/jpeg/webp only, so the active-content problem class doesn't exist here.
 * Bytes land content-addressed via @mantle/storage; prefs store only the
 * validated {key, type} pointer pair — on the CALLER's own row
 * (savePreferencesFor routes personal keys there), never the brand anchor.
 *
 * GET — PRIVATE serve, unlike the public logo route: cookie session or the
 * short-lived `?at=` asset token (getOwnerForAsset), the same way a detached
 * client's <img> loads any other owner-scoped bytes. The key is sha-addressed
 * so `immutable` caching is safe with the `?v=<sha8>` clients append — but
 * `private`, so no shared cache ever holds a face.
 *
 * Cleanup on replace/delete is best-effort and guarded: content-addressed
 * keys are SHARED by identical bytes, so the old photo's bytes are only
 * deleted when nothing else this row points at still uses them (the new
 * photo, or either brand logo variant — far-fetched, but a delete that can
 * take the brain's logo with it is not a risk worth a saved branch).
 */

function staleKey(prev: {
  replaced?: string;
  keepers: (string | undefined)[];
}): string | undefined {
  const { replaced, keepers } = prev;
  if (!replaced) return undefined;
  return keepers.includes(replaced) ? undefined : replaced;
}

export async function PUT(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;

  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'multipart field `file` required' }, { status: 400 });
  }
  if (file.size > LOGO_MAX_BYTES) {
    return NextResponse.json(
      { error: `photo must be under ${Math.floor(LOGO_MAX_BYTES / 1024)}KB — crop before upload` },
      { status: 413 },
    );
  }
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length === 0) {
    return NextResponse.json({ error: 'empty file' }, { status: 400 });
  }

  // Sniff the BYTES, then re-project: the photo allowlist is the raster
  // subset, so an SVG (which sniffType knows) falls out here.
  const type = projectAvatarPhotoType(sniffType(buf));
  if (!type) {
    return NextResponse.json(
      { error: 'unsupported image — use PNG, JPEG or WebP' },
      { status: 415 },
    );
  }

  const prev = await loadPreferencesFor(user.id);
  const { key, sha256 } = await putContent(buf, type);
  await savePreferencesFor(user.id, { avatarPhotoKey: key, avatarPhotoType: type });
  const stale = staleKey({
    replaced: prev.avatarPhotoKey,
    keepers: [key, prev.logoKey, prev.logoDarkKey],
  });
  if (stale) await deleteContent(stale).catch(() => {});
  return NextResponse.json({ avatarPhotoVersion: sha256.slice(0, 8) });
}

export async function DELETE() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const prev = await loadPreferencesFor(user.id);
  // '' is the jsonb-merge "clear" write (projects to undefined on read).
  await savePreferencesFor(user.id, { avatarPhotoKey: '', avatarPhotoType: '' });
  const stale = staleKey({
    replaced: prev.avatarPhotoKey,
    keepers: [prev.logoKey, prev.logoDarkKey],
  });
  if (stale) await deleteContent(stale).catch(() => {});
  return NextResponse.json({ ok: true });
}

export async function GET(req: Request) {
  const user = await getOwnerForAsset(req);
  if (user instanceof Response) return user;
  const notFound = new Headers({ 'cache-control': 'no-store' });
  try {
    const prefs = await loadPreferencesFor(user.id);
    const key = prefs.avatarPhotoKey;
    const type = prefs.avatarPhotoType;
    if (!key || !type) {
      return new Response('Not found', { status: 404, headers: notFound });
    }
    const obj = await getContent(key);
    const headers = new Headers({
      'content-type': type,
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-disposition': 'inline',
    });
    if (obj.contentLength) headers.set('content-length', String(obj.contentLength));
    const webStream = Readable.toWeb(obj.body) as unknown as NodeReadableStream<Uint8Array>;
    return new Response(webStream as unknown as ReadableStream, { headers });
  } catch {
    // Storage unreachable / object gone — an avatar must never 500 the shell.
    return new Response('Not found', { status: 404, headers: notFound });
  }
}
