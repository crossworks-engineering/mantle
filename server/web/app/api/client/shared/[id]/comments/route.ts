import { NextResponse } from '@/server/http-compat';
import { withHumanViewer } from '@mantle/db';
import { addClientThreadComment, listClientThread, toNodeCommentDto } from '@mantle/content';
import type { ClientCommentThread } from '@mantle/client-types';
import { getClientOr401 } from '@/lib/auth';
import { readJsonNoNul } from '@/lib/strip-nul';
import {
  ThreadCommentBody,
  ThreadParams,
  clientThreadAuthor,
  clientThreadWriteGate,
} from '@/lib/client-thread';
import { firstIssue } from '@/lib/zod-issue';

const notFound = () => NextResponse.json({ error: 'Not found.' }, { status: 404 });

/**
 * GET /api/client/shared/:id/comments : the thread on an item shared with
 * clients (client logins C5, decision 8), oldest first; every comment shows
 * its author's display name. POST { body } -> 201 { comment }: add to it.
 * Read on the client role with the human flag on (row security shows the
 * client thread of a client-level item and nothing else); written on the
 * admin pool with the item's level checked in the same statement. Any item
 * not at client level is a plain 404. Writes are rate limited per login.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  const params = ThreadParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const rows = await withHumanViewer('client', () =>
    listClientThread(client.anchorId, params.data.id),
  );
  if (!rows) return notFound();
  const viewer = { loginId: client.loginId };
  const body: ClientCommentThread = { comments: rows.map((r) => toNodeCommentDto(r, viewer)) };
  return NextResponse.json(body);
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const client = await getClientOr401();
  if (client instanceof Response) return client;
  const limited = clientThreadWriteGate(client);
  if (limited) return limited;
  const params = ThreadParams.safeParse(await ctx.params);
  if (!params.success) return NextResponse.json({ error: 'Invalid id.' }, { status: 400 });
  const body = ThreadCommentBody.safeParse(await readJsonNoNul(req));
  if (!body.success) return NextResponse.json({ error: firstIssue(body.error) }, { status: 400 });
  const row = await addClientThreadComment(
    client.anchorId,
    params.data.id,
    clientThreadAuthor(client),
    body.data.body,
  );
  if (!row) return notFound();
  return NextResponse.json(
    { comment: toNodeCommentDto(row, { loginId: client.loginId }) },
    { status: 201 },
  );
}
