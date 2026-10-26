import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import { ownerCaller } from '@/lib/auth';
import { commitPage, docToText } from '@/lib/pages';
import { recordIngest } from '@mantle/tracing';
import { readJson } from '@/lib/read-body';
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
    item: { param: 'id', need: 'edit' },
  },
});

const Body = z.object({
  doc: z.record(z.string(), z.unknown()),
  if_rev: z.number().int().nonnegative().optional(),
});

/**
 * Commit: publish the document and index it. This is the only moment a page
 * body reaches the brain (extractor → summary + embedding + facts), so it's
 * the natural place to open a content_ingest trace. `if_rev` is the draft etag
 * (same as the autosave route): a stale value returns 409 with the current
 * server rev and NOTHING is published.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = ownerCaller();
  const { id } = await ctx.params;
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid input' }, { status: 400 });
  }
  const result = await commitPage(user.id, id, parsed.data.doc, {
    ...(parsed.data.if_rev !== undefined ? { baseRev: parsed.data.if_rev } : {}),
  });
  if (!result.ok) {
    if ('conflict' in result) {
      return NextResponse.json(
        {
          error: 'draft changed since you loaded it — refetch and re-apply',
          current_rev: result.rev,
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }
  const page = result.page;

  const snippet = docToText(page.doc);
  void recordIngest({
    source: 'page_commit',
    ownerId: user.id,
    nodeId: page.id,
    summary: `Page committed: ${page.title.slice(0, 80)}`,
    payload: { title: page.title, tags: page.tags, textChars: snippet.length, via: 'web_api' },
    snippet,
  });
  return NextResponse.json({ page });
}
