import { NextResponse } from '@/server/http-compat';
import { assertEditable, saveDraft } from '@mantle/content';
import { getClientOr401 } from '@/lib/auth';
import { readJsonNoNul } from '@/lib/strip-nul';
import {
  assertClientItem,
  clientWithAdminGuard,
  clientWriteGate,
  inMyClientSpace,
} from '@/lib/client-space';
import {
  conflict,
  DraftBody,
  notFound,
  SpaceIdParams,
  spaceStateResponse,
} from '@/lib/member-space';
import { firstIssue } from '@/lib/zod-issue';

/** A client's autosave body: a page's `doc` and the etag (no drawings, no
 *  tables; other fields are dropped). */
const ClientDraftBody = DraftBody.pick({ doc: true, if_rev: true });

/**
 * PUT /api/client/space/:id/draft { doc, if_rev? } : autosave the CLIENT's
 * working copy of a page (client logins C5). The member draft contract:
 * `if_rev` is the draft etag, success answers `{ ok, draft_rev }`, a stale
 * etag 409 with `current_rev`. Nothing is published or indexed. Notes and
 * files have no draft (400); a submitted item is frozen (409 `frozen`).
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
  const { spaceId } = client;
  const id = params.data.id;
  const { doc, if_rev: baseRev } = body.data;
  try {
    const res = await inMyClientSpace(client, async () => {
      await assertClientItem(spaceId, id);
      const row = await assertEditable(spaceId, id);
      return row.type === 'page' && doc ? saveDraft(spaceId, id, doc, { baseRev }) : null;
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
