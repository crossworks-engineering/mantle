import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOwnerOr401 } from '@/lib/auth';
import { resolveExport, getPage } from '@mantle/content';
import { readFileById } from '@/lib/files';
import { safeDownloadHeaders } from '@/lib/safe-download';
import { renderUrlToPdf } from '@/lib/render-pdf';

const IdParams = z.object({ id: z.string().uuid() });
// Absent ⇒ docx (the original type-driven behavior; existing links keep working).
const Format = z.enum(['md', 'docx', 'pdf']);

/**
 * Download a content node. Format is chosen by `?format=`:
 *   - `md`   → Markdown (page/note)      — text/markdown
 *   - `docx` → Word (page/note), default — via resolveExport
 *   - `pdf`  → PDF (page only)           — headless Chromium over /print
 * Tables ignore `format` and always export .xlsx. Bytes are generated on the
 * fly — nothing is persisted (the agent `export_node` tool is the save path).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getOwnerOr401();
  if (user instanceof Response) return user;
  const parsed = IdParams.safeParse(await ctx.params);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }
  const id = parsed.data.id;

  const fmt = Format.safeParse(new URL(req.url).searchParams.get('format') ?? 'docx');
  if (!fmt.success) {
    return NextResponse.json({ error: 'invalid format' }, { status: 400 });
  }

  // PDF: rendered in-process by headless Chromium against the live, owner-authed
  // /print surface — highest fidelity to the on-screen page. Pages only.
  if (fmt.data === 'pdf') {
    const page = await getPage(user.id, id);
    if (!page) {
      return NextResponse.json({ error: 'not found or not a page' }, { status: 404 });
    }
    // Navigate Chromium to the app on loopback (same container), NOT the public
    // origin — that would round-trip out through Caddy/Tailscale + TLS. The
    // print route is served by this same Next server; we force the caller's
    // session cookie via a header (below), so host-scoped cookie rules don't
    // matter. PORT matches how the server was started (Dockerfile ENV / dev).
    const port = process.env.PORT || '3000';
    const cookie = req.headers.get('cookie') ?? '';
    const bytes = await renderUrlToPdf(`http://127.0.0.1:${port}/print/pages/${id}`, cookie);
    return download(bytes, 'application/pdf', `${slugify(page.title)}.pdf`);
  }

  // md / docx (and xlsx for tables) go through the shared, browser-free resolver.
  const result = await resolveExport(user.id, id, {
    format: fmt.data === 'md' ? 'md' : 'docx',
    // Embed page images by reading their bytes from the file store.
    loadImage: async (fileId) => {
      const res = await readFileById({ ownerId: user.id, fileId });
      return res ? { bytes: res.bytes } : null;
    },
  });
  if (!result) {
    return NextResponse.json({ error: 'not found or not exportable' }, { status: 404 });
  }

  return download(result.bytes, result.mimeType, result.filename);
}

function download(bytes: Buffer | Uint8Array, mimeType: string, filename: string): Response {
  // Copy into a plain Uint8Array — a Node Buffer isn't a valid BodyInit.
  const body = new Uint8Array(bytes);
  return new Response(body, {
    status: 200,
    headers: {
      ...safeDownloadHeaders(mimeType, filename),
      'content-length': String(body.byteLength),
    },
  });
}

/** title → safe basename stem (mirrors resolveExport's slug for the PDF path). */
function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug || 'export';
}
