/**
 * /api/apps/[id]/format — pretty-print one mini-app source file with Prettier.
 * Stateless: it formats the posted `content` and returns the result; it does NOT
 * touch the app (the editor saves via PUT /draft). Server-side so the parser
 * plugins stay off the client bundle. Owner-gated like every app route.
 */
import { NextResponse } from '@/server/http-compat';
import { z } from 'zod';
import prettier from 'prettier';
import { ownerCaller } from '@/lib/auth';
import { MAX_APP_FILE_BYTES, MAX_APP_PATH_LEN } from '@mantle/content';
import { readJson } from '@/lib/read-body';
import { assertItemRight } from '@mantle/db';
import type { RouteParams } from '@/lib/route-params';
import { routePolicy } from '@/lib/auth/route-declaration';

/** The ids are uuids: any other names nothing, the params gateway's one
 *  404 before the handler (lib/route-params.ts; the item gate answered it
 *  until the pre-check removal part 2). */
export const routeParams = { id: 'uuid' } as const satisfies RouteParams;

export const policy = routePolicy({
  POST: {
    class: 'content',
    open: 'owner',
    item: { none: 'not decided yet: the write names an item no check reads' },
  },
});

// ext → Prettier parser. Mirrors what the editor highlights; anything else is
// refused (the button is hidden for those, but defend the endpoint too).
const PARSER: Record<string, string> = {
  tsx: 'typescript',
  ts: 'typescript',
  jsx: 'babel',
  js: 'babel',
  mjs: 'babel',
  cjs: 'babel',
  css: 'css',
  scss: 'scss',
  less: 'less',
  json: 'json',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  markdown: 'markdown',
};

const Body = z.object({
  path: z.string().min(1).max(MAX_APP_PATH_LEN),
  content: z.string().max(MAX_APP_FILE_BYTES),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  ownerCaller();
  const { id } = await ctx.params;
  // The caller's edit of the app (the pre-check removal part 2: the HTTP
  // gate asked it): this route formats the text it is sent and touches no
  // item, but answers only a login that may edit the app, as before.
  await assertItemRight(id, 'edit');
  const parsed = Body.safeParse(await readJson(req));
  if (!parsed.success) return NextResponse.json({ error: 'invalid input' }, { status: 400 });

  const ext = parsed.data.path.slice(parsed.data.path.lastIndexOf('.') + 1).toLowerCase();
  const parser = PARSER[ext];
  if (!parser) {
    return NextResponse.json({ error: `No formatter for .${ext} files.` }, { status: 400 });
  }

  try {
    const formatted = await prettier.format(parsed.data.content, {
      parser,
      printWidth: 100,
      singleQuote: true,
      semi: true,
    });
    return NextResponse.json({ ok: true, formatted });
  } catch (err) {
    // A syntax error means Prettier can't parse it — surface it so the user can fix.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Could not format this file.' },
      { status: 400 },
    );
  }
}
