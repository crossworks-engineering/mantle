/**
 * Public API v1 (lib/api-v1.ts).
 *
 * GET /api/v1/files/:id/download : the file's bytes, with its type and a
 *     safe download name. The same handler as /api/files/files/:id?raw=1.
 */
import { V1_DOWNLOAD_QUERY } from '@/lib/auth/route-policy';
import { GET as fileRoute } from '../../../../files/files/[id]/route';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: {
    class: 'content',
    keyArea: 'files',
    limits: { rateLimit: ['memberBytes'] },
    base: 'GET /api/files/files/:id',
  },
});

// route-callers: hand case. The bytes handler reads the asset reader the
// gate answered (readerAssetCaller); the code before its call only sets
// the query it is handed, which runs nothing and answers nothing. The gate
// answers the asset reader from the request as handed here, `?raw=1` and no
// `?at=`, read from the one constant (route-policy.ts V1_DOWNLOAD_QUERY,
// ASSET_QUERY_AS_HANDED), as the guard read it.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const url = new URL(req.url);
  url.search = V1_DOWNLOAD_QUERY;
  return fileRoute(new Request(url, { method: 'GET', headers: req.headers }), ctx);
}
