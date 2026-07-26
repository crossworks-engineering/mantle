import { NextResponse } from '@/server/http-compat';
import { getOwnerOr401 } from '@/lib/auth';
import { loadProfilePreferences, updateProfilePreferences } from '@mantle/content';
import { putContent, deleteContent } from '@mantle/storage';
import { sniffType, SVG_ACTIVE_RE, LOGO_MAX_BYTES } from '@/lib/logo-validation';

/**
 * PUT /api/profile/logo (multipart `file`) / DELETE — the brand logo that
 * replaces the siteName wordmark in the owner and /team headers.
 *
 * Bytes land content-addressed in object storage (@mantle/storage putContent —
 * NOT the files system, so the logo is never a user-visible, user-deletable
 * file node), and prefs store only the validated {logoKey, logoType} pointer.
 * The sha in the key is the cache-busting version. Serving is the public
 * GET /api/appearance/logo.
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

  const prev = await loadProfilePreferences(user.id);
  const { key, sha256 } = await putContent(buf, type);
  await updateProfilePreferences(user.id, { logoKey: key, logoType: type });
  // Replaced a different logo: best-effort cleanup of the old bytes. Content-
  // addressed keys are shared by identical bytes, so only delete on change.
  if (prev.logoKey && prev.logoKey !== key) {
    await deleteContent(prev.logoKey).catch(() => {});
  }
  return NextResponse.json({ logoVersion: sha256.slice(0, 8), logoType: type });
}

export async function DELETE() {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const prev = await loadProfilePreferences(user.id);
  // '' is the jsonb-merge "clear" write (projects to undefined on read).
  await updateProfilePreferences(user.id, { logoKey: '', logoType: '' });
  if (prev.logoKey) await deleteContent(prev.logoKey).catch(() => {});
  return NextResponse.json({ ok: true });
}
