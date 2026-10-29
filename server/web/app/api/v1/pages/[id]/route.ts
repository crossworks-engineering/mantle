/**
 * Public API v1 (lib/api-v1.ts): the same handlers as /api/pages/:id.
 *
 * PATCH holds two rules for an API key:
 *  - it may not set `visibility`. Making a page
 *    public is publishing, which a key on MCP may do only with `page_share`
 *    named as a risky tool; the HTTP API has no such list.
 *  - it may not change the `doc` of a page others can read:
 *    what the doc embeds would become readable to them with no confirm,
 *    and a key cannot confirm. MCP holds the same rule (register/context).
 *
 * For a key this wrapper asks the page's edit first, after the hidden email
 * page and before the two rules: assertItemRight answers a page the
 * key's login may not change as the page route answers that login (the 404
 * of one it does not read, the 403 item-workspace of one it reads but may
 * not change), an Admin user's key and a member's alike, so a rule that
 * reads the page (is it shared?) tells a key nothing about a page it may
 * not change. The page route's PATCH then reads its owner at the read
 * (ownerCallerAtRead).
 */
import { NextResponse } from '@/server/http-compat';
import { assertItemRight, resolveSingleOwnerId } from '@mantle/db';
import { editRefusalDetail } from '@mantle/std';
import { othersCanRead } from '@mantle/mcp-core/shared-item';
import { hiddenFromKey, isApiKeyRequest } from '@/lib/api-v1';
import { ownerCallerAtRead } from '@/lib/auth';
import { PATCH as patchPage } from '../../../pages/[id]/route';
import { routePolicy } from '@/lib/auth/route-declaration';

export const policy = routePolicy({
  GET: { class: 'content', keyArea: 'pages', aliasOf: 'GET /api/pages/:id' },
  PATCH: {
    class: 'content',
    caller: 'ownerAtRead',
    item: { param: 'id', need: 'edit' },
    keyArea: 'pages',
    base: 'PATCH /api/pages/:id',
  },
});

export { GET, routeParams } from '../../../pages/[id]/route';

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!isApiKeyRequest()) return patchPage(req, ctx);
  // A page made from an email attachment is not found for a key without
  // Search, before any other answer could tell it the page exists.
  const ownerId = await resolveSingleOwnerId();
  const { id } = await ctx.params;
  if (ownerId && (await hiddenFromKey(ownerId, [id])).size > 0) {
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  // The page's edit first: a page the key's login
  // may not change gets the edit check's answer (thrown, and answered by
  // the one mapper as the page route's), before the rules below read the
  // page, so a shared page and one that is not answer alike.
  await ownerCallerAtRead();
  try {
    await assertItemRight(id, 'edit');
  } catch (err) {
    // One it does not read: the 404 of none, as the page route answers it.
    if (editRefusalDetail(err) === 'no_read') {
      return NextResponse.json({ error: 'not found' }, { status: 404 });
    }
    throw err;
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
