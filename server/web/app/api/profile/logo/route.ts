import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { loadPreferencesFor, savePreferencesFor } from '@mantle/content';
import { putContent, deleteContent } from '@mantle/storage';
import { sniffType, staleLogoBytes, SVG_ACTIVE_RE, LOGO_MAX_BYTES } from '@/lib/logo-validation';

/**
 * PUT /api/profile/logo (multipart `file`) / DELETE — the brand logo that
 * replaces the siteName wordmark in the owner and /team headers.
 *
 * `?variant=dark` addresses the optional DARK-MODE variant; the default (or
 * `?variant=light`) is the base logo. The base is what renders everywhere; the
 * dark variant only overrides it while the UI is in dark mode, so a brain with
 * one logo that works on both themes never needs the second upload. Each
 * variant is set/cleared independently.
 *
 * Bytes land content-addressed in object storage (@mantle/storage putContent —
 * NOT the files system, so the logo is never a user-visible, user-deletable
 * file node), and prefs store only the validated {key, type} pointer pair —
 * BRAIN-level, so savePreferencesFor writes it to the shared anchor row that
 * the public serve route reads. (Before that split a second admin's upload set
 * a logoVersion on their own row while the bytes resolved from the anchor's:
 * a broken image in their header, invisible to everyone else.)
 * The sha in the key is the cache-busting version. Serving is the public
 * GET /api/appearance/logo (?variant=dark for the dark bytes).
 *
 * ⚠ Content-addressed keys are SHARED by identical bytes — including across
 * the two variants (uploading the same file as both is legal). So byte cleanup
 * must never delete a key the OTHER variant still points at, on replace and on
 * delete alike.
 *
 * Validation is defense for the PUBLIC serve route:
 *  - type allowlist (svg/png/jpeg/webp) checked against the BYTES, not the
 *    browser's claimed type — magic numbers for the rasters, a root <svg
 *    element for svg;
 *  - SVG active-content guard: reject script elements/handlers/javascript:
 *    hrefs/foreignObject outright. The serve route also sandboxes via CSP,
 *    but a brand asset with active content is garbage input, not a render
 *    problem to mitigate.
 *  - 512KB cap — a header logo, not an artwork archive.
 *
 * The byte validators live in lib/logo-validation.ts (unit-tested there).
 */

function isDark(req: Request): boolean {
  return new URL(req.url).searchParams.get('variant') === 'dark';
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
      { error: `logo must be under ${Math.floor(LOGO_MAX_BYTES / 1024)}KB` },
      { status: 413 },
    );
  }
  const buf = Buffer.from(await file.arrayBuffer());
  if (buf.length === 0) {
    return NextResponse.json({ error: 'empty file' }, { status: 400 });
  }

  const type = sniffType(buf);
  if (!type) {
    return NextResponse.json(
      { error: 'unsupported image — use SVG, PNG, JPEG or WebP' },
      { status: 415 },
    );
  }
  if (type === 'image/svg+xml' && SVG_ACTIVE_RE.test(buf.toString('utf8'))) {
    return NextResponse.json(
      { error: 'SVG contains active content (scripts/handlers) — export a plain vector' },
      { status: 422 },
    );
  }

  const dark = isDark(req);
  const prev = await loadPreferencesFor(user.id);
  const { key, sha256 } = await putContent(buf, type);
  await savePreferencesFor(
    user.id,
    dark ? { logoDarkKey: key, logoDarkType: type } : { logoKey: key, logoType: type },
  );
  // Replaced a different logo: best-effort cleanup of the old bytes — but
  // only when neither the new upload NOR the other variant still uses them
  // (content-addressed keys are shared by identical bytes; staleLogoBytes is
  // the unit-tested predicate).
  const stale = staleLogoBytes({
    replaced: dark ? prev.logoDarkKey : prev.logoKey,
    newKey: key,
    otherKey: dark ? prev.logoKey : prev.logoDarkKey,
  });
  if (stale) await deleteContent(stale).catch(() => {});
  return NextResponse.json({ logoVersion: sha256.slice(0, 8), logoType: type });
}

export async function DELETE(req: Request) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const dark = isDark(req);
  const prev = await loadPreferencesFor(user.id);
  // '' is the jsonb-merge "clear" write (projects to undefined on read).
  await savePreferencesFor(
    user.id,
    dark ? { logoDarkKey: '', logoDarkType: '' } : { logoKey: '', logoType: '' },
  );
  const stale = staleLogoBytes({
    replaced: dark ? prev.logoDarkKey : prev.logoKey,
    otherKey: dark ? prev.logoKey : prev.logoDarkKey,
  });
  if (stale) await deleteContent(stale).catch(() => {});
  return NextResponse.json({ ok: true });
}
