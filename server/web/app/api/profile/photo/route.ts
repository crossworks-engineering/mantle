import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { NextResponse } from '@/server/http-compat';
import { ownerAssetCaller, ownerCaller } from '@/lib/auth';
import { loadPreferencesFor, savePreferencesFor, projectAvatarPhotoType } from '@mantle/content';
import { getContent } from '@mantle/storage';
import { putContent } from '@mantle/storage/write';
import { sniffType, LOGO_MAX_BYTES } from '@/lib/logo-validation';
import { CACHE_CONTROL } from '@/lib/cache-control';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'self' },
  PUT: { class: 'self', item: { none: "the login's own things, not an item" } },
  DELETE: { class: 'self', item: { none: "the login's own things, not an item" } },
});

/**
 * The user's PROFILE PHOTO — an uploaded, pre-cropped square raster that
 * clients show instead of the generated avatar (photo → generated seed →
 * initials). PER-LOGIN: these routes address preferences by the ACTOR's id,
 * so on a multi-admin brain each login keeps its own face (savePreferencesFor
 * routes personal keys to that row and brain keys to the anchor). Set only
 * from Settings → Profile; agents never have one.
 *
 * PUT (multipart `file`) / DELETE — the logo route's upload pattern
 * (server/web/app/api/profile/logo), minus everything SVG: a photo is
 * png/jpeg/webp only, so the active-content problem class doesn't exist here.
 * Bytes land content-addressed via @mantle/storage; prefs store only the
 * validated {key, type} pointer pair.
 *
 * Replaced/removed photo BYTES are deliberately NOT deleted. putContent's
 * namespace is content-addressed across the WHOLE brain — email attachments,
 * drive mirrors, logos and app assets dedupe into the same keys — so no
 * pointer-local keeper list can know every row that still references an
 * object, and deleting on replace once meant an email attachment 404ing
 * because its bytes doubled as somebody's photo. Orphans are ≤512KB each and
 * rare; reclaiming them belongs to a global GC that scans all pointer
 * columns, not to this route.
 *
 * GET — PRIVATE serve, unlike the public logo route: cookie session or the
 * short-lived `?at=` asset token (ownerAssetCaller, the gate's answer of
 * getOwnerForAsset; the token carries the
 * actor claim so a detached second login sees its own face). The key is
 * sha-addressed so `immutable` caching is safe with the `?v=<sha8>` clients
 * append — but `private`, so no shared cache ever holds a face. The CSP
 * mirrors the logo route: defense-in-depth over the magic-number sniff, so
 * even a sniff-passing polyglot opened as a document can run nothing.
 */

export async function PUT(req: Request) {
  const user = ownerCaller();

  // A body over twice the cap never reaches here: the gate refuses a
  // declared length over the route's ceiling (PROFILE_IMAGE_BODY_BYTES,
  // lib/body-limit.ts) and the loader stops a longer stream there, both
  // with the one 413. A file under the ceiling but over the cap gets this
  // route's own words below.
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

  const { key, sha256 } = await putContent(buf, type);
  await savePreferencesFor(user.actor.id, { avatarPhotoKey: key, avatarPhotoType: type });
  return NextResponse.json({ avatarPhotoVersion: sha256.slice(0, 8) });
}

export async function DELETE() {
  const user = ownerCaller();
  // '' is the jsonb-merge "clear" write (projects to undefined on read).
  await savePreferencesFor(user.actor.id, { avatarPhotoKey: '', avatarPhotoType: '' });
  return NextResponse.json({ ok: true });
}

export async function GET() {
  const user = ownerAssetCaller();
  const notFound = new Headers();
  try {
    const prefs = await loadPreferencesFor(user.actor.id);
    const key = prefs.avatarPhotoKey;
    const type = prefs.avatarPhotoType;
    if (!key || !type) {
      return new Response('Not found', { status: 404, headers: notFound });
    }
    const obj = await getContent(key);
    const headers = new Headers({
      'content-type': type,
      'Cache-Control': CACHE_CONTROL.privateImmutable,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
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
