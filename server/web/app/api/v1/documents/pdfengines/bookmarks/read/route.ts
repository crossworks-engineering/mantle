import { anyLoginCaller } from '@/lib/auth';
import { routePolicy } from '@/lib/auth/route-declaration';
import { handleDocumentsPost } from '@/lib/documents-route';

/** Public API v1: POST /api/v1/documents/pdfengines/bookmarks/read, the bookmarks of PDFs as JSON (docs/documents.md, the HTTP surface). */
export const policy = routePolicy({
  POST: {
    class: 'content',
    open: 'any',
    keyArea: 'files',
    effect: {
      read: 'reads the metadata or bookmarks of the PDFs it names and answers JSON; nothing is written',
    },
    limits: { rateLimit: ['documents'] },
  },
});

export async function POST(req: Request) {
  const login = anyLoginCaller();
  return handleDocumentsPost(req, login, ['pdfengines', 'bookmarks', 'read']);
}
