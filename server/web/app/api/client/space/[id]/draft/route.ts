import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { assertEditable, saveMineDraft } from '@mantle/content';
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

/** A client's autosave body: a page's `doc` and the etag (no drawings, no
 *  tables; other fields are dropped). The doc's size is the client's own
 *  (500 KB, `clientDocTooLarge`), never the member's 2 MB. */
const ClientDraftBody = z.object({
  doc: z.record(z.string(), z.unknown()).optional(),
  if_rev: z.number().int().nonnegative().optional(),
});

/**
 * PUT /api/client/space/:id/draft { doc, if_rev? } : autosave the CLIENT's
 * working copy of a page (client logins C5). The member draft contract:
 * `if_rev` is the draft etag, success answers `{ ok, draft_rev }`, a stale
 * etag 409 with `current_rev`. Nothing is published or indexed. Notes and
 * files have no draft (400); a submitted item is frozen (409 `frozen`). A
 * doc over 500 KB is a 400 `too-large`; a draft that takes the space (or
 * all client spaces) past its storage is a 409 `quota`.
 */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  const limited = clientWriteGate(client);
  if (limited) return limited;
  const params = SpaceIdParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const held = await clientWithAdminGuard(client, params.data.id);
  if (held) return held;
  const body = ClientDraftBody.safeParse(await readJsonNoNul(req));
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
      return row.type === 'page' && doc ? saveMineDraft(spaceId, id, doc, { baseRev }) : null;
    });
    if (!res) {
      return NextResponse.json(
        { error: 'Send `doc` for a page; notes and files have no draft.' },
        { status: 400 },
      );
    }
    if (res.ok) return NextResponse.json({ ok: true, draft_rev: res.rev });
    return 'conflict' in res ? conflict(res.rev) : notFound();
  } catch (err) {
    return spaceStateResponse(err);
  }
}
