import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { assertItemRight, db, nodes } from '@mantle/db';
import { ownerCaller } from '@/lib/auth';
import { getPage } from '@/lib/pages';
import { moveTreeItems, notifyTreeChanged } from '@mantle/content/tree';
import { readBody } from '@/lib/read-body';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The [id] is a uuid: any other names nothing, the one 404 before the
 *  handler (lib/route-params.ts). Since the pre-check removal part 2 the
 *  item gate no longer answers a bad id here (docs/actors.md). */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  POST: {
    class: 'content',
    open: 'owner',
    item: { none: 'not decided yet: the write names an item no check reads' },
  },
});

/**
 * POST /api/pages/:id/move — file a page in a folder of the pages tree
 * (folder phase 7; the same as `POST /api/tree/pages/move` for one item,
 * kept at this path for the page screens). `folderId` null is the top
 * level. A move that changes who can see the page (into or out of a shared
 * folder) answers 409 `visibility` with the list and writes nothing until
 * the call repeats with `confirm: true` (docs/folder-tree.md, "Confirm
 * first").
 *
 * DEPRECATED `parentId` (a page id): pages do not nest any more, so it means
 * "the same folder as that page"; null is the top level. A client from
 * before the tree still lands its page near where it meant to.
 */
const Body = z.object({
  folderId: z.string().uuid().nullable().optional(),
  parentId: z.string().uuid().nullable().optional(),
  confirm: z.boolean().optional(),
  seen: z.number().int().min(0).optional(),
});

/** The folder id of the page `pageId` sits in (null at the top level). */
async function folderOfPage(ownerId: string, pageId: string): Promise<string | null | undefined> {
  const rows = (await db.execute(sql`
    select b.id from nodes p
      left join nodes b on b.owner_id = p.owner_id and b.type = 'branch'
                        and b.path = p.path and nlevel(b.path) > 1
     where p.id = ${pageId} and p.owner_id = ${ownerId} and p.type = 'page'
     limit 1`)) as unknown as Array<{ id: string | null }>;
  if (!rows.length) return undefined;
  return rows[0]!.id ?? null;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const input = await readBody(req, Body);
  const body = input;
  if (body.folderId === undefined && body.parentId === undefined) {
    return NextResponse.json({ error: 'folderId required' }, { status: 400 });
  }
  const [page] = await db
    .select({ id: nodes.id })
    .from(nodes)
    .where(and(eq(nodes.id, id), eq(nodes.ownerId, user.id), eq(nodes.type, 'page')))
    .limit(1);
  if (!page) return NextResponse.json({ error: 'not found' }, { status: 404 });
  // A move manages the page: the caller's right first (pre-check removal
  // part 2), after the scoped read above (a page it does not read is the
  // 404 of none), then the database's move check. Asked in a scope only.
  await assertItemRight(id, 'manage');

  let folderId: string | null;
  if (body.folderId !== undefined) folderId = body.folderId;
  else if (body.parentId === null) folderId = null;
  else {
    if (body.parentId === id) {
      return NextResponse.json({ error: 'a page cannot be moved next to itself' }, { status: 400 });
    }
    const via = await folderOfPage(user.id, body.parentId!);
    if (via === undefined) {
      return NextResponse.json(
        { error: 'That destination page no longer exists.' },
        { status: 400 },
      );
    }
    folderId = via;
  }

  const result = await moveTreeItems(user.id, 'pages', [id], folderId, {
    confirm: body.confirm,
    seen: body.seen,
  });
  if (result.failed.length) {
    return NextResponse.json({ error: result.failed[0]!.error }, { status: 409 });
  }
  if (result.moved) await notifyTreeChanged(user.id, 'pages');
  const row = await getPage(user.id, id);
  return NextResponse.json({ page: row });
}
