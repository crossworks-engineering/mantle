import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOwner } from '@/lib/auth';
import { resolveExport } from '@mantle/content';
import { readFileById } from '@/lib/files';
import { safeDownloadHeaders } from '@/lib/safe-download';

const IdParams = z.object({ id: z.string().uuid() });

/**
 * Download a page/note as .docx or a table as .xlsx. The format is determined
 * by the node's type (page/note → Word, table → Excel), so the caller just
 * links to `/api/export/<id>`. Bytes are generated on the fly — nothing is
 * persisted (the agent `export_node` tool is the save-to-Files path).
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireOwner();
  const parsed = IdParams.safeParse(await ctx.params);
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid id' }, { status: 400 });
  }

  const result = await resolveExport(user.id, parsed.data.id, {
    // Embed page images by reading their bytes from the file store.
    loadImage: async (fileId) => {
      const res = await readFileById({ ownerId: user.id, fileId });
      return res ? { bytes: res.bytes } : null;
    },
  });
  if (!result) {
    return NextResponse.json({ error: 'not found or not exportable' }, { status: 404 });
  }

  return new Response(new Uint8Array(result.bytes), {
    status: 200,
    headers: {
      ...safeDownloadHeaders(result.mimeType, result.filename),
      'content-length': String(result.bytes.byteLength),
    },
  });
}
