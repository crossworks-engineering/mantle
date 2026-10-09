/**
 * Public API v1 (lib/api-v1.ts): the same handlers as /api/pages/:id.
 *
 * PATCH holds two rules for an API key:
 *  - it may not set `visibility` (M2 audit, suspected item 1). Making a page
 *    public is publishing, which a key on MCP may do only with `page_share`
 *    named as a risky tool; the HTTP API has no such list.
 *  - it may not change the `doc` of a page others can read (M2 audit N3):
 *    what the doc embeds would become readable to them with no confirm,
 *    and a key cannot confirm. MCP holds the same rule (register/context).
 */
import { NextResponse } from '@/server/http-compat';
import { resolveSingleOwnerId } from '@mantle/db';
import { othersCanRead } from '@mantle/mcp-core/shared-item';
import { hiddenFromKey, isApiKeyRequest } from '@/lib/api-v1';
import { PATCH as patchPage } from '../../../pages/[id]/route';

export { GET } from '../../../pages/[id]/route';

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isApiKeyRequest()) return patchPage(req, ctx);
  // A page made from an email attachment is not found for a key without
  // Search, before any other answer could tell it the page exists (audit C1).
  const ownerId = await resolveSingleOwnerId();
  const { id } = await ctx.params;
  if (ownerId && (await hiddenFromKey(ownerId, [id])).size > 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
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
  if (body && typeof body === 'object' && 'doc' in body) {
    if (ownerId && (await othersCanRead(ownerId, id))) {
      return NextResponse.json(
        {
          error: 'forbidden',
          reason: 'key-shared-item',
          message:
            'This page is shared, so an API key cannot change its content (what it embeds would become readable to others). Change it in the app.',
        },
        { status: 403 },
      );
    }
  }
  return patchPage(new Request(req.url, { method: 'PATCH', headers: req.headers, body: raw }), ctx);
}
