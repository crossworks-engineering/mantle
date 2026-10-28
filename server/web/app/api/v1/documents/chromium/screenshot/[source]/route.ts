import { ownerCaller } from '@/lib/auth';
import { routePolicy } from '@/lib/auth/route-declaration';
import { handleDocumentsPost } from '@/lib/documents-route';

/** Public API v1: POST /api/v1/documents/chromium/screenshot/{html,markdown,url}, HTML, markdown or a page of this brain to a picture (docs/documents.md, the HTTP surface). */
export const policy = routePolicy({
  POST: {
    class: 'content',
    keyArea: 'files',
    item: {
      none: "makes a file where an export lands (saveExport, the caller's own files); the inputs it reads are named by id and read in the caller's scope",
    },
    limits: { rateLimit: ['documents'] },
  },
});

export async function POST(req: Request, ctx: { params: Promise<{ source: string }> }) {
  const owner = ownerCaller();
  return handleDocumentsPost(req, owner, ['chromium', 'screenshot', (await ctx.params).source]);
}
