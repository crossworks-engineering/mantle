import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { callerMayReadEmail } from '@/lib/api-v1';
import { listStateOf, pageWithPrivate } from '@/lib/admin-private-rows';
import { countNotes, createNote, isDigestTag, listNoteTags, listNotes } from '@/lib/notes';
import { recordIngest } from '@mantle/tracing';
import { firstIssue } from '@/lib/zod-issue';
import { chipped, parseWsFilter } from '@/lib/list-workspaces';
import { readJson } from '@/lib/read-body';

const PAGE_SIZE = 50;

const CreateBody = z.object({
  title: z.string().min(1).max(200),
  content: z.string().max(500_000).optional().default(''),
  tags: z.array(z.string().max(40)).max(20).optional().default([]),
});

/**
 * The /notes list — paginated + filtered, with tag facets, matching the old
 * server page. Agent digests are hidden unless `?digests=1` (or the tag is
 * itself a digest tag like `agent:assistant`). `?state=brain|private|all`
 * adds the caller's own private notes (lib/admin-private-rows; default brain).
 * Every row carries its `workspaces` and `hasLink` (lib/list-workspaces).
 * `?ws=<id>` keeps only the notes that workspace reads (no private rows:
 * they are in no workspace) and is echoed as `ws`.
 */
export async function GET(req: Request) {
  const user = ownerCaller();
  const sp = new URL(req.url).searchParams;
  const ws = await parseWsFilter(req, user.id, user.actor.id);
  if (ws instanceof Response) return ws;
  const inWs = ws ? { ws } : {};
  const asked = listStateOf(sp);
  // A private note is in no workspace: none when only those were asked for.
  const none = ws !== null && asked === 'private';
  const page = Math.max(1, Number.parseInt(sp.get('page') ?? '1', 10) || 1);
  const query = sp.get('q')?.trim() || undefined;
  const tag = sp.get('tag')?.trim() || undefined;
  const includeDigests = sp.get('digests') === '1' || (!!tag && isDigestTag(tag));
  // A key without Search does not list a note made from an email
  // attachment (access matrix T4).
  const withoutEmailCopies = !callerMayReadEmail();

  const [listed, tags] = await Promise.all([
    pageWithPrivate({
      user,
      kind: 'note',
      state: ws ? 'brain' : asked,
      q: query,
      tagged: !!tag,
      page,
      pageSize: PAGE_SIZE,
      brain: async (limit, offset) => {
        if (none) return { items: [], total: 0 };
        const [items, total] = await Promise.all([
          listNotes(user.id, {
            query,
            tag,
            includeDigests,
            limit,
            offset,
            withoutEmailCopies,
            ...inWs,
          }),
          countNotes(user.id, { query, tag, includeDigests, withoutEmailCopies, ...inWs }),
        ]);
        return { items, total };
      },
    }),
    listNoteTags(user.id, { includeDigests }),
  ]);
  return NextResponse.json({
    notes: await chipped(user.id, user.actor.id, listed.items),
    total: listed.total,
    page,
    pageSize: PAGE_SIZE,
    tags,
    ...inWs,
  });
}

export async function POST(req: Request) {
  const user = ownerCaller();
  const raw = await readJson(req);
  const parsed = CreateBody.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: firstIssue(parsed.error) }, { status: 400 });
  }
  const row = await createNote(user.id, parsed.data);
  void recordIngest({
    source: 'note_create',
    ownerId: user.id,
    nodeId: row.id,
    summary: `Note created: ${row.title.slice(0, 80)}`,
    payload: {
      title: row.title,
      tags: row.tags,
      contentChars: parsed.data.content?.length ?? 0,
      via: 'web_api',
    },
    snippet: parsed.data.content,
  });
  return NextResponse.json({ note: row }, { status: 201 });
}
