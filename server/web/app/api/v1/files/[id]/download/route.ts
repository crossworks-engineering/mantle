/**
 * Public API v1 (lib/api-v1.ts).
 *
 * GET /api/v1/files/:id/download : the file's bytes, with its type and a
 *     safe download name. The same handler as /api/files/files/:id?raw=1.
 */
import { GET as fileRoute } from '../../../../files/files/[id]/route';

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const url = new URL(req.url);
  url.search = '?raw=1';
  return fileRoute(new Request(url, { method: 'GET', headers: req.headers }), ctx);
}
