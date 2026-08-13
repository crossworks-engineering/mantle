import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { buildInternalRenderCookie, getOwnerForAsset } from '@/lib/auth';
import { resolveExport, getPage, getDraw, referencedDrawIds } from '@mantle/content';
import { getDrawSvgOrRender, getDrawPngOrRender } from '@/lib/draw-snapshot';
import { readFileById } from '@/lib/files';
import { safeDownloadHeaders } from '@mantle/client-types/lib/safe-download';
import { renderUrlToPdf, printOrigin, PdfRendererUnavailableError } from '@/lib/render-pdf';
import { slugify } from '@mantle/client-types/slugify';

const IdParams = z.object({ id: z.string().uuid() });
// Absent ⇒ docx (the original type-driven behavior; existing links keep working).
const Format = z.enum(['md', 'docx', 'pdf', 'csv', 'xlsx', 'svg']);

/**
 * Download a content node. Format is chosen by `?format=`:
 *   - `md`   → Markdown (page/note markdown, or a table's GFM pipe-table)
 *   - `docx` → Word (page/note), default
 *   - `pdf`  → PDF (page, or a draw's committed snapshot) — headless Chromium
 *              over /print
 *   - `csv`  → CSV (table)
 *   - `xlsx` → Excel (table, the table default)
 *   - `svg`  → SVG (a draw's committed snapshot, the draw default)
 * Each kind serves the formats it supports and falls back to its default for
 * the rest (a table asked for docx → xlsx; a page asked for csv → docx). Bytes
 * are generated on the fly — nothing is persisted (the agent `export_node` tool
 * is the save path).
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  // getOwnerForAsset (not getOwnerOr401): these downloads are plain <a href>
  // anchors that can't carry a bearer, so a detached client authenticates via
  // the `?at=` asset token (see ExportMenu → assetUrl). Session still wins.
  const user = await getOwnerForAsset(req);
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
  // /print surface — highest fidelity to the on-screen page. Pages and draws.
  if (fmt.data === 'pdf') {
    // Draws print their committed SVG snapshot via /print/draws — same
    // sidecar, no Excalidraw involvement there (the snapshot is already
    // pixels-ready). Filling first means an export works even for a drawing no
    // browser ever committed. Non-draws return null immediately.
    const drawSvg = await getDrawSvgOrRender(user.id, id);
    if (drawSvg !== null) {
      const cookie = buildInternalRenderCookie(user.id);
      try {
        const bytes = await renderUrlToPdf(`${printOrigin()}/print/draws/${id}`, cookie);
        const title = (await getDraw(user.id, id))?.title ?? 'drawing';
        return download(
          bytes,
          'application/pdf',
          `${slugify(title, { maxLength: 80, fallback: 'drawing' })}.pdf`,
        );
      } catch (e) {
        if (e instanceof PdfRendererUnavailableError) {
          console.error('[export] pdf renderer unavailable:', e.message);
          return NextResponse.json({ error: e.message }, { status: 503 });
        }
        throw e;
      }
    }
    const page = await getPage(user.id, id);
    if (!page) {
      // Reached by a draw with no committed snapshot too, so the message names
      // both: "not a page" alone sent people looking in the wrong place.
      return NextResponse.json(
        { error: 'not found: not a page, or a drawing with nothing committed yet' },
        { status: 404 },
      );
    }
    // Warm the snapshot cache for every drawing this page embeds, BEFORE the
    // sidecar is engaged. /print/pages requests those images with nofill=1, so
    // without this pass an unrendered drawing would print as a placeholder —
    // and with it, the print page would have to spawn a nested sidecar session
    // while this one blocks on the image, which deadlocks two concurrent
    // exports (CONCURRENT=2) until the session timeout.
    const embedded = referencedDrawIds(page.doc);
    for (const drawId of embedded) {
      await getDrawSvgOrRender(user.id, drawId);
    }

    // The browser SIDECAR (not this process) fetches the print route, so the
    // URL must be reachable from that container: http://web:3000 in prod
    // (compose DNS), host.docker.internal in dev — never the public origin,
    // which would round-trip out through Caddy/Tailscale + TLS. Auth: a
    // server-MINTED short-lived session cookie (not the caller's raw Cookie
    // header, which is EMPTY for bearer-authed owners — web-client and mobile
    // callers would 307 at the print gate). We already hold the verified
    // owner here, so mint locally and the print route + its image
    // subresources authenticate regardless of the caller's transport.
    const cookie = buildInternalRenderCookie(user.id);
    try {
      const bytes = await renderUrlToPdf(`${printOrigin()}/print/pages/${id}`, cookie);
      return download(
        bytes,
        'application/pdf',
        `${slugify(page.title, { maxLength: 80, fallback: 'export' })}.pdf`,
      );
    } catch (e) {
      if (e instanceof PdfRendererUnavailableError) {
        console.error('[export] pdf renderer unavailable:', e.message);
        return NextResponse.json({ error: e.message }, { status: 503 });
      }
      throw e;
    }
  }

  // A draw's SVG comes straight out of the snapshot cache, so fill it first
  // for the same reason as the PDF path above. resolveExport lives in the
  // browser-free content package and can only read what is already stored.
  if (fmt.data === 'svg') await getDrawSvgOrRender(user.id, id);

  // md / docx / csv / xlsx go through the shared, browser-free resolver, which
  // picks what each node kind supports (pdf already handled above).
  const result = await resolveExport(user.id, id, {
    format: fmt.data,
    // Embed page images by reading their bytes from the file store.
    loadImage: async (fileId) => {
      const res = await readFileById({ ownerId: user.id, fileId });
      return res ? { bytes: res.bytes } : null;
    },
    // Word takes no SVG, so an embedded drawing goes in as a raster of its
    // committed snapshot (browser sidecar). Only the docx path asks for this,
    // and only for the drawings a document actually embeds.
    loadDraw: async (drawId) => await getDrawPngOrRender(user.id, drawId),
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
