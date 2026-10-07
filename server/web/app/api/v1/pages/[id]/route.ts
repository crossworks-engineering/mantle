/**
 * Public API v1 (lib/api-v1.ts): the same handlers as /api/pages/:id.
 *
 * PATCH holds one rule for an API key (M2 audit, suspected item 1): it may
 * not set `visibility`. Making a page public is publishing, which a key on
 * MCP may do only with `page_share` named as a risky tool; the HTTP API has
 * no such list, so the field is refused rather than passed through.
 */
import { NextResponse } from '@/server/http-compat';
import { isApiKeyRequest } from '@/lib/api-v1';
import { PATCH as patchPage } from '../../../pages/[id]/route';

export { GET } from '../../../pages/[id]/route';

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isApiKeyRequest()) return patchPage(req, ctx);
  const raw = await req.text();
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    // Not JSON: the page route answers it as it would.
  }
  if (body && typeof body === 'object' && 'visibility' in body) {
    return NextResponse.json(
      {
        error: 'forbidden',
        reason: 'key-publish',
        message: 'An API key cannot change who can see a page. Do it in the app.',
      },
      { status: 403 },
    );
  }
  return patchPage(new Request(req.url, { method: 'PATCH', headers: req.headers, body: raw }), ctx);
}
