import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { getClientAcceptedItem } from '@mantle/content';
import { getClientOr401 } from '@/lib/auth';

const Params = z.object({ id: z.string().uuid() });

/**
 * GET /api/client/accepted/:id -> { item } : an item this CLIENT wrote and
 * an admin accepted, the version ACCEPTED (the snapshot taken at Accept,
 * never the brain's current version), whatever its level, and without it
 * (client logins C5). A page, note or file; a file's bytes come from
 * /api/client/files/:id while the brain file holds the bytes accepted
 * (`changedByAdmin` otherwise). Anyone else's item, one not accepted, or one
 * that left this brain is a plain 404.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  const params = Params.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const item = await getClientAcceptedItem(client.anchorId, client.loginId, params.data.id);
  if (!item) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  return NextResponse.json({ item });
}
