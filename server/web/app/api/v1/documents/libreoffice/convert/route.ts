import { anyLoginCaller } from '@/lib/auth';
import { routePolicy } from '@/lib/auth/route-declaration';
import { handleDocumentsPost } from '@/lib/documents-route';

/** Public API v1: POST /api/v1/documents/libreoffice/convert, Office files to PDF (docs/documents.md, the HTTP surface). */
export const policy = routePolicy({
  POST: {
    class: 'content',
    open: 'any',
    keyArea: 'files',
    item: {
      none: "makes a file where an export lands (saveExport, the caller's own files); the inputs it reads are named by id and read in the caller's scope",
    },
    limits: { rateLimit: ['documents'] },
  },
});

export async function POST(req: Request) {
  const login = anyLoginCaller();
  return handleDocumentsPost(req, login, 'libreoffice/convert');
}
