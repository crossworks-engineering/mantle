import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { assertEditable, getMineItem, saveMinePage } from '@mantle/content';
import { getClientOr401 } from '@/lib/auth';
import { readJsonNoNul } from '@/lib/strip-nul';
import {
  assertClientItem,
  clientDocTooLarge,
  clientWithAdminGuard,
  clientWriteGate,
  inMyClientSpace,
} from '@/lib/client-space';
import { conflict, notFound, SpaceIdParams, spaceStateResponse } from '@/lib/member-space';
import { firstIssue } from '@/lib/zod-issue';

/** A client's Save version body: a page's `doc` and the etag. The doc's
 *  size is the client's own (500 KB, `clientDocTooLarge`). */
const ClientSaveBody = z.object({
  doc: z.record(z.string(), z.unknown()).optional(),
  if_rev: z.number().int().nonnegative().optional(),
});

/**
 * POST /api/client/space/:id/save { doc, if_rev? } : "Save version" of a
 * CLIENT's page (client logins C5): publishes the working copy as the saved
 * version (what a reviewer reads once it is submitted) and clears the draft.
 * The embed rule reads at the client's level: a page may name only the
 * client's own items and client-level items (409 `embed` with the refused
 * `ids`). Never indexed. Notes and files save as they go (400); a submitted
 * item is frozen (409 `frozen`). A doc over 500 KB is a 400 `too-large`; a
 * version that takes the space past its storage is a 409 `quota`.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  const limited = clientWriteGate(client);
  if (limited) return limited;
  const params = SpaceIdParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const held = await clientWithAdminGuard(client, params.data.id);
  if (held) return held;
  const body = ClientSaveBody.safeParse(await readJsonNoNul(req));
  if (!body.success) return NextResponse.json({ error: firstIssue(body.error) }, { status: 400 });
  const big = clientDocTooLarge(body.data.doc);
  if (big) return big;
  const { spaceId } = client;
  const id = params.data.id;
  const { doc, if_rev: baseRev } = body.data;
  try {
    const res = await inMyClientSpace(client, async () => {
      await assertClientItem(spaceId, id);
      const row = await assertEditable(spaceId, id);
      if (row.type !== 'page' || !doc) return { kind: 'bad' as const };
      const saved = await saveMinePage(spaceId, id, doc, { baseRev });
      if (!saved.ok) return { kind: 'failed' as const, saved };
      return { kind: 'ok' as const, item: await getMineItem(spaceId, id) };
    });
    if (res.kind === 'bad') {
      return NextResponse.json(
        { error: 'Send `doc` for a page; notes and files save as they go.' },
        { status: 400 },
      );
    }
    if (res.kind === 'failed')
      return 'conflict' in res.saved ? conflict(res.saved.rev) : notFound();
    return res.item ? NextResponse.json(res.item) : notFound();
  } catch (err) {
    return spaceStateResponse(err);
  }
}
