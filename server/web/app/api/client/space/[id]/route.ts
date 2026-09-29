import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { deleteMineItem, getMineItem, updateMineItem } from '@mantle/content';
import { getClientOr401 } from '@/lib/auth';
import { readJsonNoNul } from '@/lib/strip-nul';
import {
  assertClientItem,
  clientWithAdminGuard,
  clientWriteGate,
  inMyClientSpace,
} from '@/lib/client-space';
import { notFound, SpaceIdParams, spaceStateResponse } from '@/lib/member-space';
import { firstIssue } from '@/lib/zod-issue';

const Patch = z
  .object({
    title: z.string().trim().max(200).optional(),
    icon: z.string().max(16).optional(),
    /** A note's text. Notes save as they go (no draft). */
    content: z.string().max(200_000).optional(),
  })
  .strict();

/**
 * GET /api/client/space/:id : one of the CLIENT's own items with its body,
 * the draft included (their working copy), plus its review state (client
 * logins C5). A file answers its metadata (the bytes are at
 * /api/client/space/:id/bytes). Only a page, note or file: any other kind,
 * and another login's item, is a 404.
 * PATCH { title?, icon?, content? } : rename, re-icon, or a note's text.
 * DELETE : remove it. A submitted item is frozen: PATCH and DELETE answer
 * 409 `frozen` until the client recalls it. An item a reviewer took over
 * answers 409 `with-admin`.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  const params = SpaceIdParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const held = await clientWithAdminGuard(client, params.data.id);
  if (held) return held;
  try {
    const got = await inMyClientSpace(client, async () => {
      await assertClientItem(client.spaceId, params.data.id);
      return getMineItem(client.spaceId, params.data.id);
    });
    return got ? NextResponse.json(got) : notFound();
  } catch (err) {
    return spaceStateResponse(err);
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  const limited = clientWriteGate(client);
  if (limited) return limited;
  const params = SpaceIdParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const held = await clientWithAdminGuard(client, params.data.id);
  if (held) return held;
  const body = Patch.safeParse(await readJsonNoNul(req));
  if (!body.success) return NextResponse.json({ error: firstIssue(body.error) }, { status: 400 });
  try {
    const got = await inMyClientSpace(client, async () => {
      await assertClientItem(client.spaceId, params.data.id);
      return updateMineItem(client.spaceId, params.data.id, body.data);
    });
    return got ? NextResponse.json(got) : notFound();
  } catch (err) {
    return spaceStateResponse(err);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  const limited = clientWriteGate(client);
  if (limited) return limited;
  const params = SpaceIdParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const held = await clientWithAdminGuard(client, params.data.id);
  if (held) return held;
  try {
    const ok = await inMyClientSpace(client, async () => {
      await assertClientItem(client.spaceId, params.data.id);
      return deleteMineItem(client.spaceId, params.data.id);
    });
    return ok ? NextResponse.json({ ok: true }) : notFound();
  } catch (err) {
    return spaceStateResponse(err);
  }
}
